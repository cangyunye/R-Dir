//! 快捷方式创建（v0.46 右键「快捷链接」组：创建快捷方式 / 发送到桌面）。
//!
//! - Windows：`.lnk`（WScript.Shell COM 经 PowerShell 调用，与 compress.rs 的系统命令
//!   策略一致，避免直连 COM ABI 的跨平台编译面）；命名 `{stem}.lnk`。
//! - macOS / Linux：符号链接（`std::os::unix::fs::symlink`，绝对目标）；命名
//!   `{name}{后缀}`（后缀由前端按当前语言传入，如「链接」）。
//!
//! 名称冲突按文件系统实际状态自动追加序号（`xxx 链接 2` / `xxx (2).lnk`）。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 创建结果（camelCase 直出前端）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutOutcome {
    pub created: Vec<String>,
}

/// 目标唯一可用名：存在即追加 ` 2`、` 3`…（Windows `.lnk` 加在扩展名前）
fn unique_link_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{base}{ext}")
        } else if ext.is_empty() {
            format!("{base} {n}")
        } else {
            format!("{base} ({n}){ext}")
        };
        let p = dir.join(name);
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

#[cfg(target_os = "windows")]
fn create_one(target: &Path, dir: &Path, _suffix: &str) -> Result<PathBuf, String> {
    use std::process::Command;
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "快捷方式".into());
    let link = unique_link_path(dir, &stem, ".lnk");
    // WScript.Shell：系统原生 .lnk 生成器（smb/nfs 等远程路径已在命令层拦截）
    let cmd = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
        link.to_string_lossy().replace('\'', "''"),
        target.to_string_lossy().replace('\'', "''"),
        target
            .parent()
            .unwrap_or(target)
            .to_string_lossy()
            .replace('\'', "''"),
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &cmd])
        .status()
        .map_err(|e| format!("启动 powershell 失败:{e}"))?;
    if !status.success() {
        return Err(format!("创建快捷方式失败：{}", link.display()));
    }
    Ok(link)
}

#[cfg(not(target_os = "windows"))]
fn create_one(target: &Path, dir: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "link".into());
    let link = unique_link_path(dir, &format!("{name}{suffix}"), "");
    std::os::unix::fs::symlink(target, &link).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!("无权限在 {} 创建符号链接", dir.display())
        } else {
            format!("创建符号链接失败：{e}")
        }
    })?;
    Ok(link)
}

/// 为每个目标创建一个快捷方式：`to_desktop=true` 落桌面，否则落在目标同级目录。
/// 仅本地路径（sftp/nfs/http 由命令层拦截）；返回实际创建的快捷方式路径列表。
pub fn create_shortcuts(paths: &[String], to_desktop: bool, suffix: &str) -> Result<ShortcutOutcome, String> {
    let desktop = if to_desktop {
        Some(
            dirs::desktop_dir()
                .or_else(dirs::home_dir)
                .ok_or_else(|| "无法定位桌面目录".to_string())?,
        )
    } else {
        None
    };
    let mut created = Vec::new();
    for p in paths {
        let target = Path::new(p);
        if !target.exists() {
            return Err(format!("目标不存在：{p}"));
        }
        let link_dir = desktop.clone().unwrap_or_else(|| {
            target
                .parent()
                .map(|d| d.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."))
        });
        let link = create_one(target, &link_dir, suffix)?;
        created.push(link.to_string_lossy().into_owned());
    }
    Ok(ShortcutOutcome { created })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 唯一命名：同名让位、序号递增；.lnk 序号在扩展名前
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unique_link_path_increments() {
        let dir = std::env::temp_dir().join("rfm_shortcut_naming_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            unique_link_path(&dir, "a.txt链接", ""),
            dir.join("a.txt链接")
        );
        std::fs::write(dir.join("a.txt链接"), "").unwrap();
        assert_eq!(
            unique_link_path(&dir, "a.txt链接", ""),
            dir.join("a.txt链接 2")
        );
        std::fs::write(dir.join("a.txt链接 2"), "").unwrap();
        assert_eq!(
            unique_link_path(&dir, "a.txt链接", ""),
            dir.join("a.txt链接 3")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 真实创建（unix 符号链接）：同级与桌面落点、名称冲突避让
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn creates_symlinks() {
        let root = std::env::temp_dir().join("rfm_shortcut_test");
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("doc.txt");
        std::fs::write(&file, "hi").unwrap();

        // 同级快捷方式
        let out = create_shortcuts(&[file.to_string_lossy().into()], false, "链接").unwrap();
        assert_eq!(out.created.len(), 1);
        let link = PathBuf::from(&out.created[0]);
        assert_eq!(link.file_name().unwrap().to_string_lossy(), "doc.txt链接");
        assert!(link.is_file(), "符号链接可解析到目标");

        // 重名避让
        let out2 = create_shortcuts(&[file.to_string_lossy().into()], false, "链接").unwrap();
        assert_eq!(
            PathBuf::from(&out2.created[0]).file_name().unwrap().to_string_lossy(),
            "doc.txt链接 2"
        );

        // 目录目标 → 符号链接目录
        let out3 = create_shortcuts(&[sub.to_string_lossy().into()], false, "链接").unwrap();
        assert_eq!(
            PathBuf::from(&out3.created[0]).file_name().unwrap().to_string_lossy(),
            "sub链接"
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
