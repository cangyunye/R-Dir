use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub struct VolumeInfo {
    pub name: String,
    pub path: String,
    /// 简化分类：root / fixed / removable / volume
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct QuickAccessItem {
    /// 语义键：home / desktop / documents / downloads / pictures / music / movies
    pub key: String,
    pub path: String,
}

/// 枚举磁盘/卷：macOS 读 /Volumes + 根卷；Windows 探测 A: - Z:。
pub fn list_volumes() -> Vec<VolumeInfo> {
    #[cfg(target_os = "macos")]
    {
        let mut vols = Vec::new();
        vols.push(VolumeInfo {
            name: volume_display_name("/").unwrap_or_else(|| "Macintosh HD".into()),
            path: "/".into(),
            kind: "root".into(),
        });
        if let Ok(rd) = std::fs::read_dir("/Volumes") {
            for e in rd.flatten() {
                let p = e.path();
                // 跳过指向根卷的条目（macOS 的 /Volumes/Macintosh HD 是指向 "/" 的符号链接）
                if let Ok(canon) = std::fs::canonicalize(&p) {
                    if canon == std::path::Path::new("/") {
                        continue;
                    }
                }
                vols.push(VolumeInfo {
                    name: e.file_name().to_string_lossy().to_string(),
                    path: p.to_string_lossy().to_string(),
                    kind: "volume".into(),
                });
            }
        }
        vols
    }
    #[cfg(target_os = "windows")]
    {
        let mut vols = Vec::new();
        for c in b'A'..=b'Z' {
            let drive = format!("{}:\\", c as char);
            if std::fs::metadata(&drive).is_ok() {
                let kind = if c < b'C' { "removable" } else { "fixed" };
                vols.push(VolumeInfo {
                    name: format!("{} ({})", c as char, drive),
                    path: drive,
                    kind: kind.into(),
                });
            }
        }
        vols
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

/// macOS 根卷显示名（MVP 固定返回，后续可读卷标）。
#[cfg(target_os = "macos")]
fn volume_display_name(_path: &str) -> Option<String> {
    Some("Macintosh HD".into())
}

/// 快速访问目录（跨平台，缺失的目录跳过）。
pub fn quick_access() -> Vec<QuickAccessItem> {
    let mut items = Vec::new();
    let candidates: [(&str, fn() -> Option<PathBuf>); 7] = [
        ("home", dirs::home_dir),
        ("desktop", dirs::desktop_dir),
        ("documents", dirs::document_dir),
        ("downloads", dirs::download_dir),
        ("pictures", dirs::picture_dir),
        ("music", dirs::audio_dir),
        ("movies", dirs::video_dir),
    ];
    for (key, f) in candidates {
        if let Some(p) = f() {
            // 仅收录实际存在的目录：OneDrive 重定向 / 已删除的库目录（如 Windows My Music）跳过，
            // 避免侧边栏出现不可访问的快捷项
            if p.is_dir() {
                items.push(QuickAccessItem {
                    key: key.to_string(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    items
}
