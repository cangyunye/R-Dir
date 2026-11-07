//! 事件出口抽象（EventSink）：把「事件发往哪里」从 Tauri 运行时解耦。
//!
//! 背景：fs_watch / volumes / progress 等模块此前直接持有 `AppHandle` 调
//! `app.emit(...)`，事件通道与 Tauri 硬耦合——web 模式（规划中的 rdir-web）
//! 没有窗口运行时，事件需经 WebSocket 广播推送。收敛后模块函数只依赖
//! [`EventSink`]（廉价克隆的 Arc 出口句柄）：
//!
//! - 桌面：[`TauriEmitter`] 包 AppHandle，走 tauri emit → webview；
//! - web：`rdir-web` 以 `broadcast::Sender` 实现同一 trait，帧格式与前端
//!   `src/lib/ipc.ts` 的 WS 分支对齐（`{event, payload}`，与 tauri emit 同构）；
//! - 单测：注入收集型 mock（见本模块测试）即可断言事件发射行为。
//!
//! trait 方法收 `serde_json::Value`（对象安全，dyn 可分发）；[`EventSink::emit`]
//! 提供泛型序列化便利层，序列化失败静默丢弃（载荷均为本 crate 定义的可序列化
//! 结构，实际不会发生）。app-exit-requested 等窗口生命周期事件不走本抽象
//! （属纯桌面概念，仍直接 emit）。

use serde::Serialize;
use std::sync::Arc;

/// 事件发射器（对象安全）。event 名与桌面版既有事件保持一致：
/// `fs://changed` / `volumes://changed` / `share://changed` /
/// `transfer-progress` / `size-progress` / `diff-progress`。
pub trait Emitter: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

/// Tauri 实现：泛型 Runtime 对齐 progress::emit 既有形态（AppHandle 本就廉价克隆）
pub struct TauriEmitter<R: tauri::Runtime>(tauri::AppHandle<R>);

impl<R: tauri::Runtime> Emitter for TauriEmitter<R> {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter as _;
        let _ = self.0.emit(event, payload);
    }
}

/// 可克隆的事件出口：模块函数以此替代 AppHandle 依赖（事件是唯一耦合点）。
/// 克隆仅 Arc 引用计数 +1，可随意跨线程/进入移动闭包。
#[derive(Clone)]
pub struct EventSink(Arc<dyn Emitter>);

impl EventSink {
    /// 注入自定义发射器（测试 mock / 未来 web 广播实现）
    pub fn new(inner: Arc<dyn Emitter>) -> Self {
        Self(inner)
    }

    /// 发射事件；payload 与桌面版 tauri emit 的序列化结果逐字节同构
    /// （如 `()` → null、结构体按其 serde 属性输出），前端 handler 无感切换
    pub fn emit<S: Serialize>(&self, event: &str, payload: &S) {
        if let Ok(v) = serde_json::to_value(payload) {
            self.0.emit_json(event, v);
        }
    }
}

impl<R: tauri::Runtime> From<&tauri::AppHandle<R>> for EventSink {
    fn from(app: &tauri::AppHandle<R>) -> Self {
        Self::new(Arc::new(TauriEmitter(app.clone())))
    }
}

impl<R: tauri::Runtime> From<tauri::AppHandle<R>> for EventSink {
    fn from(app: tauri::AppHandle<R>) -> Self {
        Self::new(Arc::new(TauriEmitter(app)))
    }
}

/// web 实现（rdir-web bin）：事件帧序列化进 broadcast 通道，WS /api/events
/// 每个订阅者持一个 Receiver 逐帧下发。帧即序列化后的 JSON
/// `{"event": ..., "payload": ...}`——与前端 ipc.ts WS 分支的解析格式对齐。
#[cfg(feature = "web")]
pub struct WebEmitter(tokio::sync::broadcast::Sender<serde_json::Value>);

#[cfg(feature = "web")]
impl WebEmitter {
    /// 建通道（容量 = 在途帧缓冲；Lagged 漏帧由前端刷新逻辑自愈，取 256 平衡内存）。
    /// 初始无订阅者，send 失败静默——首个 WS 连接 subscribe 后开始收帧。
    pub fn new() -> Self {
        let (tx, _rx) = tokio::sync::broadcast::channel(256);
        Self(tx)
    }

    /// 新订阅（每个 WS 连接一个 Receiver）
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<serde_json::Value> {
        self.0.subscribe()
    }
}

#[cfg(feature = "web")]
impl Emitter for WebEmitter {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.send(serde_json::json!({ "event": event, "payload": payload }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 收集型 mock：记录 (event, payload) 序列
    #[derive(Default)]
    struct CollectEmitter(Mutex<Vec<(String, serde_json::Value)>>);

    impl Emitter for CollectEmitter {
        fn emit_json(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((event.into(), payload));
        }
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FakeProgress {
        done_files: usize,
        total_files: usize,
    }

    #[test]
    fn emit_serializes_payload_like_tauri() {
        let collector = Arc::new(CollectEmitter::default());
        let sink = EventSink::new(Arc::clone(&collector) as Arc<dyn Emitter>);

        // 结构体载荷：serde 属性生效（camelCase）
        sink.emit(
            "transfer-progress",
            &FakeProgress {
                done_files: 2,
                total_files: 5,
            },
        );
        // 单元载荷：null（share://changed 形态）
        sink.emit("share://changed", &());

        let got = collector.0.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "transfer-progress");
        assert_eq!(
            got[0].1,
            serde_json::json!({"doneFiles": 2, "totalFiles": 5})
        );
        assert_eq!(got[1].0, "share://changed");
        assert_eq!(got[1].1, serde_json::Value::Null);
    }

    #[test]
    fn sink_is_clone_and_shares_collector() {
        let collector = Arc::new(CollectEmitter::default());
        let sink = EventSink::new(Arc::clone(&collector) as Arc<dyn Emitter>);
        let sink2 = sink.clone();
        sink.emit("fs://changed", &vec!["/a".to_string()]);
        sink2.emit("volumes://changed", &Vec::<String>::new());
        let got = collector.0.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].1, serde_json::json!(["/a"]));
        assert_eq!(got[1].1, serde_json::json!([]));
    }

    #[test]
    fn event_ordering_is_preserved() {
        let collector = Arc::new(CollectEmitter::default());
        let sink = EventSink::new(Arc::clone(&collector) as Arc<dyn Emitter>);
        for i in 0..3u32 {
            sink.emit("size-progress", &serde_json::json!({ "n": i }));
        }
        let got = collector.0.lock().unwrap();
        let seq: Vec<u64> = got
            .iter()
            .map(|(_, v)| v.get("n").unwrap().as_u64().unwrap())
            .collect();
        assert_eq!(seq, vec![0, 1, 2]);
    }
}
