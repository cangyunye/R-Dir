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

/// 终端清单：win = Windows Terminal / PowerShell / cmd / fish / nushell；mac = Terminal / iTerm2 / fish / nushell / zsh
pub fn shell_items() -> Vec<ShellItem> {
    if is_mac() {
        vec![
            shell("terminal", "终端 (Terminal)", std::path::Path::new("/System/Applications/Utilities/Terminal.app").exists()),
            shell("iterm", "iTerm2", std::path::Path::new("/Applications/iTerm.app").exists()),
            shell("fish", "fish", find_cli("fish").is_some()),
            shell("nu", "nushell", find_cli("nu").is_some()),
            shell("zsh", "zsh", find_cli("zsh").is_some()),
        ]
    } else {
        vec![
            shell("wt", "Windows Terminal", find_win_cli("wt").is_some()),
            shell("powershell", "PowerShell", true),
            shell("cmd", "命令提示符 (cmd)", true),
            shell("fish", "fish", find_win_cli("fish").is_some()),
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
