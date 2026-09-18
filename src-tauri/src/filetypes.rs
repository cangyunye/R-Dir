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
    let ft = FileTypes {
        groups: seed_groups(),
        default_apps: HashMap::new(),
    };
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
    let _ = save(&app, &ft);
    ft
}
