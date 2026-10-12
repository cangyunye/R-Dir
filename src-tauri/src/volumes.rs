use serde::Serialize;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

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

/// 卷集合签名：把名称/路径/类别按固定分隔符拼接，用于判断集合是否变化。
/// 分隔符选用控制字符，避免与文件名/路径中可能出现的可见字符冲突。
fn volumes_signature(vols: &[VolumeInfo]) -> String {
    let mut s = String::new();
    for v in vols {
        s.push_str(&v.name);
        s.push('\u{1}');
        s.push_str(&v.path);
        s.push('\u{1}');
        s.push_str(&v.kind);
        s.push('\u{2}');
    }
    s
}

/// 后台监视磁盘/卷变化（挂载、卸载、推出、热插拔）：每 2 秒轮询一次列表，
/// 仅在集合真正变化时经 `volumes://changed` 事件推送最新列表，前端据此即时刷新
/// 侧边栏（无需重启）。`read_dir` 开销极小，跨平台且不引入新依赖。
/// 线程随进程退出而结束（detach 型，无 join）。
pub fn spawn_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    thread::spawn(move || {
        let mut last = volumes_signature(&list_volumes());
        loop {
            thread::sleep(Duration::from_secs(2));
            let vols = list_volumes();
            let sig = volumes_signature(&vols);
            if sig != last {
                last = sig;
                let _ = app.emit("volumes://changed", &vols);
            }
        }
    });
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
            // 仅收录实际可访问的目录：dirs 在 Windows 用 KF_FLAG_DONT_VERIFY 返回已知文件夹
            // 默认路径（不验证存在），OneDrive 重定向 / 已删除的库目录（如 My Music）可能
            // 存在但无权限。read_dir 可枚举才算可用，避免侧边栏出现点击后"没有权限访问"的项。
            if p.is_dir() && p.read_dir().is_ok() {
                items.push(QuickAccessItem {
                    key: key.to_string(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vol(name: &str, path: &str, kind: &str) -> VolumeInfo {
        VolumeInfo {
            name: name.into(),
            path: path.into(),
            kind: kind.into(),
        }
    }

    #[test]
    fn signature_is_stable_for_same_set_and_changes_on_add_remove() {
        let a = vec![vol("Macintosh HD", "/", "root"), vol("U盘", "/Volumes/U盘", "volume")];
        assert_eq!(volumes_signature(&a), volumes_signature(&a.clone()));

        // 新增卷 → 签名变化（触发刷新）
        let mut b = a.clone();
        b.push(vol("dmg.x", "/Volumes/dmg.x", "volume"));
        assert_ne!(volumes_signature(&a), volumes_signature(&b));

        // 移除卷（推出）→ 签名变化
        let c = vec![vol("Macintosh HD", "/", "root")];
        assert_ne!(volumes_signature(&a), volumes_signature(&c));
    }

    #[test]
    fn signature_distinguishes_name_from_path_fields() {
        // 防止字段间无分隔导致的歧义拼接（"a"+"b" 与 "ab"+"" 不应相等）
        let x = vec![vol("a", "b", "volume")];
        let y = vec![vol("ab", "", "volume")];
        assert_ne!(volumes_signature(&x), volumes_signature(&y));
    }
}
