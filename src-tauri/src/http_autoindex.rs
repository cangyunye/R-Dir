//! v0.6 HTTP autoindex 插件（内置）：解析 nginx `autoindex on` 生成的目录索引页，
//! 把链接与上下层 URL 映射为文件 / 文件夹访问方式。
//!
//! 设计：作为第二个按统一契约登记的内置插件（协议前缀 http:// https://），
//! 验证 v0.5 插件注册表对"新增插件"的零改动扩展性；未来外置插件加载层接入时
//! 本模块的解析逻辑可直接复用。

use crate::fs_ops::FileEntry;
use crate::progress;
use regex::Regex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// v0.6.3 起 60s：10s 整体超时导致慢速大文件（如 30MB）下载中断
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// 下载用 HTTP 客户端：读/写超时代替整体超时。
/// ureq 的 Request::timeout 作用于整个请求（含 body），大文件慢速下载会被掐断；
/// AgentBuilder::timeout_read 只限制单次读等待，持续传输不受限。
static DOWNLOAD_AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
fn download_agent() -> &'static ureq::Agent {
    DOWNLOAD_AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(HTTP_TIMEOUT)
            .timeout_write(HTTP_TIMEOUT)
            .build()
    })
}

/// 进行中的 http 下载取消标志表（key = url）
static DOWNLOAD_CANCELS: std::sync::OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    std::sync::OnceLock::new();
fn download_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    DOWNLOAD_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取消指定 url 的下载（由前端传输面板“停止”按钮触发）
#[tauri::command]
pub fn cancel_http_download(url: String) {
    if let Some(c) = download_cancels().lock().unwrap().get(&url) {
        c.store(true, Ordering::Relaxed);
    }
}

/// 请求 HTTP 目录索引并解析为文件列表（v0.7.2 三层判定）。
///
/// ① 响应头快筛：Content-Type=application/json → JSON 索引；Content-Disposition=attachment
///    或文件类型 → 判定为文件；text/html → ② 体嗅探。
/// ② 体特征嗅探：`<h1>Index of` 强签名 → autoindex HTML 解析器；JSON 顶层结构 → JSON
///    解析器；普通网页（无索引签名）→ 提示非目录。
///
/// url 必须以 / 结尾（目录视图）；非 200 / 解析失败返回 Err。
pub fn list_http_dir(url: &str) -> Result<Vec<FileEntry>, String> {
    let resp = ureq::get(url)
        .timeout(HTTP_TIMEOUT)
        .call()
        .map_err(|e| http_err(&e))?;
    if !(200..300).contains(&resp.status()) {
        return Err(format!("HTTP {}（{}）", resp.status(), url));
    }

    // ① 响应头快筛
    if resp
        .header("Content-Disposition")
        .map(|v| v.to_ascii_lowercase().contains("attachment"))
        .unwrap_or(false)
    {
        return Err("该 URL 是一个文件（Content-Disposition: attachment），不是目录索引".into());
    }
    let ctype = resp.header("Content-Type").unwrap_or("").to_ascii_lowercase();
    let is_json = ctype.contains("application/json") || ctype.contains("+json");
    let is_html = ctype.contains("text/html") || ctype.is_empty();

    // 读取响应体（上限 4MB：目录索引页远小于此；超大响应判定为非目录，避免误读大文件/网页）
    let mut reader = resp.into_reader();
    let mut body = Vec::new();
    reader
        .take((MAX_INDEX_BODY + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if body.len() > MAX_INDEX_BODY {
        return Err("响应体过大，判定为非目录索引页（可尝试直接下载）".into());
    }
    let body_str = String::from_utf8_lossy(&body).into_owned();

    // ② 分发解析器
    if is_json || looks_like_json(&body_str) {
        return parse_json_index(&body_str, url);
    }
    if is_html || looks_like_html(&body_str) {
        if looks_like_autoindex(&body_str) {
            return parse_autoindex_html(&body_str, url);
        }
        return Err("该 URL 是普通网页（非目录索引），可用浏览器打开".into());
    }
    Err("该 URL 是文件而非目录索引（可尝试直接打开/下载）".into())
}

/// 目录索引响应体读取上限（字节）：nginx autoindex 千级条目也远小于此。
const MAX_INDEX_BODY: usize = 4 * 1024 * 1024;

/// 响应体首字符是否为 JSON 结构（`{` 或 `[`，跳过空白）。
fn looks_like_json(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with('{') || t.starts_with('[')
}

/// 响应体是否具备 HTML 特征（`<html` / `<!doctype` / `<h1` / `<pre`）。
fn looks_like_html(s: &str) -> bool {
    let t = s.to_ascii_lowercase();
    t.contains("<html")
        || t.contains("<!doctype")
        || t.contains("<h1")
        || t.contains("<pre")
        || t.contains("<a href=")
}

/// nginx autoindex 强签名：`<h1>Index of`（标题行）+ 链接。
fn looks_like_autoindex(s: &str) -> bool {
    let t = s.to_ascii_lowercase();
    t.contains("<h1>index of") || (t.contains("index of") && t.contains("<a href="))
}

/// 解析 nginx autoindex HTML（html 格式），base_url 以 / 结尾。
/// 行格式示例：
///   <a href="../">../</a>
///   <a href="assets/">assets/</a>  16-Sep-2026 22:54  -
///   <a href="README.md">README.md</a>  17-Sep-2026 08:50  7982
pub fn parse_autoindex_html(html: &str, base_url: &str) -> Result<Vec<FileEntry>, String> {
    let link_re = Regex::new(r#"<a href="([^"]+)">([^<]*)</a>"#).unwrap();
    // nginx 行尾的 日期时间 + 大小（目录为 -）
    let meta_re = Regex::new(
        r"(?i)(\d{2}-[a-z]{3}-\d{4}\s+\d{2}:\d{2})\s+(\S+)\s*$",
    )
    .unwrap();

    let mut entries = Vec::new();
    let mut last_idx = 0usize;
    for cap in link_re.captures_iter(html) {
        let m = cap.get(0).unwrap();
        last_idx = m.end();
        let href = cap[1].to_string();
        let name = html_unescape(&cap[2]);
        // 上级链接 ../ 由"上层目录"导航处理，不进入列表
        if href == "../" || href == "../?C=N&O=D" {
            continue;
        }
        let is_dir = href.ends_with('/') || name.ends_with('/');
        let clean_name = name.trim_end_matches('/').to_string();
        if clean_name.is_empty() {
            continue;
        }
        let child_url = join_url(base_url, &href);

        // 尝试解析该行的日期与大小（meta_re 用行末锚定；取 <a> 结束后的行内容）
        let mut size = 0u64;
        let mut modified: Option<i64> = None;
        // 字符安全截取：m.end() 是字节索引，autoindex 含中文文件名时可能落在 UTF-8
        // 字符中间，直接切片会 panic（v0.7.2 修复）
        let line_after = html
            .get(m.end()..)
            .unwrap_or("")
            .chars()
            .take(400)
            .collect::<String>();
        let line = line_after.lines().next().unwrap_or("");
        if let Some(mt) = meta_re.captures(line) {
            modified = parse_nginx_time(&mt[1]);
            size = parse_nginx_size(&mt[2]);
        }

        entries.push(FileEntry {
            extension: ext_from_name(&clean_name),
            name: clean_name,
            path: child_url,
            is_dir,
            is_symlink: false,
            size,
            modified,
            created: None,
            permissions: if is_dir { "drwxr-xr-x".into() } else { "-rw-r--r--".into() },
        });
    }
    let _ = last_idx;
    if entries.is_empty() && !html.contains("<a href=") {
        return Err("该 URL 不是 autoindex 目录页（未找到任何链接）".into());
    }
    Ok(entries)
}

/// 解析 JSON 目录索引（v0.7.2，协议见 docs/http-index-compat.md）。
///
/// 约定协议：
/// ```json
/// { "path": "/dir/", "entries": [
///   {"name": "assets", "type": "dir",  "size": null, "modified": "2026-09-19T10:00:00Z"},
///   {"name": "a.txt",  "type": "file", "size": 7982, "modified": "2026-09-19T08:50:00Z"}
/// ]}
/// ```
/// 宽松兼容：顶层可为数组或含 entries/files/list/items 数组的对象；
/// 字段别名：name/filename、type/is_dir/directory/kind、modified/mtime。
/// JSON 中为明文文件名（含中文），拼接 URL 时做路径段百分号编码。
pub fn parse_json_index(body: &str, base_url: &str) -> Result<Vec<FileEntry>, String> {
    // base_url 归一化：如 /index.json 是"目录代理"文件，子 URL 基于其父目录（http://host/dir/）
    let dir_base = if base_url.ends_with('/') {
        base_url.to_string()
    } else {
        parent_http_url(base_url).unwrap_or_else(|| base_url.to_string())
    };
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("JSON 索引解析失败：{e}"))?;

    let arr: &Vec<serde_json::Value> = match &v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => {
            let mut found = None;
            for key in ["entries", "files", "list", "items"] {
                if let Some(serde_json::Value::Array(a)) = o.get(key) {
                    found = Some(a);
                    break;
                }
            }
            found.ok_or_else(|| {
                "JSON 索引缺少条目数组（期望顶层数组或 entries/files/list 字段）".to_string()
            })?
        }
        _ => return Err("JSON 索引顶层应为数组或对象".into()),
    };

    let mut entries = Vec::new();
    for item in arr {
        let obj = item
            .as_object()
            .ok_or_else(|| "JSON 条目应为对象".to_string())?;
        let name = obj
            .get("name")
            .or_else(|| obj.get("filename"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "JSON 条目缺少 name/filename 字段".to_string())?;
        if name == ".." || name == "." {
            continue;
        }
        // type / is_dir / directory / kind；无显式类型时按 name 尾斜杠推断
        let is_dir = match obj
            .get("type")
            .or_else(|| obj.get("kind"))
            .and_then(|v| v.as_str())
            .map(|t| t.to_ascii_lowercase())
        {
            Some(t) => matches!(t.as_str(), "dir" | "directory" | "folder"),
            None => obj
                .get("is_dir")
                .or_else(|| obj.get("directory"))
                .and_then(|v| v.as_bool())
                .unwrap_or_else(|| name.ends_with('/')),
        };
        let size = obj
            .get("size")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| {
                // 兼容 size 为字符串 "7982"
                obj.get("size").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0)
            });
        let modified = obj
            .get("modified")
            .or_else(|| obj.get("mtime"))
            .and_then(|v| v.as_str())
            .and_then(parse_iso_time);

        let clean_name = name.trim_end_matches('/').to_string();
        let mut child_url = join_url(&dir_base, &url_encode_path_segment(&clean_name));
        // JSON 的目录名不带尾斜杠（与 autoindex 的 href 不同），目录 URL 需补 / 以进入子目录
        if is_dir && !child_url.ends_with('/') {
            child_url.push('/');
        }
        entries.push(FileEntry {
            extension: ext_from_name(&clean_name),
            name: clean_name,
            path: child_url,
            is_dir,
            is_symlink: false,
            size,
            modified,
            created: None,
            permissions: if is_dir { "drwxr-xr-x".into() } else { "-rw-r--r--".into() },
        });
    }
    if entries.is_empty() {
        return Err("JSON 索引为空（无可用条目）".into());
    }
    Ok(entries)
}

/// URL 路径段百分号编码（UTF-8 逐字节）：保留字母数字与 -_.~ 及 /（分段拼接用）。
fn url_encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for b in s.as_bytes() {
        let c = *b as char;
        if b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'_' | b'.' | b'~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 解析 ISO-8601 时间（"2026-09-19T10:00:00Z" 或带 ±HH:MM 偏移）→ Unix 毫秒。
/// 无 chrono 依赖，手写解析（复用 days_from_civil 算法）。
fn parse_iso_time(s: &str) -> Option<i64> {
    let s = s.trim();
    // 兼容 "2026-09-19 10:00:00"（空格分隔）与 "2026-09-19T10:00:00Z"
    let date_part = s.get(..10)?;
    let mut dt = date_part.split('-');
    let year: i64 = dt.next()?.parse().ok()?;
    let month: i64 = dt.next()?.parse().ok()?;
    let day: i64 = dt.next()?.parse().ok()?;

    let time_part = s.get(11..)?;
    let time_part = time_part.trim_end_matches('Z').trim_end_matches('z');
    let time_part = time_part.split(['+', '-']).next().unwrap_or("00:00:00");
    let hm: Vec<&str> = time_part.split(':').collect();
    let hour: i64 = hm.first()?.parse().ok()?;
    let minute: i64 = hm.get(1).map(|v| v.parse().ok()).unwrap_or(Some(0))?;
    let second: i64 = hm.get(2).and_then(|v| v.split('.').next()).map(|v| v.parse().ok()).unwrap_or(Some(0))?;

    // days_from_civil（Howard Hinnant 算法）
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((days * 86400 + hour * 3600 + minute * 60 + second) * 1000)
}

/// 拼接子 URL：base 以 / 结尾，href 为相对路径（保留 nginx 原始编码）。
fn join_url(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
    format!("{base}{}", href.trim_start_matches('/'))
}

/// 解析 nginx 大小列："7982" / "67K" / "1.2M" / "2M" / "-"（目录）
fn parse_nginx_size(s: &str) -> u64 {
    let s = s.trim();
    if s == "-" || s.is_empty() {
        return 0;
    }
    let lower = s.to_ascii_lowercase();
    let (num, mult) = if let Some(v) = lower.strip_suffix('k') {
        (v, 1024u64)
    } else if let Some(v) = lower.strip_suffix('m') {
        (v, 1024 * 1024)
    } else if let Some(v) = lower.strip_suffix('g') {
        (v, 1024 * 1024 * 1024)
    } else {
        (lower.as_str(), 1)
    };
    let f: f64 = num.parse().unwrap_or(0.0);
    (f * mult as f64) as u64
}

/// 解析 nginx 时间 "16-Sep-2026 22:54" → Unix 毫秒
fn parse_nginx_time(s: &str) -> Option<i64> {
    // 用简单查表解析 dd-Mon-YYYY HH:MM，避免引入 chrono
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let d = parts[0].split('-').collect::<Vec<_>>();
    if d.len() != 3 {
        return None;
    }
    let day: i64 = d[0].parse().ok()?;
    let month = match d[1].to_ascii_lowercase().as_str() {
        "jan" => 1, "feb" => 2, "mar" => 3, "apr" => 4, "may" => 5, "jun" => 6,
        "jul" => 7, "aug" => 8, "sep" => 9, "oct" => 10, "nov" => 11, "dec" => 12,
        _ => return None,
    };
    let year: i64 = d[2].parse().ok()?;
    let hm: Vec<&str> = parts[1].split(':').collect();
    let hour: i64 = hm.get(0)?.parse().ok()?;
    let minute: i64 = hm.get(1)?.parse().ok()?;
    // days_from_civil (Howard Hinnant 算法)
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((days * 86400 + hour * 3600 + minute * 60) * 1000)
}

/// HTML 实体解码（覆盖 autoindex 常见转义）
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

fn ext_from_name(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn http_err(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            format!("HTTP {code}（{}）", resp.get_url())
        }
        ureq::Error::Transport(t) => format!("连接失败：{t}"),
    }
}

/// 计算上层目录 URL：http://host:port/a/b/ → http://host:port/a/
pub fn parent_http_url(url: &str) -> Option<String> {
    let mut u = url.to_string();
    while u.ends_with('/') {
        u.pop();
    }
    let idx = u.rfind('/')?;
    if idx <= "http://".len() || idx <= "https://".len() {
        return None; // 已是根
    }
    Some(u[..idx + 1].to_string())
}

// ==================== 下载命令 ====================

/// 从 autoindex 服务器下载文件到本地目录（流式 + 进度条，复用 v0.2 传输通道）。
/// url 为文件完整 URL；目标文件名为 URL 最后一段（百分号解码）。
#[tauri::command]
pub async fn http_download_to(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    local_dir: String,
    url: String,
) -> Result<String, String> {
    if !crate::plugins::plugin_enabled(&state.plugins, "http") {
        return Err("HTTP autoindex 插件已禁用（设置 → 插件中可重新启用）".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    download_cancels().lock().unwrap().insert(url.clone(), cancel.clone());
    let cleanup_url = url.clone();
    let res = tokio::task::spawn_blocking(move || download_impl(&app, &local_dir, &url, &cancel))
        .await
        .map_err(|e| format!("下载任务失败：{e}"))?;
    download_cancels().lock().unwrap().remove(&cleanup_url);
    res
}

/// 下载实现（进度经回调发出，便于单元测试不依赖 AppHandle）
fn download_with_progress(
    local_dir: &str,
    url: &str,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(&progress::TransferProgress),
) -> Result<String, String> {
    let name = url_last_segment(url)?;
    let dest = std::path::Path::new(local_dir).join(&name);
    // 重名安全：追加 (n) 后缀（与本地复制语义一致）
    let dest = unique_dest(dest);
    // 断点续传：同目录下 `文件名.part` 为未完成文件（v0.6.5）
    let part = std::path::PathBuf::from(format!("{}.part", dest.display()));

    // 已有 .part → 从已下载字节续传；否则从头下载
    let done0: u64 = std::fs::metadata(&part)
        .map(|m| m.len())
        .unwrap_or(0);

    let (mut resp, mut resumed) = {
        if done0 > 0 {
            match download_agent()
                .get(url)
                .set("Range", &format!("bytes={done0}-"))
                .call()
            {
                Ok(r) => (r, true),
                // 服务器不支持 Range 起点（文件已变小等）→ 删除 .part 从头下载
                Err(ureq::Error::Status(416, _)) => {
                    let _ = std::fs::remove_file(&part);
                    (
                        download_agent()
                            .get(url)
                            .call()
                            .map_err(|e| http_err(&e))?,
                        false,
                    )
                }
                Err(e) => return Err(http_err(&e)),
            }
        } else {
            (
                download_agent()
                    .get(url)
                    .call()
                    .map_err(|e| http_err(&e))?,
                false,
            )
        }
    };

    let status = resp.status();
    if status == 200 {
        // 服务器忽略/不支持 Range → 从头下载，覆盖已有 .part
        resumed = false;
        let _ = std::fs::remove_file(&part);
    } else if status != 206 {
        return Err(format!("HTTP {}（{}）", status, url));
    }

    // 206 时校验 Content-Range 起点与 .part 大小一致，不一致则从头下载
    if resumed {
        if let Some(cr) = resp.header("Content-Range") {
            // 格式：bytes <start>-<end>/<total>
            let start = cr
                .split('/')
                .next()
                .and_then(|range| range.trim_start_matches("bytes ").split('-').next())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(0);
            if start != done0 {
                resumed = false;
                let _ = std::fs::remove_file(&part);
                resp = download_agent()
                    .get(url)
                    .call()
                    .map_err(|e| http_err(&e))?;
                if resp.status() != 200 {
                    return Err(format!("HTTP {}（{}）", resp.status(), url));
                }
            }
        }
    }

    let remaining: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    // 进度总量：续传时 = 已下载 + 剩余；从头 = Content-Length
    let total: u64 = if resumed { done0 + remaining } else { remaining };

    let mut reader = resp.into_reader();
    let mut f = if resumed && done0 > 0 {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|e| format!("打开续传文件失败：{e}"))?
    } else {
        std::fs::File::create(&part).map_err(|e| format!("创建文件失败：{e}"))?
    };
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = done0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("读取失败：{e}"))?;
        if n == 0 {
            break;
        }
        if cancel.load(Ordering::Relaxed) {
            drop(f);
            // 已下载 > 0 → 保留 .part 供续传；尚未写任何字节 → 清理空文件
            if done == 0 {
                let _ = std::fs::remove_file(&part);
            }
            return Err(format!("下载已暂停（已保存 {} 字节，重新下载将自动续传）", done));
        }
        f.write_all(&buf[..n]).map_err(|e| format!("写入失败：{e}"))?;
        done += n as u64;
        if total > 0 {
            let mut p = progress::TransferProgress::start("download", "下载中…", 1);
            p.file_done = done;
            p.file_total = total;
            p.id = Some(url.to_string());
            emit(&p);
        }
    }
    f.flush().map_err(|e| format!("写入失败：{e}"))?;
    drop(f);
    // 续传完成：.part 重命名为最终文件名
    std::fs::rename(&part, &dest).map_err(|e| format!("完成文件失败：{e}"))?;
    if total > 0 {
        let mut p = progress::TransferProgress::start("download", "下载完成", 1);
        p.file_done = done;
        p.file_total = total;
        p.id = Some(url.to_string());
        emit(&p);
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 命令入口：进度转发到前端传输面板
fn download_impl(
    app: &tauri::AppHandle,
    local_dir: &str,
    url: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    download_with_progress(local_dir, url, cancel, &mut |p| progress::emit(app, p))
}

/// 提取 URL 最后一段作为文件名（去 query/fragment，百分号解码）
fn url_last_segment(url: &str) -> Result<String, String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let seg = path
        .rsplit('/')
        .find(|s| !s.is_empty())
        .ok_or_else(|| "URL 无法提取文件名".to_string())?;
    let decoded = percent_decode(seg);
    if decoded.is_empty() {
        Err("URL 无文件名".into())
    } else {
        Ok(decoded)
    }
}

/// 简易百分号解码（%XX，UTF-8 字节序列）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 2 < bytes.len() + 1 {
            let h = hex_val(bytes.get(i + 1));
            let l = hex_val(bytes.get(i + 2));
            if let (Some(h), Some(l)) = (h, l) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(b: Option<&u8>) -> Option<u8> {
    match b {
        Some(b'0'..=b'9') => Some(b.unwrap() - b'0'),
        Some(b'a'..=b'f') => Some(b.unwrap() - b'a' + 10),
        Some(b'A'..=b'F') => Some(b.unwrap() - b'A' + 10),
        _ => None,
    }
}

/// 目标已存在时追加 (n)（与本地复制命名一致）
fn unique_dest(dest: std::path::PathBuf) -> std::path::PathBuf {
    if !dest.exists() {
        return dest;
    }
    let parent = dest.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = dest
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    for n in 1..1000u32 {
        let name = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let cand = parent.join(name);
        if !cand.exists() {
            return cand;
        }
    }
    dest
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<html>
<head><title>Index of /</title></head>
<body>
<h1>Index of /</h1><hr><pre><a href="../">../</a>
<a href="docs/">docs/</a>  16-Sep-2026 22:54  -
<a href="README.md">README.md</a>  17-Sep-2026 08:50  7982
<a href="icon.png">icon.png</a>  18-Sep-2026 00:15  2M
<a href="data.csv">data.csv</a>  01-Oct-2026 12:00  1.2M
<a href="my%20file.txt">my file.txt</a>  01-Oct-2026 12:00  42
</pre><hr></body>
</html>"#;

    #[test]
    fn parses_autoindex() {
        let v = parse_autoindex_html(SAMPLE, "http://localhost:8082/").unwrap();
        assert_eq!(v.len(), 5);
        assert!(v[0].is_dir);
        assert_eq!(v[0].name, "docs");
        assert_eq!(v[0].path, "http://localhost:8082/docs/");
        assert!(!v[1].is_dir);
        assert_eq!(v[1].size, 7982);
        assert_eq!(v[1].path, "http://localhost:8082/README.md");
        assert_eq!(v[2].size, 2 * 1024 * 1024);
        assert_eq!(v[3].size, 1_258_291); // 1.2M 浮点近似
        assert_eq!(v[4].name, "my file.txt");
        assert!(v[0].modified.is_some());
    }

    /// v0.7.2 JSON 索引解析（约定协议 + 宽松变体）
    #[test]
    fn parses_json_index() {
        let body = r#"{
          "path": "/",
          "entries": [
            {"name": "中文目录", "type": "dir",  "size": null, "modified": "2026-09-19T10:00:00Z"},
            {"name": "readme.md", "type": "file", "size": 7982, "modified": "2026-09-19T08:50:00Z"},
            {"name": "legacy.txt", "is_dir": false, "mtime": "2026-09-18T00:00:00Z"}
          ]
        }"#;
        let v = parse_json_index(body, "http://localhost:8082/").unwrap();
        assert_eq!(v.len(), 3);
        assert!(v[0].is_dir);
        // 中文名 → 路径段百分号编码
        assert_eq!(v[0].path, "http://localhost:8082/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/");
        assert_eq!(v[0].modified.unwrap(), 1789812000000); // 2026-09-19T10:00:00Z
        assert!(!v[1].is_dir);
        assert_eq!(v[1].size, 7982);
        assert!(!v[2].is_dir);

        // 顶层数组变体 + 无 type 推断（尾斜杠目录）
        let arr = r#"[{"name":"docs/","size":0},{"name":"a.txt","size":5}]"#;
        let v2 = parse_json_index(arr, "http://h/d/").unwrap();
        assert_eq!(v2.len(), 2);
        assert!(v2[0].is_dir);
        assert_eq!(v2[0].path, "http://h/d/docs/");
        assert!(!v2[1].is_dir);

        // 非法 JSON / 缺条目数组 → Err
        assert!(parse_json_index("not json", "http://h/").is_err());
        assert!(parse_json_index(r#"{"foo":1}"#, "http://h/").is_err());
    }

    /// ISO 时间解析（含 Z / 空格分隔 / 无秒）
    #[test]
    fn iso_time() {
        assert_eq!(parse_iso_time("2026-09-19T10:00:00Z").unwrap(), 1789812000000);
        assert_eq!(parse_iso_time("2026-09-19 10:00:00").unwrap(), 1789812000000);
        assert_eq!(parse_iso_time("2026-09-19T10:00:00+08:00").unwrap(), 1789812000000);
        assert_eq!(parse_iso_time("2026-09-19T10:00").unwrap(), 1789812000000);
    }

    /// 判定函数
    #[test]
    fn sniffers() {
        assert!(looks_like_autoindex("<h1>Index of /</h1><a href=\"a/\">a/</a>"));
        assert!(looks_like_autoindex("Index of / <pre><a href=\"../\">"));
        assert!(!looks_like_autoindex("<html><body>hello</body></html>"));
        assert!(looks_like_json("  {\"entries\":[]}"));
        assert!(looks_like_json("[1,2]"));
        assert!(!looks_like_json("<html>"));
        assert!(looks_like_html("<html><body>"));
        assert!(looks_like_html("<!doctype html>"));
    }

    /// 真实 nginx 联调：需本机 8082 已启动 autoindex（brew services 或手动 nginx）
    #[test]
    #[ignore]
    fn live_nginx_8082() {
        let v = list_http_dir("http://localhost:8082/").expect("list");
        assert!(!v.is_empty(), "应解析出条目");
        let dirs = v.iter().filter(|e| e.is_dir).count();
        let files = v.iter().filter(|e| !e.is_dir).count();
        println!("entries={} dirs={} files={}", v.len(), dirs, files);
        for e in v.iter().take(6) {
            println!("  [{}] {} size={} mod={:?}", if e.is_dir {"D"} else {"F"}, e.name, e.size, e.modified);
        }
        assert!(dirs >= 1);
        // 子目录解析
        if let Some(d) = v.iter().find(|e| e.is_dir) {
            let sub = list_http_dir(&d.path).expect("sub list");
            println!("sub {} -> {} entries", d.path, sub.len());
        }
        // 上级 URL
        let sub_dir = v.iter().find(|e| e.is_dir).unwrap();
        assert_eq!(
            parent_http_url(&sub_dir.path),
            Some("http://localhost:8082/".into())
        );
    }

    /// 真实 nginx JSON 索引联调：8082 的 index.json（约定协议）
    #[test]
    #[ignore]
    fn live_nginx_json_8082() {
        let v = list_http_dir("http://localhost:8082/index.json").expect("json list");
        assert!(!v.is_empty(), "应解析出条目");
        let dirs = v.iter().filter(|e| e.is_dir).count();
        let files = v.iter().filter(|e| !e.is_dir).count();
        println!("json entries={} dirs={} files={}", v.len(), dirs, files);
        for e in v.iter().take(4) {
            println!(
                "  [{}] {} size={} mod={:?}",
                if e.is_dir { "D" } else { "F" },
                e.name,
                e.size,
                e.modified
            );
        }
        assert!(dirs >= 1 && files >= 1);
        // 中文条目 → URL 已编码，可请求子目录
        if let Some(d) = v.iter().find(|e| e.is_dir) {
            // 中文条目 → URL 已编码，可请求子目录
            let sub = list_http_dir(&d.path).expect("sub list");
            println!("sub {} -> {} entries", d.path, sub.len());
        }
    }

    /// 真实下载联调：从 8082 下载 README.md 到系统临时目录
    #[test]
    #[ignore]
    fn live_download_8082() {
        // 复用下载命令的核心网络逻辑（绕过 AppHandle 进度，验证流式写入与命名）
        let name = url_last_segment("http://localhost:8082/README.md").expect("name");
        assert_eq!(name, "README.md");
        let dir = std::env::temp_dir().join("rdir-http-dl-test");
        std::fs::create_dir_all(&dir).expect("mk temp dir");
        let dest = dir.join(&name);
        let resp = ureq::get("http://localhost:8082/README.md")
            .timeout(HTTP_TIMEOUT)
            .call()
            .expect("GET");
        let mut reader = resp.into_reader();
        let mut f = std::fs::File::create(&dest).expect("create");
        std::io::copy(&mut reader, &mut f).expect("copy");
        let meta = std::fs::metadata(&dest).expect("meta");
        assert!(meta.len() > 100, "README 应大于 100 字节");
        println!("downloaded {} ({} bytes)", dest.display(), meta.len());
        let _ = std::fs::remove_file(&dest);
    }

    /// 断点续传联调（本机 nginx 8082 仓库根，40MB）：
    /// A 完整下载 → B 造 .part 前 10MB 后续传 → C 下载中取消且 .part 保留
    #[test]
    #[ignore]
    fn live_resume_download_8081() {
        let url = "http://localhost:8082/src-tauri/target/rdir-test/resume_src.bin";
        let dir = std::env::temp_dir().join("rdir-http-resume-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mk");

        // A) 完整下载
        let cancel = Arc::new(AtomicBool::new(false));
        let dest = download_with_progress(dir.to_str().unwrap(), url, &cancel, &mut |_| {}).expect("full download");
        let meta = std::fs::metadata(&dest).expect("meta");
        assert_eq!(meta.len(), 40 * 1024 * 1024, "完整下载大小");
        let part = format!("{}.part", dest);
        assert!(!std::path::Path::new(&part).exists(), "完成后不应有 .part");
        std::fs::remove_file(&dest).expect("rm full");

        // B) 手动造 .part（前 10MB）模拟中断现场 → 续传
        {
            let resp = download_agent().get(url).call().expect("GET head");
            let mut reader = resp.into_reader();
            let mut f = std::fs::File::create(&part).expect("create part");
            let mut buf = [0u8; 64 * 1024];
            let mut got = 0u64;
            while got < 10 * 1024 * 1024 {
                let n = reader.read(&mut buf).expect("read");
                if n == 0 {
                    break;
                }
                f.write_all(&buf[..n]).expect("write");
                got += n as u64;
            }
            f.flush().expect("flush");
            drop(f);
            assert_eq!(got, 10 * 1024 * 1024);
        }
        let cancel2 = Arc::new(AtomicBool::new(false));
        let dest2 = download_with_progress(dir.to_str().unwrap(), url, &cancel2, &mut |_| {}).expect("resume download");
        let meta2 = std::fs::metadata(&dest2).expect("meta2");
        assert_eq!(meta2.len(), 40 * 1024 * 1024, "续传后大小");
        assert!(
            !std::path::Path::new(&format!("{}.part", dest2)).exists(),
            "续传完成无 .part"
        );
        std::fs::remove_file(&dest2).expect("rm resumed");

        // C) 取消语义（确定性）：已有 .part 时取消 → 返回“已暂停”且 .part 保留
        let part3 = format!("{}.part", dest2);
        {
            let resp = download_agent().get(url).call().expect("GET head");
            let mut reader = resp.into_reader();
            let mut f = std::fs::File::create(&part3).expect("create part3");
            let mut buf = [0u8; 64 * 1024];
            let mut got = 0u64;
            while got < 10 * 1024 * 1024 {
                let n = reader.read(&mut buf).expect("read");
                if n == 0 {
                    break;
                }
                f.write_all(&buf[..n]).expect("write");
                got += n as u64;
            }
            f.flush().expect("flush");
            drop(f);
        }
        let cancel3 = Arc::new(AtomicBool::new(true));
        let err = download_with_progress(dir.to_str().unwrap(), url, &cancel3, &mut |_| {})
            .err()
            .expect("应返回错误");
        assert!(err.contains("已暂停"), "err={err}");
        let meta3 = std::fs::metadata(&part3).expect("part3 应保留");
        assert!(meta3.len() > 0, "取消后 .part 应非空");
        println!(
            "resume test passed: resumed_size={} canceled_part={}",
            meta2.len(),
            meta3.len()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parent_url() {
        assert_eq!(
            parent_http_url("http://localhost:8082/a/b/"),
            Some("http://localhost:8082/a/".into())
        );
        assert_eq!(parent_http_url("http://localhost:8082/"), None);
    }
}
