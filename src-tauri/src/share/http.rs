//! v0.7 分享：内嵌 HTTP 服务（axum）。
//!
//! 路由（单端口，token 即凭证）：
//! - GET /{token}/        只读目录浏览页（autoindex 风格，支持上级跳转开关）
//! - GET /{token}/dl?path= Range 断点续传下载
//! 安全：路径词法规范化 + 逃逸拒绝（allow_parent 控制上溯）；符号链接 canonicalize 复核；
//! 每次请求校验 token / 有效期 / 连接数上限，并记录访问者日志。

use crate::share::session::{ConnLog, ShareManager, ShareSession};
use axum::body::Body;
use axum::extract::{ConnectInfo, Path as AxPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Router;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// 单会话上下文（跨 await 使用，不含锁）
#[derive(Clone)]
struct SessionCtx {
    #[allow(dead_code)] // P2 原生会话/日志将使用
    id: String,
    root: PathBuf,
    allow_parent: bool,
    #[allow(dead_code)] // 连接上限在 auth_session 内已检查，字段保留供后续展示
    max_conns: usize,
    #[allow(dead_code)]
    expires_at: Option<SystemTime>,
}

/// 路径解析：词法规范化 + 逃逸控制。
/// - rel 为空 → root 本身
/// - `..` 越出 root：allow_parent=true 时允许上溯（P1 只读浏览开放），否则拒绝
/// - 绝对路径 / 空字节一律拒绝
pub fn resolve_path(root: &Path, rel: &str, allow_parent: bool) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("非法路径".into());
    }
    if rel.starts_with('/') {
        return Err("绝对路径被拒绝".into());
    }
    let mut parts: Vec<String> = Vec::new();
    let mut up = 0usize; // 越出 root 的上溯层数
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_some() {
                    // 正常回退一层
                } else if allow_parent {
                    up += 1;
                } else {
                    return Err("越界访问被拒绝".into());
                }
            }
            s => parts.push(s.to_string()),
        }
    }
    let mut p = root.to_path_buf();
    for _ in 0..up {
        if !p.pop() {
            return Err("已到文件系统根，无法继续上溯".into());
        }
    }
    for part in parts {
        p.push(part);
    }
    // 严格模式（不允许上溯）下做符号链接逃逸复核
    if !allow_parent {
        if let (Ok(canon), Ok(root_canon)) = (p.canonicalize(), root.canonicalize()) {
            if !canon.starts_with(&root_canon) {
                return Err("符号链接越界被拒绝".into());
            }
        }
    }
    Ok(p)
}

/// 请求头用户代理
fn ua_of(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(120)
        .collect()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 认证 + 连接日志。返回可跨 await 的 SessionCtx。
fn auth_session(
    mgr: &ShareManager,
    token: &str,
    ip: &str,
    ua: &str,
) -> Result<SessionCtx, (StatusCode, String)> {
    let sessions = mgr.sessions.lock().unwrap();
    let sess = sessions
        .values()
        .find(|s| s.token == token)
        .ok_or((StatusCode::NOT_FOUND, "分享不存在或已停止".into()))?;
    if let Some(exp) = sess.expires_at {
        if exp <= SystemTime::now() {
            return Err((StatusCode::FORBIDDEN, "分享已过期".into()));
        }
    }
    // 连接数上限（0=不限）；记录访问者
    let mut conns = sess.conns.lock().unwrap();
    if sess.max_conns > 0 && conns.len() >= sess.max_conns {
        return Err((StatusCode::FORBIDDEN, "分享连接数已达上限".into()));
    }
    let now = now_unix();
    let existing = conns.iter_mut().find(|c| c.ip == ip);
    if let Some(c) = existing {
        c.last_active = now;
        c.ua = ua.to_string();
    } else {
        conns.push(ConnLog {
            ip: ip.to_string(),
            ua: ua.to_string(),
            connected_at: now,
            last_active: now,
        });
        if conns.len() > 100 {
            conns.remove(0);
        }
    }
    drop(conns);
    let root = sess
        .roots
        .first()
        .map(|r| r.path.clone())
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "分享根缺失".into()))?;
    Ok(SessionCtx {
        id: sess.id.clone(),
        root,
        allow_parent: sess.allow_parent,
        max_conns: sess.max_conns,
        expires_at: sess.expires_at,
    })
}

/// 简易 percent-encode（路径段安全）
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// HTML 转义
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn fmt_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else if n < 1024 * 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", n as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

/// 目录列表 → HTML 页
fn render_index(root: &Path, rel: &str, allow_parent: bool, token: &str) -> Result<String, String> {
    let dir = resolve_path(root, rel, allow_parent)?;
    let meta = std::fs::metadata(&dir).map_err(|e| format!("无法访问：{e}"))?;
    if !meta.is_dir() {
        return Err("不是目录".into());
    }
    let mut rows = String::new();
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("读取失败：{e}"))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name())
    });
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let mut rel_child = rel.trim_end_matches('/').to_string();
        if !rel_child.is_empty() {
            rel_child.push('/');
        }
        rel_child.push_str(&name);
        if is_dir {
            rows.push_str(&format!(
                "<tr><td><a class=\"d\" href=\"/{}/?path={}/\">📁 {}</a></td><td></td><td></td></tr>\n",
                token,
                url_encode(&rel_child),
                escape_html(&name)
            ));
        } else {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .map(|t| {
                    let d = t
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    chrono_like(d)
                })
                .unwrap_or_default();
            rows.push_str(&format!(
                "<tr><td><a class=\"f\" href=\"/{}/dl?path={}\">📄 {}</a></td><td>{}</td><td>{}</td></tr>\n",
                token,
                url_encode(&rel_child),
                escape_html(&name),
                fmt_size(size),
                modified
            ));
        }
    }
    // 上级链接：allow_parent 或当前不在根时显示
    let up_link = if allow_parent || !rel.trim_matches('/').is_empty() {
        let parent_rel = rel.trim_end_matches('/');
        let parent = if parent_rel.is_empty() {
            "../".to_string()
        } else {
            let idx = parent_rel.rfind('/');
            match idx {
                Some(i) => parent_rel[..i + 1].to_string(),
                None => "".to_string(),
            }
        };
        format!("<p><a href=\"/{}/?path={}\">⬆ 上级目录</a></p>\n", token, url_encode(&parent))
    } else {
        String::new()
    };
    let title = if rel.trim_matches('/').is_empty() {
        "/".to_string()
    } else {
        format!("/{}", rel.trim_matches('/'))
    };
    Ok(format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>分享：{title}</title>
<style>body{{font-family:-apple-system,sans-serif;margin:24px;color:#1e293b;}}
a{{text-decoration:none;color:#2563eb}} a:hover{{text-decoration:underline}}
table{{border-collapse:collapse;width:100%;font-size:14px}}
td{{padding:5px 12px;border-bottom:1px solid #e2e8f0}}
td:nth-child(2){{color:#64748b;white-space:nowrap}} td:nth-child(3){{color:#94a3b8;white-space:nowrap}}
.d{{color:#0f766e;font-weight:600}}</style></head><body>
<h2>分享目录 {title}</h2>{up_link}<table><tr><th>名称</th><th>大小</th><th>修改时间</th></tr>
{rows}</table></body></html>"#
    ))
}

/// unix 秒 → "YYYY-MM-DD HH:MM"（避免引入 chrono 依赖，手动换算 UTC）
fn chrono_like(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let (hh, mm) = (rem / 3600, (rem % 3600) / 60);
    // 1970-01-01 起的天数 → 年月日（civil_from_days 算法）
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02} {:02}:{:02}", y, m, d, hh, mm)
}

// ==================== axum handlers ====================

/// 启动分享服务器（绑定 0.0.0.0:0 系统分配端口），返回端口与 JoinHandle。
pub async fn serve(
    mgr: Arc<ShareManager>,
    sess: &ShareSession,
) -> Result<(u16, tauri::async_runtime::JoinHandle<()>), String> {
    let _ = sess.token.clone();
    let router = build_router(Arc::clone(&mgr));
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|e| format!("端口绑定失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    eprintln!("[share] starting axum on 0.0.0.0:{}", port);
    let handle = tauri::async_runtime::spawn(async move {
        match axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            Ok(_) => eprintln!("[share] server on port {} exited cleanly", port),
            Err(e) => eprintln!("[share] server on port {} error: {}", port, e),
        }
    });
    eprintln!("[share] axum task spawned, port {}", port);
    Ok((port, handle))
}

/// 构建 axum 路由（供 serve 与测试复用）
fn build_router(mgr: Arc<ShareManager>) -> axum::Router<()> {
    Router::new()
        .route("/{token}", axum::routing::get(index))
        .route("/{token}/dl", axum::routing::get(download))
        .with_state(mgr)
}

async fn index(
    State(mgr): State<Arc<ShareManager>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    AxPath(token): AxPath<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ip = addr.ip().to_string();
    let ctx = match auth_session(&mgr, &token, &ip, &ua_of(&headers)) {
        Ok(c) => c,
        Err(e) => return err_response(e),
    };
    let rel = q.get("path").cloned().unwrap_or_default();
    let html = match tokio::task::spawn_blocking(move || {
        render_index(&ctx.root, &rel, ctx.allow_parent, &token)
    })
    .await
    {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => return err_response((StatusCode::FORBIDDEN, e)),
        Err(e) => return err_response((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    };
    Html(html).into_response()
}

async fn download(
    State(mgr): State<Arc<ShareManager>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    AxPath(token): AxPath<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ip = addr.ip().to_string();
    let ctx = match auth_session(&mgr, &token, &ip, &ua_of(&headers)) {
        Ok(c) => c,
        Err(e) => return err_response(e),
    };
    let rel = q.get("path").cloned().unwrap_or_default();
    let file_path = match resolve_path(&ctx.root, &rel, ctx.allow_parent) {
        Ok(p) => p,
        Err(e) => return err_response((StatusCode::FORBIDDEN, e)),
    };
    let meta = match tokio::fs::metadata(&file_path).await {
        Ok(m) => m,
        Err(_) => return err_response((StatusCode::NOT_FOUND, "文件不存在".into())),
    };
    if !meta.is_file() {
        return err_response((StatusCode::BAD_REQUEST, "仅支持下载文件".into()));
    }
    let total = meta.len();
    // 解析 Range: bytes=start-end | bytes=start- | bytes=-suffix
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (start, end) = match parse_range(range, total) {
        Ok(r) => r,
        Err(e) => {
            let mut resp = err_response((StatusCode::RANGE_NOT_SATISFIABLE, e));
            *resp.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            return resp;
        }
    };
    // 打开文件 → seek 到 start → 字节数限制的流（Range 断点续传核心）
    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return err_response((StatusCode::NOT_FOUND, "文件无法打开".into())),
    };
    use tokio::io::AsyncSeekExt;
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return err_response((StatusCode::INTERNAL_SERVER_ERROR, "读取失败".into()));
    }
    let limit = (end - start + 1) as usize;
    use tokio::io::AsyncReadExt;
    let stream = futures_util::stream::unfold((file, limit), |(mut f, mut remaining)| async move {
        if remaining == 0 {
            return None;
        }
        let want = remaining.min(64 * 1024);
        let mut buf = vec![0u8; want];
        let n = match f.read(&mut buf).await {
            Ok(0) => return None,
            Ok(n) => n,
            Err(_) => return Some((Err(std::io::Error::other("读取失败")), (f, remaining))),
        };
        remaining -= n;
        Some((Ok::<_, std::io::Error>(buf[..n].to_vec()), (f, remaining)))
    });
    let body = Body::from_stream(stream);
    let partial = total > 0 && (start > 0 || end + 1 < total);
    let mut resp = Response::new(body);
    *resp.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let fname = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let headers = resp.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&format!("attachment; filename=\"{}\"", fname.replace('"', "")))
            .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );
    if partial {
        headers.insert(
            header::CONTENT_RANGE,
            header::HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, total)).unwrap(),
        );
        headers.insert(
            header::CONTENT_LENGTH,
            header::HeaderValue::from_str(&(end - start + 1).to_string()).unwrap(),
        );
        headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("bytes"));
    } else {
        headers.insert(
            header::CONTENT_LENGTH,
            header::HeaderValue::from_str(&total.to_string()).unwrap(),
        );
        headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("bytes"));
    }
    resp
}

/// 解析 Range 头 → (start, end)。total=0 时忽略 Range。
fn parse_range(range: Option<&str>, total: u64) -> Result<(u64, u64), String> {
    if total == 0 {
        return Ok((0, 0));
    }
    let Some(r) = range else {
        return Ok((0, total.saturating_sub(1)));
    };
    let r = r.trim();
    let spec = r.strip_prefix("bytes=").ok_or("仅支持 bytes 单位")?;
    let (s, e) = spec
        .split_once('-')
        .ok_or("Range 格式错误")?;
    let start: u64 = if s.is_empty() {
        // 后缀：bytes=-N 最后 N 字节
        let n: u64 = e.trim().parse().map_err(|_| "Range 数值错误")?;
        return Ok((total.saturating_sub(n), total - 1));
    } else {
        s.trim().parse().map_err(|_| "Range 数值错误")?
    };
    let end: u64 = if e.is_empty() {
        total - 1
    } else {
        e.trim().parse().map_err(|_| "Range 数值错误")?
    };
    if start >= total || end < start {
        return Err("Range 越界".into());
    }
    Ok((start, end.min(total - 1)))
}

fn err_response((code, msg): (StatusCode, String)) -> Response {
    let body = format!(
        "<!DOCTYPE html><html><body style=\"font-family:sans-serif;margin:40px\"><h2>{}</h2><p>{}</p></body></html>",
        code.as_u16(),
        escape_html(&msg)
    );
    (code, Html(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_locks_inside_root() {
        let root = Path::new("/tmp/rdir-share-test");
        assert_eq!(
            resolve_path(root, "a/b.txt", false).unwrap(),
            PathBuf::from("/tmp/rdir-share-test/a/b.txt")
        );
        assert_eq!(
            resolve_path(root, "a/../b.txt", false).unwrap(),
            PathBuf::from("/tmp/rdir-share-test/b.txt")
        );
        assert_eq!(resolve_path(root, "", false).unwrap(), root.to_path_buf());
    }

    #[test]
    fn resolve_rejects_escape_when_locked() {
        let root = Path::new("/tmp/rdir-share-test");
        assert!(resolve_path(root, "../secret", false).is_err());
        assert!(resolve_path(root, "a/../../secret", false).is_err());
        assert!(resolve_path(root, "/etc/passwd", false).is_err());
        assert!(resolve_path(root, "a\0b", false).is_err());
    }

    #[test]
    fn resolve_allows_parent_when_enabled() {
        let root = Path::new("/tmp/rdir-share-test");
        assert_eq!(
            resolve_path(root, "../sibling", true).unwrap(),
            PathBuf::from("/tmp/sibling")
        );
        assert_eq!(
            resolve_path(root, "../../etc/passwd", true).unwrap(),
            PathBuf::from("/etc/passwd")
        );
        // 词法上允许；canonicalize 复核仅在锁定时执行
    }

    #[test]
    fn parse_range_cases() {
        assert_eq!(parse_range(None, 100).unwrap(), (0, 99));
        assert_eq!(parse_range(Some("bytes=10-"), 100).unwrap(), (10, 99));
        assert_eq!(parse_range(Some("bytes=10-19"), 100).unwrap(), (10, 19));
        assert_eq!(parse_range(Some("bytes=-20"), 100).unwrap(), (80, 99));
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
        assert!(parse_range(Some("bytes=20-10"), 100).is_err());
        assert!(parse_range(Some("items=0-1"), 100).is_err());
    }

    #[test]
    fn token_format() {
        let m = ShareManager::default();
        let t = m.gen_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        let t2 = m.gen_token();
        assert_ne!(t, t2);
    }

    #[tokio::test]
    #[ignore = "e2e：链接慢，真实验证走运行中的应用 + curl"]
    async fn e2e_index_and_range_download() {
        use axum::extract::ConnectInfo;
        use std::io::Read;
        use std::net::SocketAddr;
        use std::sync::{Arc, Mutex};
        use std::time::SystemTime;

        let tmp = std::env::temp_dir().join(format!("rdir-share-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("hello.txt"), "hello share").unwrap();
        let big_data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(tmp.join("big.bin"), &big_data).unwrap();

        let mgr = Arc::new(crate::share::session::ShareManager::default());
        let token = mgr.gen_token();
        let sess = crate::share::session::ShareSession {
            id: "t1".into(),
            token: token.clone(),
            roots: vec![crate::share::session::ShareRoot { id: "root".into(), path: tmp.clone() }],
            perm: crate::share::session::SharePerm::Read,
            allow_parent: false,
            max_conns: 3,
            expires_at: None,
            created_at: SystemTime::now(),
            port: 0,
            server_task: None,
            conns: Mutex::new(Vec::new()),
        };
        mgr.sessions.lock().unwrap().insert("t1".into(), sess);

        let router = build_router(Arc::clone(&mgr));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        // 1) 首页列出文件
        let resp = ureq::get(&format!("http://{addr}/{token}"))
            .call()
            .unwrap();
        assert_eq!(resp.status(), 200, "首页应 200");
        let body = resp.into_string().unwrap();
        assert!(body.contains("hello.txt") && body.contains("big.bin"), "首页应列出两个文件");

        // 2) 错误 token 拒绝
        let bad = ureq::get(&format!("http://{addr}/deadbeef")).call();
        assert!(bad.is_err(), "错误 token 应拒绝");

        // 3) 全量下载
        let dl = ureq::get(&format!("http://{addr}/{token}/dl?path=big.bin"))
            .call()
            .unwrap();
        assert_eq!(dl.status(), 200);
        let mut full: Vec<u8> = Vec::new();
        dl.into_reader().take(1_000_000).read_to_end(&mut full).unwrap();
        assert_eq!(full, big_data, "全量下载内容一致");

        // 4) Range 断点续传
        let r2 = ureq::get(&format!("http://{addr}/{token}/dl?path=big.bin"))
            .set("Range", "bytes=500-999")
            .call()
            .unwrap();
        assert_eq!(r2.status(), 206, "Range 应返回 206");
        let mut part: Vec<u8> = Vec::new();
        r2.into_reader().take(1000).read_to_end(&mut part).unwrap();
        assert_eq!(part, big_data[500..1000], "Range 片段一致");

        // 5) 后缀 Range
        let r4 = ureq::get(&format!("http://{addr}/{token}/dl?path=big.bin"))
            .set("Range", "bytes=-10")
            .call()
            .unwrap();
        assert_eq!(r4.status(), 206);
        let mut tail: Vec<u8> = Vec::new();
        r4.into_reader().take(100).read_to_end(&mut tail).unwrap();
        assert_eq!(tail, big_data[big_data.len() - 10..], "后缀 Range 一致");

        // 6) 越界路径拒绝
        let esc = ureq::get(&format!("http://{addr}/{token}/dl?path=../../etc/passwd")).call();
        assert!(esc.is_err(), "越界路径应拒绝");

        // 7) allow_parent=false 时 /etc 直接拒绝
        let abs = ureq::get(&format!("http://{addr}/{token}/dl?path=/etc/passwd")).call();
        assert!(abs.is_err(), "绝对路径应拒绝");

        mgr.stop("t1");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
