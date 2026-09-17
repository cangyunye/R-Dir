//! 文件类型目录（v0.4）：类别 → 扩展名 的配置化映射，持久化到 filetypes.json。
//! 数据来源分层：
//!   1. 内置种子表（常用扩展名，首次生成时写入配置）
//!   2. 系统默认打开应用探测（Windows 注册表 FileExts/HKCR；macOS LaunchServices/NSWorkspace）
//!   3. 配置可编辑、可"刷新文件关联"按需更新（重新探测合并）
//! 扩展名一律不带点（与前端 FileEntry.extension 对齐）。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileTypes {
    /// 类别 → 扩展名列表（无点）
    #[serde(default)]
    pub groups: HashMap<String, Vec<String>>,
    /// 扩展名（无点）→ opener id（系统默认打开应用，探测可得则填）
    #[serde(default)]
    pub default_apps: HashMap<String, String>,
}

/// 内置种子表（首次生成 + 刷新时作为基底合并）
pub fn seed_groups() -> HashMap<String, Vec<String>> {
    let mut m = HashMap::new();
    let mut put = |k: &str, exts: &[&str]| {
        m.insert(k.to_string(), exts.iter().map(|s| s.to_string()).collect());
    };
    put(
        "video",
        &["mp4", "mkv", "mov", "avi", "wmv", "flv", "webm", "m4v", "ts", "mpg", "mpeg", "3gp", "rmvb", "rm", "m2ts"],
    );
    put(
        "audio",
        &["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "ape", "alac", "aiff", "amr"],
    );
    put(
        "image",
        &["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tiff", "heic", "ico", "avif", "raw", "jfif"],
    );
    put("pdf", &["pdf"]);
    put(
        "text",
        &["txt", "md", "markdown", "log", "json", "yaml", "yml", "toml", "xml", "csv", "ini", "conf", "cfg", "env", "rtf"],
    );
    put(
        "code",
        &["py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "css", "scss", "sh", "bash", "zsh", "fish", "ps1", "sql", "vue", "svelte", "rb", "php", "swift", "kt", "scala", "lua", "r", "pl", "bat", "cmd", "dockerfile", "makefile", "gitignore"],
    );
    put("web", &["html", "htm"]);
    put("archive", &["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "dmg", "pkg", "apk", "ipa"]);
    m
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法获取配置目录：{e}"))
        .map(|d| d.join("filetypes.json"))
}

fn load(app: &tauri::AppHandle) -> Option<FileTypes> {
    let p = config_path(app).ok()?;
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn save(app: &tauri::AppHandle, ft: &FileTypes) -> Result<(), String> {
    let p = config_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let tmp = p.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(ft).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(&tmp, data).map_err(|e| format!("写入配置失败：{e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存配置失败：{e}"))?;
    Ok(())
}

/// 读取文件类型目录（无配置则首次生成：种子表 + 系统默认打开应用探测）
pub fn get(app: &tauri::AppHandle) -> FileTypes {
    if let Some(ft) = load(app) {
        return ft;
    }
    let mut ft = FileTypes {
        groups: seed_groups(),
        default_apps: HashMap::new(),
    };
    let _ = refresh_impl(app, &mut ft);
    let _ = save(app, &ft);
    ft
}

/// 读取文件类型目录（无配置时首次生成 + 系统探测）
#[tauri::command]
pub fn get_filetypes(app: tauri::AppHandle) -> FileTypes {
    get(&app)
}

/// 按需刷新：重新合并种子表 + 重新探测系统默认打开应用
#[tauri::command]
pub fn refresh_filetypes(app: tauri::AppHandle) -> FileTypes {
    let mut ft = load(&app).unwrap_or_else(|| FileTypes {
        groups: seed_groups(),
        default_apps: HashMap::new(),
    });
    // 合并缺失的种子扩展名（用户已手动编辑的条目保留）
    let seeds = seed_groups();
    for (k, v) in seeds {
        let e = ft.groups.entry(k).or_default();
        for x in v {
            if !e.contains(&x) {
                e.push(x);
            }
        }
    }
    let _ = refresh_impl(&app, &mut ft);
    let _ = save(&app, &ft);
    ft
}

/// 探测系统默认打开应用并写入 default_apps（尽力而为，失败不阻塞）
fn refresh_impl(app: &tauri::AppHandle, ft: &mut FileTypes) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let probes = probe_windows_defaults(&ft.groups);
        for (ext, opener_id) in probes {
            ft.default_apps.insert(ext, opener_id);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let probes = probe_macos_defaults(&ft.groups);
        for (ext, opener_id) in probes {
            ft.default_apps.insert(ext, opener_id);
        }
    }
    let _ = app; // 非目标平台 no-op
    Ok(())
}

// ───────────────────────── Windows 注册表探测 ─────────────────────────

#[cfg(target_os = "windows")]
fn probe_windows_defaults(groups: &HashMap<String, Vec<String>>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for exts in groups.values() {
        for ext in exts {
            if let Some(prog_id) = query_progid(ext) {
                if let Some(exe) = query_open_command(&prog_id) {
                    if let Some(id) = crate::opener::detect::opener_id_for_exec(&exe, "") {
                        out.insert(ext.clone(), id);
                    }
                }
            }
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn query_progid(ext: &str) -> Option<String> {
    // 1) UserChoice（用户显式选择，优先）
    let key = format!(
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\UserChoice"
    );
    if let Some(v) = reg_query(&key, "ProgId") {
        return Some(v);
    }
    // 2) HKCR\.ext 默认值
    reg_query(&format!(r"HKCR\.{ext}"), "")
}

#[cfg(target_os = "windows")]
fn query_open_command(prog_id: &str) -> Option<String> {
    // HKCR\<ProgId>\shell\open\command 默认值
    let key = format!(r"HKCR\{prog_id}\shell\open\command");
    let cmd = reg_query(&key, "")?;
    // 提取可执行路径：优先引号内，否则取首个 token
    if let Some(q) = cmd.find('"') {
        if let Some(q2) = cmd[q + 1..].find('"') {
            let p = &cmd[q + 1..q + 1 + q2];
            if std::path::Path::new(p).exists() {
                return Some(p.to_string());
            }
        }
    }
    let first = cmd.split_whitespace().next()?;
    if std::path::Path::new(first).exists() {
        return Some(first.to_string());
    }
    None
}

#[cfg(target_os = "windows")]
fn reg_query(key: &str, value: &str) -> Option<String> {
    let mut args = vec!["query".to_string(), key.to_string()];
    if !value.is_empty() {
        args.push("/v".into());
        args.push(value.to_string());
    }
    let out = std::process::Command::new("reg").args(&args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        let line = line.trim();
        // 格式：  ProgId    REG_SZ    Value
        if let Some(idx) = line.find("REG_SZ") {
            let v = line[idx + "REG_SZ".len()..].trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

// ───────────────────────── macOS LaunchServices 探测 ─────────────────────────

#[cfg(target_os = "macos")]
fn probe_macos_defaults(groups: &HashMap<String, Vec<String>>) -> HashMap<String, String> {
    let mut exts: Vec<String> = groups.values().flatten().cloned().collect();
    exts.sort();
    exts.dedup();
    if exts.is_empty() {
        return HashMap::new();
    }
    // 为每个扩展名建临时文件（NSWorkspace 需要真实存在的文件 URL）
    let tmp_dir = std::env::temp_dir();
    let marker = std::process::id();
    let mut paths = Vec::new();
    let mut cleanup = Vec::new();
    for e in &exts {
        let p = tmp_dir.join(format!(".rdir-probe-{marker}.{e}"));
        if std::fs::write(&p, b"").is_ok() {
            paths.push(p.clone());
            cleanup.push(p);
        }
    }
    if paths.is_empty() {
        return HashMap::new();
    }
    // JXA：一次调用查询全部文件的默认打开应用
    let script = r#"
ObjC.import('AppKit');
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace;
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    try {
      const url = $.NSURL.fileURLWithPath(argv[i]);
      if (!url) { out[argv[i]] = ''; continue; }
      const appUrl = ws.URLForApplicationToOpenURL(url);
      out[argv[i]] = appUrl && appUrl.path ? appUrl.path.js : '';
    } catch (e) { out[argv[i]] = ''; }
  }
  return JSON.stringify(out);
}
"#;
    let mut cmd = std::process::Command::new("osascript");
    cmd.arg("-l").arg("JavaScript").arg("-e").arg(script);
    for p in &paths {
        cmd.arg(p);
    }
    let out = cmd.output();
    let mut map = HashMap::new();
    match out {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.as_object() {
                    for (path, app) in obj {
                        let app = app.as_str().unwrap_or("");
                        if app.is_empty() {
                            continue;
                        }
                        let app_name = std::path::Path::new(app)
                            .file_name()
                            .map(|n| n.to_string_lossy().trim_end_matches(".app").to_string())
                            .unwrap_or_default();
                        // 反查对应扩展名
                        let p = std::path::Path::new(path);
                        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                        if let Some(id) = crate::opener::detect::opener_id_for_exec("", &app_name) {
                            map.insert(ext, id);
                        }
                    }
                }
            } else {
                eprintln!("[filetypes] osascript JSON 解析失败: {text}");
            }
        }
        Ok(out) => {
            eprintln!(
                "[filetypes] osascript 失败 status={:?} stderr={}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        Err(e) => {
            eprintln!("[filetypes] osascript 启动失败: {e}");
        }
    }
    for p in cleanup {
        let _ = std::fs::remove_file(p);
    }
    map
}
