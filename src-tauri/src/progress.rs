//! 传输/复制进度事件（前端进度条）
//! 统一通过 Tauri 事件 "transfer-progress" 推送。

use serde::Serialize;
use std::time::{Duration, Instant};

/// 进度载荷（camelCase 输出）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    /// "copy" | "move" | "upload" | "download"
    pub phase: String,
    /// 正在处理的文件名（展示用）
    pub label: String,
    /// 已完成文件数 / 总文件数
    pub done_files: usize,
    pub total_files: usize,
    /// 当前文件已复制字节 / 总字节
    pub file_done: u64,
    pub file_total: u64,
    /// 全部完成
    pub done: bool,
    /// 可选任务标识（http 下载 = url，用于取消命令定位）
    pub id: Option<String>,
}

impl TransferProgress {
    pub fn start(phase: &str, label: &str, total_files: usize) -> Self {
        Self {
            phase: phase.into(),
            label: label.into(),
            done_files: 0,
            total_files,
            file_done: 0,
            file_total: 0,
            done: false,
            id: None,
        }
    }
}

/// 向所有前端窗口推送进度（同步命令与异步命令均可调用；泛型 Runtime 便于单测 mock）
pub fn emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, p: &TransferProgress) {
    use tauri::Emitter;
    let _ = app.emit("transfer-progress", p);
}

/// 进度发射节流器：本地复制 1MB/帧、SFTP/HTTP 64KB/帧，千兆级传输会产生上万次
/// 事件，而前端每次收到事件都整树重渲染；中间帧按时间限频即可。
/// 首帧与收尾帧不受节流（调用方在 Start 时 reset，完成帧直接发送）。
pub struct Throttle {
    interval: Duration,
    last: Option<Instant>,
}

impl Throttle {
    pub fn new() -> Self {
        Self {
            interval: Duration::from_millis(100),
            last: None,
        }
    }

    /// 距上次放行是否已满间隔；放行时记录本次时刻。
    pub fn ready(&mut self) -> bool {
        let ok = match self.last {
            None => true,
            Some(t) => t.elapsed() >= self.interval,
        };
        if ok {
            self.last = Some(Instant::now());
        }
        ok
    }

    /// 新文件/新阶段开始时重置，让下一帧立即发出。
    pub fn reset(&mut self) {
        self.last = None;
    }
}
