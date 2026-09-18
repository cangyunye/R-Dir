//! 平台工具探测：仅保留"终端"检测（打开终端需要知道已安装的 shell）。
//! v0.6.3 起删除"打开方式"内置工具探测——打开方式只显示用户自定义注册项。

use super::ShellItem;

fn is_mac() -> bool {
    cfg!(target_os = "macos")
}

/// PATH 查找 CLI（macOS）
pub fn find_cli(cmd: &str) -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let p = format!("{dir}/{cmd}");
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    None
}

/// PATH 查找 CLI（Windows）
pub fn find_win_cli(cmd: &str) -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(';') {
        if dir.is_empty() {
            continue;
        }
        for name in [cmd, &format!("{cmd}.exe"), &format!("{cmd}.cmd")] {
            let p = format!(r"{dir}\{name}");
            if std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    None
}

/// 终端清单（v0.6.2 精简）：mac = zsh / iTerm2；win = PowerShell(默认) / cmd / nushell
/// 说明：fish 已移除；macOS 不再列 Terminal.app 直开（zsh 即经 Terminal 执行）
pub fn shell_items() -> Vec<ShellItem> {
    if is_mac() {
        vec![
            shell("zsh", "zsh", find_cli("zsh").is_some()),
            shell("iterm", "iTerm2", std::path::Path::new("/Applications/iTerm.app").exists()),
        ]
    } else {
        vec![
            shell("powershell", "PowerShell", true),
            shell("cmd", "命令提示符 (cmd)", true),
            shell("nu", "nushell", find_win_cli("nu").is_some()),
        ]
    }
}

fn shell(id: &str, name: &str, detected: bool) -> ShellItem {
    ShellItem {
        id: id.to_string(),
        name: name.to_string(),
        detected,
    }
}
