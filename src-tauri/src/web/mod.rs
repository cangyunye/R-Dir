//! rdir-web 服务本体（web feature 独占）：单端口 axum 路由。
//!
//! 路由：
//! - `POST /api/invoke`  命令透传（web/bridge.rs 分发表）→ `{ok, data|error}`
//! - `GET  /api/events`  WebSocket 事件通道，帧 = `{"event","payload"}`（与桌面
//!   tauri emit 同构；ipc.ts WS 分支按此解析）
//! - `GET  /api/file`    服务端文件流（双击打开 / 远程打开临时副本；Range 断点续传）
//! - `GET  /login?k=...` 令牌换 cookie（HttpOnly; SameSite=Lax; 30 天），302 → /
//! - `/*`                内嵌前端静态资源（web/assets.rs）
//!
//! 安全模型：
//! - 鉴权 = 访问令牌，cookie（fetch/WS 自动携带，前端 ipc.ts 零改动）或查询串
//!   `?k=`（首次进入 / WS 直连）任一匹配即可；未授权 → 401 JSON / 提示页
//! - `/api/file` 响应带 `CSP: sandbox` + `nosniff`：双击打开的文档（含不可信 HTML）
//!   运行在 opaque origin，拿不到应用 cookie / 无法调 /api/*，杜绝「打开下载的
//!   网页 → 脚本以应用身份读全盘」的提权
//! - 默认监听 127.0.0.1（bin 侧）；`--listen 0.0.0.0` 开放局域网由使用者显式选择
//! - 不内置 TLS：外网暴露文档要求套反向代理
//! - `read_only` 只拦写类命令；文件流是读操作，只读模式照常（浏览的前提）

pub mod assets;
pub mod bridge;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

const COOKIE_NAME: &str = "rdir_token";
/// cookie 有效期 30 天（服务重启换 token 即全体失效，无需主动清）
const COOKIE_MAX_AGE: u64 = 60 * 60 * 24 * 30;

/// web 服务配置（bin 解析 CLI 后传入）
pub struct WebOptions {
    pub listen: SocketAddr,
    pub token: String,
    pub read_only: bool,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
}

/// 启动服务（阻塞至 Ctrl+C / 监听失败）。fs/volumes 两个监视线程随进程退出结束。
pub async fn serve(mut state: crate::AppState, options: WebOptions) -> Result<(), String> {
    // 数据目录必须存在：json_store::write_atomic 不建父目录，全新 --data-dir
    // 下 session/prefs/servers 等首次保存会直接失败
    for dir in [&options.config_dir, &options.data_dir] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
    }
    // NFS 伴生进程插件安装根与 GUI setup 同构（config_dir/plugins）
    state
        .nfs
        .init(Some(options.config_dir.join("plugins")));
    // 插件启用状态与 GUI 共用同一份 plugins.json（用户在桌面版关掉的插件，web 同步关闭）
    crate::plugins::init_in(&options.config_dir, &mut state.plugins);
    let emitter = Arc::new(crate::events::WebEmitter::new());
    let sink = crate::events::EventSink::new(emitter.clone());
    // 磁盘/卷热插拔 + 打开目录内容监视：事件经 WS 广播给所有浏览器端
    crate::volumes::spawn_watcher(sink.clone());
    crate::fs_watch::spawn_fs_watcher(sink.clone());

    let ctx = Arc::new(bridge::WebCtx {
        state,
        sink,
        emitter,
        config_dir: options.config_dir,
        data_dir: options.data_dir,
        token: options.token,
        read_only: options.read_only,
    });

    let app = Router::new()
        .route("/api/invoke", post(invoke_handler))
        .route("/api/events", get(events_handler))
        .route("/api/file", get(file_handler))
        .route("/login", get(login_handler))
        .fallback(static_handler)
        .with_state(ctx);

    let listener = tokio::net::TcpListener::bind(options.listen)
        .await
        .map_err(|e| format!("端口绑定失败 {}: {e}", options.listen))?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            eprintln!("[rdir-web] 收到退出信号，停止服务");
        })
        .await
        .map_err(|e| format!("服务运行中断：{e}"))
}

// ==================== 鉴权 ====================

/// cookie / 查询串 `k` 任一匹配令牌即通过（浏览器 fetch 与 WS 握手自动带 cookie）
fn authorized(ctx: &bridge::WebCtx, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    if query_token == Some(ctx.token.as_str()) {
        return true;
    }
    cookie_token(headers) == Some(ctx.token.as_str())
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    for v in headers.get_all(header::COOKIE) {
        let Ok(s) = v.to_str() else { continue };
        for pair in s.split(';') {
            let pair = pair.trim();
            // 不匹配的 cookie 对跳过继续（不能用 ?——那会把整函数返回 None）
            if let Some(rest) = pair.strip_prefix(COOKIE_NAME) {
                if let Some(val) = rest.strip_prefix('=') {
                    return Some(val);
                }
            }
        }
    }
    None
}

fn unauthorized_json() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": "UNAUTHORIZED|缺少访问令牌" })),
    )
        .into_response()
}

fn unauthorized_page() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>R-Dir web</title></head>\
         <body style=\"font-family:sans-serif;margin:60px;text-align:center\">\
         <h2>需要访问令牌</h2><p>请使用服务启动时输出的带令牌链接打开（…/login?k=…）。</p></body></html>",
    )
        .into_response()
}

// ==================== 路由处理 ====================

#[derive(Deserialize)]
struct InvokeBody {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn invoke_handler(
    State(ctx): State<Arc<bridge::WebCtx>>,
    headers: HeaderMap,
    Json(body): Json<InvokeBody>,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized_json();
    }
    let result = bridge::dispatch(&ctx, &body.cmd, &body.args).await;
    let payload = match result {
        Ok(v) => json!({ "ok": true, "data": v }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    Json(payload).into_response()
}

async fn events_handler(
    State(ctx): State<Arc<bridge::WebCtx>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !authorized(&ctx, &headers, q.get("k").map(|s| s.as_str())) {
        return unauthorized_json();
    }
    let mut rx = ctx.emitter.subscribe();
    ws.on_upgrade(move |socket| async move {
        pump_events(socket, &mut rx).await;
    })
    .into_response()
}

/// 单连接事件泵：broadcast 帧 → WS 文本帧。Lagged（消费过慢漏帧）不中断连接，
/// 前端既有刷新逻辑（refreshKey/签名比对）对漏帧自愈。
async fn pump_events(socket: WebSocket, rx: &mut tokio::sync::broadcast::Receiver<Value>) {
    let (mut sender, _receiver) = socket.split();
    loop {
        match rx.recv().await {
            Ok(frame) => {
                if sender.send(Message::Text(frame.to_string().into())).await.is_err() {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// 令牌换 cookie：/login?k=<token> → Set-Cookie → 302 /
async fn login_handler(
    State(ctx): State<Arc<bridge::WebCtx>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if q.get("k").map(|s| s.as_str()) != Some(ctx.token.as_str()) {
        return unauthorized_page();
    }
    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        COOKIE_NAME, ctx.token, COOKIE_MAX_AGE
    );
    (
        StatusCode::SEE_OTHER,
        [(header::SET_COOKIE, cookie), (header::LOCATION, "/".to_string())],
        String::new(),
    )
        .into_response()
}

async fn static_handler(
    State(ctx): State<Arc<bridge::WebCtx>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized_page();
    }
    assets::handler(uri)
}

// ==================== 服务端文件流（双击打开 / 远程打开临时副本） ====================

#[derive(Deserialize)]
struct FileQuery {
    path: String,
    /// dl=1 强制附件下载（否则按 Content-Type 内联展示）
    dl: Option<String>,
}

/// 解析 Range 头 → (start, end)（含端）。total=0 忽略；多段/越界 Range 返回 None
/// （调用方整文件 200 兜底——浏览器对 416 的处理参差，退化为全量最稳）。
fn parse_file_range(range: Option<&str>, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = range?.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // 多段 Range 不支持，整文件兜底
    }
    let (s, e) = spec.split_once('-')?;
    if s.is_empty() {
        // 后缀：bytes=-N 最后 N 字节
        let n: u64 = e.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((total.saturating_sub(n), total - 1));
    }
    let start: u64 = s.trim().parse().ok()?;
    let end: u64 = if e.trim().is_empty() {
        total - 1
    } else {
        e.trim().parse().ok()?
    };
    if start >= total || end < start {
        return None;
    }
    Some((start, end.min(total - 1)))
}

async fn file_handler(
    State(ctx): State<Arc<bridge::WebCtx>>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized_page();
    }
    let meta = match tokio::fs::metadata(&q.path).await {
        Ok(m) => m,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                format!("文件不存在：{}", q.path),
            )
                .into_response()
        }
    };
    if meta.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "路径是目录".to_string(),
        )
            .into_response();
    }
    let total = meta.len();
    let mut file = match tokio::fs::File::open(&q.path).await {
        Ok(f) => f,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                format!("无法打开：{e}"),
            )
                .into_response()
        }
    };

    // Range → seek + 限长读取（share::http 同款语义；解析失败整文件 200 兜底）
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|r| parse_file_range(Some(r), total));
    let (start, limit, partial) = match range {
        Some((s, e)) => (s, e - s + 1, true),
        None => (0, total, false),
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "定位失败".to_string(),
        )
            .into_response();
    }
    // 与 share/http.rs 同款 unfold 流：不引入 futures-util io feature
    let stream = futures_util::stream::unfold((file, limit), |(mut f, mut remaining)| async move {
        if remaining == 0 {
            return None;
        }
        let want = remaining.min(64 * 1024) as usize;
        let mut buf = vec![0u8; want];
        let n = match f.read(&mut buf).await {
            Ok(0) => return None,
            Ok(n) => n,
            Err(_) => return Some((Err(std::io::Error::other("读取失败")), (f, remaining))),
        };
        remaining -= n as u64;
        Some((Ok::<_, std::io::Error>(buf[..n].to_vec()), (f, remaining)))
    });

    let fname = std::path::Path::new(&q.path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let disposition = if q.dl.as_deref() == Some("1") {
        "attachment"
    } else {
        "inline"
    };
    let mut resp = Response::new(Body::from_stream(stream));
    *resp.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(crate::web::assets::mime_of(&fname)),
    );
    // 不可信文档隔离：opaque origin，拿不到应用 cookie、调不了 /api/*
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(v) = HeaderValue::from_str(&format!(
        "{disposition}; filename=\"{}\"",
        fname.replace('"', "")
    )) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    if partial {
        if let (Ok(cr), Ok(cl)) = (
            HeaderValue::from_str(&format!("bytes {start}-{}/{total}", start + limit - 1)),
            HeaderValue::from_str(&limit.to_string()),
        ) {
            h.insert(header::CONTENT_RANGE, cr);
            h.insert(header::CONTENT_LENGTH, cl);
        }
    } else if let Ok(cl) = HeaderValue::from_str(&total.to_string()) {
        h.insert(header::CONTENT_LENGTH, cl);
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn ctx_with_token(token: &str) -> bridge::WebCtx {
        bridge::WebCtx {
            state: crate::AppState::default(),
            sink: crate::events::EventSink::new(Arc::new(Nop)),
            emitter: Arc::new(crate::events::WebEmitter::new()),
            config_dir: std::env::temp_dir(),
            data_dir: std::env::temp_dir(),
            token: token.into(),
            read_only: false,
        }
    }
    struct Nop;
    impl crate::events::Emitter for Nop {
        fn emit_json(&self, _: &str, _: Value) {}
    }

    fn headers_with_cookie(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{COOKIE_NAME}={token}")).unwrap(),
        );
        h
    }

    #[test]
    fn auth_accepts_cookie_or_query_and_rejects_mismatch() {
        let ctx = ctx_with_token("abc123");
        assert!(authorized(&ctx, &headers_with_cookie("abc123"), None));
        assert!(authorized(&ctx, &HeaderMap::new(), Some("abc123")));
        // 任一凭证匹配即可：错误 cookie + 正确查询串 → 通过
        assert!(authorized(
            &ctx,
            &headers_with_cookie("wrong"),
            Some("abc123")
        ));
        assert!(!authorized(&ctx, &HeaderMap::new(), None));
        assert!(!authorized(&ctx, &headers_with_cookie("wrong"), Some("wrong2")));
    }

    #[test]
    fn cookie_parsing_survives_other_cookies_and_spaces() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("other=x; rdir_token=tok; more=y"),
        );
        assert_eq!(cookie_token(&h), Some("tok"));
        // 令牌值含特殊字符（hex 之外的形态也原样匹配）
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("rdir_token=a=b"));
        assert_eq!(cookie_token(&h), Some("a=b"));
        let h = HeaderMap::new();
        assert_eq!(cookie_token(&h), None);
    }

    #[test]
    fn file_range_parsing_matches_share_semantics() {
        assert_eq!(parse_file_range(Some("bytes=10-"), 100), Some((10, 99)));
        assert_eq!(parse_file_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(parse_file_range(Some("bytes=-20"), 100), Some((80, 99)));
        // 越界 / 逆序 / 多段 / 非法 → None（整文件 200 兜底）
        assert_eq!(parse_file_range(Some("bytes=100-"), 100), None);
        assert_eq!(parse_file_range(Some("bytes=20-10"), 100), None);
        assert_eq!(parse_file_range(Some("bytes=0-1,5-9"), 100), None);
        assert_eq!(parse_file_range(Some("items=0-1"), 100), None);
        assert_eq!(parse_file_range(Some("bytes=abc-"), 100), None);
        // 无 Range 头 / 空文件 → None（整文件）
        assert_eq!(parse_file_range(None, 100), None);
        assert_eq!(parse_file_range(Some("bytes=0-"), 0), None);
    }
}
