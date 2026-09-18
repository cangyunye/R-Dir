//! v0.7 窗口分享（内置插件，feature = "share" 可编译期拔出）。
//!
//! P1：Web 只读分享——内嵌 axum 服务，token 即凭证，
//! 只读目录浏览 + Range 断点续传下载 + 连接数上限 + 有效期 + 访问者日志。
//! P2（后续）：R-Dir 原生会话（WS 控制通道 + 写/删/新建）。

pub mod http;
pub mod session;

use crate::share::session::{ShareManager, SharePerm, ShareRoot, ShareSession, ShareSessionView};
use serde::Serialize;
use tauri::Emitter;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 全局分享管理器（tauri state 持有；axum 以 Arc 共享）
pub struct ShareState {
    pub manager: Arc<ShareManager>,
}

impl Default for ShareState {
    fn default() -> Self {
        ShareState {
            manager: Arc::new(ShareManager::default()),
        }
    }
}

/// 创建分享响应
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCreateResult {
    pub id: String,
    pub token: String,
    pub port: u16,
    pub url: String,
    pub expires_at: Option<u64>,
}

/// 局域网地址探测（返回第一个非回环 IPv4；失败则回环）
fn lan_ip() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

/// 创建只读分享（P1）。dir 为分享根；allow_parent 是否允许接收方上溯；
/// expires_hours: Some(h) 到期自动停，None 永久（直到主动停止/关闭客户端）。
#[tauri::command]
pub async fn share_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, ShareState>,
    plugins: tauri::State<'_, crate::AppState>,
    dir: String,
    allow_parent: bool,
    max_conns: u32,
    expires_hours: Option<u32>,
) -> Result<ShareCreateResult, String> {
    if !crate::plugins::plugin_enabled(&plugins.plugins, "share") {
        return Err("分享插件已禁用（设置 → 插件中可重新启用）".into());
    }
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("分享目录不存在或不是文件夹".into());
    }
    let mgr = Arc::clone(&state.manager);
    let token = mgr.gen_token();
    let id = format!("sh{:016x}", SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64);
    let expires_at = expires_hours.map(|h| {
        SystemTime::now() + Duration::from_secs(h as u64 * 3600)
    });
    // 先建会话骨架（server_task 占位，serve 后填充）
    let mut sess = ShareSession {
        id: id.clone(),
        token: token.clone(),
        roots: vec![ShareRoot {
            id: "root".into(),
            path: root.clone(),
        }],
        perm: SharePerm::Read,
        allow_parent,
        max_conns: max_conns as usize,
        expires_at,
        created_at: SystemTime::now(),
        port: 0,
        server_task: None, // 占位，serve 后填充
        conns: std::sync::Mutex::new(Vec::new()),
    };
    let (port, handle) = http::serve(Arc::clone(&mgr), &sess).await?;
    sess.port = port;
    sess.server_task = Some(handle);
    mgr.sessions.lock().unwrap().insert(id.clone(), sess);

    // 到期自动停止
    if let Some(exp) = expires_at {
        let mgr2 = Arc::clone(&mgr);
        let id2 = id.clone();
        let app2 = app.clone();
        let dur = exp.duration_since(SystemTime::now()).unwrap_or_default();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(dur).await;
            mgr2.stop(&id2);
            let _ = app2.emit("share://changed", ());
        });
    }
    // 通知前端刷新
    let _ = app.emit("share://changed", ());

    let url = format!("http://{}:{}/{}", lan_ip(), port, token);
    Ok(ShareCreateResult {
        id,
        token,
        port,
        url,
        expires_at: expires_at.map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()),
    })
}


/// 会话列表（含访问者日志）
#[tauri::command]
pub fn share_list(state: tauri::State<'_, ShareState>) -> Vec<ShareSessionView> {
    let sessions = state.manager.sessions.lock().unwrap();
    let mut v: Vec<ShareSessionView> = sessions
        .iter()
        .map(|(id, s)| {
            let root = s.roots.first().map(|r| r.path.display().to_string()).unwrap_or_default();
            let conns = s.conns.lock().unwrap().clone();
            ShareSessionView {
                id: id.clone(),
                token: s.token.clone(),
                dir: root,
                perm: s.perm.as_str().into(),
                allow_parent: s.allow_parent,
                max_conns: s.max_conns,
                port: s.port,
                url: format!("http://{}:{}/{}", lan_ip(), s.port, s.token),
                expires_at: s
                    .expires_at
                    .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()),
                conns,
            }
        })
        .collect();
    v.sort_by_key(|s| s.port);
    v
}

/// 停止分享
#[tauri::command]
pub fn share_stop(app: tauri::AppHandle, state: tauri::State<'_, ShareState>, id: String) -> Result<(), String> {
    let ok = state.manager.stop(&id);
    let _ = app.emit("share://changed", ());
    if ok {
        Ok(())
    } else {
        Err("分享不存在或已停止".into())
    }
}

/// 关闭窗口/标签时按根目录停止分享
#[tauri::command]
pub fn share_stop_by_dir(app: tauri::AppHandle, state: tauri::State<'_, ShareState>, dir: String) -> usize {
    let n = state.manager.stop_by_root(std::path::Path::new(&dir));
    if n > 0 {
        let _ = app.emit("share://changed", ());
    }
    n
}

/// 清理所有分享（客户端退出前调用）
pub fn shutdown_all(mgr: &ShareManager) {
    let ids: Vec<String> = mgr
        .sessions
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for id in ids {
        mgr.stop(&id);
    }
}
