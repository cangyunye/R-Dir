//! 伴生进程服务循环：stdin 逐行收 [`Op`]/[`Cancel`]，stdout 逐行回 [`Frame`]。
//! 每个操作一个 tokio 任务（列目录与传输可并发）；会话池归进程所有、跨操作复用
//! （修复 v0.39 内嵌实现的池克隆丢失问题——见 client 自由函数签名 &mut SessionPool）。
//! 泛型读写以便内存 duplex 单测；bin 入口接 tokio stdin/stdout。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use crate::client::{self, pool::SessionPool, XferEvent};
use crate::protocol::{Cancel, CancelOp, Frame, Op, PingInfo, PROTOCOL_VERSION};

const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

type LineTx = mpsc::UnboundedSender<Frame>;

/// 泛型服务循环。stdin EOF（host 退出）→ 取消在途操作、宽限收尾后返回。
pub async fn serve<R, W>(input: R, output: W) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(input).lines();
    let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();
    // 写出任务：所有帧（终态 + 进度事件）经单通道串行化写 stdout，避免交错
    let writer = tokio::spawn(async move {
        let mut out = output;
        while let Some(frame) = rx.recv().await {
            let Ok(mut line) = serde_json::to_string(&frame) else { continue };
            line.push('\n');
            if out.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = out.flush().await;
        }
    });

    let pool: Arc<Mutex<SessionPool>> = Arc::new(Mutex::new(SessionPool::default()));
    // op id → 取消旗标（cancel 请求按 id 定位；op 结束时移除）
    let flags: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(c) = serde_json::from_str::<Cancel>(&line) {
            if matches!(c.op, CancelOp::Cancel) {
                if let Some(f) = flags.lock().await.get(&c.id) {
                    f.store(true, Ordering::Relaxed);
                }
            }
            continue;
        }
        // 请求行：{"id":7,"op":"list_dir","args":{...}}（id 与 tagged Op 分两次解析，各自忽略未知字段）
        let req = (|| -> Result<(u64, Op), String> {
            let id = serde_json::from_str::<ReqId>(&line).map_err(|e| e.to_string())?.id;
            let op = serde_json::from_str::<Op>(&line).map_err(|e| e.to_string())?;
            Ok((id, op))
        })();
        let (id, op) = match req {
            Ok(pair) => pair,
            Err(e) => {
                let _ = tx.send(Frame::Log {
                    level: "warn".into(),
                    message: format!("无法解析请求行：{e}"),
                });
                continue;
            }
        };
        let flag = Arc::new(AtomicBool::new(false));
        flags.lock().await.insert(id, flag.clone());
        tasks.push(tokio::spawn(run_op(
            id,
            op,
            flag,
            tx.clone(),
            pool.clone(),
            flags.clone(),
        )));
    }

    // stdin EOF：宽限 5s 让在途操作走取消清理路径，超时强杀
    {
        let map = flags.lock().await;
        for f in map.values() {
            f.store(true, Ordering::Relaxed);
        }
    }
    let drain = async {
        for t in tasks {
            let _ = t.await;
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(5), drain).await.is_err() {
        eprintln!("rdir-nfs：退出宽限期超时，放弃等待在途操作");
    }
    drop(tx);
    let _ = writer.await;
    Ok(())
}

#[derive(serde::Deserialize)]
struct ReqId {
    id: u64,
}

async fn run_op(
    id: u64,
    op: Op,
    flag: Arc<AtomicBool>,
    tx: LineTx,
    pool: Arc<Mutex<SessionPool>>,
    flags: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>>,
) {
    // 进度事件 → Ev 帧；host 侧 cb 返回 false = 取消（此处经 flag 置位表达，
    // 客户端回调在下一事件/字节边界返回 false 终止传输）
    let ev_tx = tx.clone();
    let ev_flag = flag.clone();
    let mut ev_cb = move |ev: XferEvent| -> bool {
        if ev_flag.load(Ordering::Relaxed) {
            return false;
        }
        ev_tx.send(Frame::Ev { id, event: ev }).is_ok()
    };
    let mut guard = pool.lock().await;
    let result = dispatch(op, &mut guard, &flag, &mut ev_cb).await;
    flags.lock().await.remove(&id);
    let frame = match result {
        Ok(v) => Frame::Ok { id, value: v },
        Err(e) => Frame::Err { id, error: e },
    };
    let _ = tx.send(frame);
}

async fn dispatch(
    op: Op,
    pool: &mut SessionPool,
    flag: &AtomicBool,
    cb: &mut (dyn FnMut(XferEvent) -> bool + Send),
) -> Result<serde_json::Value, String> {
    Ok(match op {
        Op::Ping => {
            let info = PingInfo {
                plugin_version: PLUGIN_VERSION.into(),
                protocol_version: PROTOCOL_VERSION,
            };
            serde_json::to_value(info).map_err(|e| e.to_string())?
        }
        Op::ListDir { path } => {
            serde_json::to_value(client::list_dir(pool, &path).await?).map_err(|e| e.to_string())?
        }
        Op::StatPath { path } => serde_json::Value::String(client::stat_path(pool, &path).await?),
        Op::Download { path, temp_dir } => {
            let local = client::download(pool, &path, std::path::Path::new(&temp_dir), |done, total| {
                cb(XferEvent::Bytes { done, total });
            })
            .await?;
            serde_json::Value::String(local)
        }
        Op::DownloadPlan { path } => {
            let plan = client::download_plan(pool, &path, flag).await?;
            serde_json::to_value(plan).map_err(|e| e.to_string())?
        }
        Op::DownloadTo { local_dir, path, overwrite } => {
            let local = client::download_to(pool, &local_dir, &path, overwrite, cb).await?;
            serde_json::Value::String(local)
        }
        Op::UploadPath { local, remote_dir, name } => {
            let url = client::upload_path(pool, &local, &remote_dir, &name, cb).await?;
            serde_json::Value::String(url)
        }
        Op::Mkdir { remote_dir, name } => {
            serde_json::Value::String(client::mkdir(pool, &remote_dir, &name).await?)
        }
        Op::CreateFile { remote_dir, name } => {
            serde_json::Value::String(client::create_file(pool, &remote_dir, &name).await?)
        }
        Op::DeleteEntries { paths } => {
            client::delete_entries(pool, &paths).await?;
            serde_json::Value::Null
        }
        Op::RenameEntry { old_path, new_name } => {
            serde_json::Value::String(client::rename_entry(pool, &old_path, &new_name).await?)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::XferEvent as ProtoXferEvent;

    /// host 侧请求行结构（nfs_backend 的 ReqLine 同构；此处验证线形状契约）
    #[derive(serde::Serialize)]
    struct ReqLine<'a> {
        id: u64,
        #[serde(flatten)]
        op: &'a Op,
    }

    /// Op 序列化形状：tag/content + 独立 id 拍平（与 host 的 ReqLine 对齐）
    #[test]
    fn op_wire_shape() {
        let line = serde_json::to_string(&ReqLine {
            id: 7,
            op: &Op::ListDir { path: "nfs://h/a".into() },
        })
        .unwrap();
        assert_eq!(line, r#"{"id":7,"op":"list_dir","args":{"path":"nfs://h/a"}}"#);
        // 反序列化（server 侧两段解析：id 与 Op 各自忽略未知字段）
        let id = serde_json::from_str::<ReqId>(&line).unwrap().id;
        let op = serde_json::from_str::<Op>(&line).unwrap();
        assert_eq!(id, 7);
        assert!(matches!(op, Op::ListDir { path } if path == "nfs://h/a"));
    }

    #[test]
    fn frame_roundtrip() {
        let frames = vec![
            Frame::Ok { id: 1, value: serde_json::json!([{"name":"a","isDir":true}]) },
            Frame::Err { id: 2, error: "CANCELLED".into() },
            Frame::Ev { id: 3, event: ProtoXferEvent::Bytes { done: 1, total: 2 } },
            Frame::Ev { id: 4, event: ProtoXferEvent::Start { label: "子/文件.txt".into() } },
            Frame::Log { level: "warn".into(), message: "x".into() },
        ];
        for f in frames {
            let line = serde_json::to_string(&f).unwrap();
            let back: Frame = serde_json::from_str(&line).unwrap();
            let line2 = serde_json::to_string(&back).unwrap();
            assert_eq!(line, line2, "帧序列化应稳定：{line}");
        }
        assert!(serde_json::to_string(&Frame::Ok { id: 1, value: serde_json::json!(null) }).unwrap().contains(r#""frame":"ok""#));
    }

    #[test]
    fn cancel_wire_shape() {
        let line = serde_json::to_string(&Cancel { op: CancelOp::Cancel, id: 9 }).unwrap();
        assert_eq!(line, r#"{"op":"cancel","id":9}"#);
    }

    /// 真·回环：双 duplex 打通 client ↔ serve(client_io, server_out)
    #[tokio::test]
    async fn serve_loopback_end_to_end() {
        let (c2s, s_in) = tokio::io::duplex(64 * 1024);
        let (s_out, c_from) = tokio::io::duplex(64 * 1024);
        let handle = tokio::spawn(async move { serve(s_in, s_out).await });

        let mut w = c2s;
        let mut r = BufReader::new(c_from).lines();
        use tokio::io::AsyncWriteExt;

        // 1) ping
        w.write_all(br#"{"id":1,"op":"ping"}"#).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        let line = r.next_line().await.unwrap().unwrap();
        let frame: Frame = serde_json::from_str(&line).unwrap();
        match frame {
            Frame::Ok { id, value } => {
                assert_eq!(id, 1);
                let info: crate::protocol::PingInfo = serde_json::from_value(value).unwrap();
                assert_eq!(info.protocol_version, PROTOCOL_VERSION);
                assert!(!info.plugin_version.is_empty());
            }
            other => panic!("ping 应返回 ok：{other:?}"),
        }

        // 2) 非法行 → Log 帧（不终止服务）
        w.write_all(b"not-json\n").await.unwrap();
        let line = r.next_line().await.unwrap().unwrap();
        match serde_json::from_str::<Frame>(&line).unwrap() {
            Frame::Log { .. } => {}
            other => panic!("非法行应回 log 帧：{other:?}"),
        }

        // 3) cancel 帧对未知 id 静默忽略（无输出）；随后 ping 仍可用
        w.write_all(br#"{"op":"cancel","id":42}"#).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(br#"{"id":2,"op":"ping"}"#).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        let mut saw_ok = false;
        for _ in 0..3 {
            let line = r.next_line().await.unwrap().unwrap();
            match serde_json::from_str::<Frame>(&line).unwrap() {
                Frame::Ok { id, .. } if id == 2 => {
                    saw_ok = true;
                    break;
                }
                _ => continue,
            }
        }
        assert!(saw_ok, "cancel 后服务应继续响应");

        // 4) 关 stdin（模拟 host 退出）→ serve 收尾返回
        drop(w);
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), handle)
            .await
            .expect("serve 应在 stdin EOF 后退出")
            .unwrap();
        assert!(result.is_ok());
    }
}
