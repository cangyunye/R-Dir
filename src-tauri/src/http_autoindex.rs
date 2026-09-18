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

/// 请求 nginx autoindex 页面并解析为文件列表。
/// url 必须以 / 结尾（目录视图）；非 200 / 解析失败返回 Err。
pub fn list_http_dir(url: &str) -> Result<Vec<FileEntry>, String> {
    let resp = ureq::get(url)
        .timeout(HTTP_TIMEOUT)
        .call()
        .map_err(|e| http_err(&e))?;
    if !(200..300).contains(&resp.status()) {
        return Err(format!("HTTP {}（{}）", resp.status(), url));
    }
    let body = resp
        .into_string()
        .map_err(|e| format!("读取响应失败：{e}"))?;
    parse_autoindex_html(&body, url)
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
        let line_after = &html[m.end()..html.len().min(m.end() + 400)];
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

fn download_impl(
    app: &tauri::AppHandle,
    local_dir: &str,
    url: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let name = url_last_segment(url)?;
    let dest = std::path::Path::new(local_dir).join(&name);
    // 重名安全：追加 (n) 后缀（与本地复制语义一致）
    let dest = unique_dest(dest);

    let resp = ureq::get(url)
        .timeout(HTTP_TIMEOUT)
        .call()
        .map_err(|e| http_err(&e))?;
    if !(200..300).contains(&resp.status()) {
        return Err(format!("HTTP {}（{}）", resp.status(), url));
    }
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut f = std::fs::File::create(&dest).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("读取失败：{e}"))?;
        if n == 0 {
            break;
        }
        if cancel.load(Ordering::Relaxed) {
            drop(f);
            let _ = std::fs::remove_file(&dest);
            return Err("下载已取消".into());
        }
        f.write_all(&buf[..n]).map_err(|e| format!("写入失败：{e}"))?;
        done += n as u64;
        if total > 0 {
            let mut p = progress::TransferProgress::start("download", "下载中…", 1);
            p.file_done = done;
            p.file_total = total;
            p.id = Some(url.to_string());
            progress::emit(app, &p);
        }
    }
    if total > 0 {
        let mut p = progress::TransferProgress::start("download", "下载完成", 1);
        p.file_done = done;
        p.file_total = total;
        p.id = Some(url.to_string());
        progress::emit(app, &p);
    }
    Ok(dest.to_string_lossy().to_string())
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

    #[test]
    fn parent_url() {
        assert_eq!(
            parent_http_url("http://localhost:8082/a/b/"),
            Some("http://localhost:8082/a/".into())
        );
        assert_eq!(parent_http_url("http://localhost:8082/"), None);
    }
}
