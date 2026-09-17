//! 安全启动：所有命令使用参数数组（Command::new().args()），
//! 路径作为独立参数传递，绝不拼接 shell 字符串 → 零命令注入。

use std::path::Path;
use std::process::Command;

use super::{OpenerItem, detect};

fn is_mac() -> bool {
    cfg!(target_os = "macos")
}

/// 用内置/Agent 工具打开路径
pub fn launch_opener(it: &OpenerItem, path: &str) -> Result<(), String> {
    let exec = it.exec.as_deref().ok_or_else(|| format!("{} 未检测到安装", it.name))?;
    if is_mac() && !it.cli {
        // .app：open -a <name> -- <path>
        launch(&Command::new("open").arg("-a").arg(exec).arg("--").arg(path), None)
    } else if is_mac() {
        launch(&Command::new(exec).arg(path), parent_of(path))
    } else {
        launch(&Command::new(exec).arg(path), parent_of(path))
    }
}

/// 用用户自定义工具打开（exec 为可执行文件路径）
pub fn launch_custom(exec: &str, path: &str) -> Result<(), String> {
    if is_mac() && exec.ends_with(".app") {
        // .app 包：open -a（用包名）
        let name = Path::new(exec)
            .file_name()
            .map(|n| n.to_string_lossy().trim_end_matches(".app").to_string())
            .unwrap_or_else(|| exec.to_string());
        launch(&Command::new("open").arg("-a").arg(&name).arg("--").arg(path), None)
    } else {
        launch(&Command::new(exec).arg(path), parent_of(path))
    }
}

/// 在指定目录打开终端
pub fn launch_terminal(shell_id: &str, path: &str) -> Result<(), String> {
    if is_mac() {
        mac_terminal(shell_id, path)
    } else {
        win_terminal(shell_id, path)
    }
}

// ───────────────────────── macOS ─────────────────────────

fn mac_terminal(shell_id: &str, dir: &str) -> Result<(), String> {
    match shell_id {
        // Terminal / iTerm2：open -a 会以该目录为起始目录打开新窗口
        "terminal" => launch(&Command::new("open").arg("-a").arg("Terminal").arg(dir), None),
        "iterm" => launch(&Command::new("open").arg("-a").arg("iTerm").arg(dir), None),
        // 指定 shell（fish / nushell / zsh）：用 AppleScript 在 Terminal 中执行
        // 首次运行会请求"自动化"授权；失败给出明确提示
        id @ ("fish" | "nu" | "zsh") => {
            let shell = match id {
                "fish" => "fish",
                "nu" => "nu",
                _ => "zsh",
            };
            let cli = detect::find_cli(shell).ok_or_else(|| format!("未找到 {shell}"))?;
            // AppleScript：cd 到目录再启动 shell；转义双引号与反斜杠
            let esc_dir = dir.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!(
                "tell application \"Terminal\" to do script \"cd \\\"{esc_dir}\\\" && {cli}\""
            );
            launch(&Command::new("osascript").arg("-e").arg(&script), None)
                .map_err(|e| {
                    if e.contains("not authorized") || e.contains("不允许") || e.contains("-1743") {
                        format!("打开终端需要授权：请在 系统设置 → 隐私与安全性 → 自动化 中允许本应用控制\"终端\"后再试。\n原始错误：{e}")
                    } else {
                        e
                    }
                })
        }
        _ => Err(format!("未知终端：{shell_id}")),
    }
}

// ───────────────────────── Windows ─────────────────────────

fn win_terminal(shell_id: &str, dir: &str) -> Result<(), String> {
    match shell_id {
        // Windows Terminal：-d 设置起始目录
        "wt" => {
            let wt = detect::find_win_cli("wt").ok_or("未找到 Windows Terminal")?;
            launch(&Command::new(wt).arg("-d").arg(dir), None)
        }
        // PowerShell：-NoExit + 工作目录由 OS 设置（零转义）
        "powershell" => {
            let ps = detect::find_win_cli("powershell").unwrap_or_else(|| "powershell.exe".into());
            launch(&Command::new(ps).arg("-NoExit"), Some(dir))
        }
        // cmd：/k 保持窗口，工作目录由 OS 设置
        "cmd" => {
            let cmd = detect::find_win_cli("cmd").unwrap_or_else(|| "cmd.exe".into());
            launch(&Command::new(cmd).arg("/k"), Some(dir))
        }
        // fish / nushell：优先 Windows Terminal 承载；无 wt 时用 cmd /k 承载
        id @ ("fish" | "nu") => {
            let shell = if id == "fish" { "fish" } else { "nu" };
            if let Some(wt) = detect::find_win_cli("wt") {
                launch(&Command::new(wt).arg("-d").arg(dir).arg(shell), None)
            } else if let Some(sh) = detect::find_win_cli(shell) {
                let cmd = detect::find_win_cli("cmd").unwrap_or_else(|| "cmd.exe".into());
                launch(&Command::new(cmd).arg("/k").arg(&sh), Some(dir))
            } else {
                Err(format!("未找到 {shell}"))
            }
        }
        _ => Err(format!("未知终端：{shell_id}")),
    }
}

// ───────────────────────── 通用 ─────────────────────────

fn parent_of(path: &str) -> Option<&str> {
    Path::new(path)
        .parent()
        .and_then(|p| p.to_str())
        .filter(|p| !p.is_empty())
}

/// 启动子进程（异步分离，不阻塞 UI，不持有句柄）
fn launch(cmd: &Command, cwd: Option<&str>) -> Result<(), String> {
    let mut c = Command::new(cmd.get_program());
    c.args(cmd.get_args());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    #[cfg(target_os = "windows")]
    {
        // Windows 上避免弹出控制台窗口（GUI 子进程）
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    match c.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("启动失败：{e}")),
    }
}
