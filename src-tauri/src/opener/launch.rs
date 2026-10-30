//! 安全启动：所有命令使用参数数组（Command::new().args()），
//! 路径作为独立参数传递，绝不拼接 shell 字符串 → 零命令注入。

use std::path::Path;
use std::process::Command;

use super::detect;

fn is_mac() -> bool {
    cfg!(target_os = "macos")
}

/// 远程协议路径不交给本地程序：打开方式链路应先下载到临时目录再传本地路径
/// （v0.37 防呆护栏，此前 sftp:// 串会被原样塞给外部应用）
fn ensure_local_path(path: &str) -> Result<(), String> {
    if path.starts_with("sftp://") || path.starts_with("http://") || path.starts_with("https://") {
        return Err("远程文件需先下载到本地再打开".into());
    }
    Ok(())
}

/// 用内置/Agent 工具打开路径
pub fn launch_custom(exec: &str, path: &str) -> Result<(), String> {
    ensure_local_path(path)?;
    if is_mac() && exec.ends_with(".app") {
        // .app 包：open -a（用包名）
        let name = Path::new(exec)
            .file_name()
            .map(|n| n.to_string_lossy().trim_end_matches(".app").to_string())
            .unwrap_or_else(|| exec.to_string());
        launch(&Command::new("open").arg("-a").arg(&name).arg("--").arg(path), None)
    } else {
        launch(&Command::new(exec).arg(path), Some(work_dir_of(path)))
    }
}

/// 常用工具条（v0.31.1）：可带用户配置的启动参数串，支持占位符。
///
/// - `args` 为空 → 默认行为：终端类可执行文件（git-bash / bash / cmd / powershell / wt …）
///   只在目标目录里开窗、**不**把目录当位置参数（bash 会把它当脚本执行 → `Is a directory`）；
///   其他工具仍是 `exec <path>`。
/// - `args` 非空 → 引号感知切分后逐个 token 替换占位符，再作为参数数组启动（零 shell 拼接）。
///
/// 工作目录统一为「目标目录」：path 是目录就是它本身，是文件则取父目录——此前用父目录，
/// 空白处右键打开时终端落在上一级。
pub fn launch_quick_tool(exec: &str, args: &str, path: &str) -> Result<(), String> {
    let dir = work_dir_of(path);
    let kind = terminal_kind(exec);
    let args = args.trim();
    if args.is_empty() {
        if is_mac() && exec.ends_with(".app") {
            return launch_custom(exec, path);
        }
        return match kind {
            Some(TerminalKind::GitBash) => {
                launch(&Command::new(exec).arg(format!("--cd={dir}")), Some(dir))
            }
            Some(TerminalKind::Wt) => launch(&Command::new(exec).arg("-d").arg(dir), None),
            Some(TerminalKind::Cmd) => launch_in_console(&Command::new(exec).arg("/k"), Some(dir)),
            Some(TerminalKind::PowerShell) => {
                launch_in_console(&Command::new(exec).arg("-NoExit"), Some(dir))
            }
            Some(TerminalKind::PosixShell) => {
                launch_in_console(&Command::new(exec).arg("--login").arg("-i"), Some(dir))
            }
            Some(TerminalKind::Other) => launch(&Command::new(exec), Some(dir)),
            None => launch(&Command::new(exec).arg(path), Some(dir)),
        };
    }
    let mut argv: Vec<String> = crate::cmdrun::tokenize(args)
        .into_iter()
        .map(|t| expand_placeholders(&t, path, dir))
        .collect();
    // 非终端工具的参数串里没写任何占位符 → 目标路径补在末尾（`code --new-window` 这类写法）；
    // 终端类只需要 cwd，不追加
    if kind.is_none() && !has_placeholder(args) {
        argv.push(path.to_string());
    }
    let mut cmd = Command::new(exec);
    cmd.args(&argv);
    // 控制台 shell（cmd / powershell / bash…）必须新开控制台，否则窗口被一起隐藏；
    // GUI 启动器（git-bash 的 mintty / wt / 其他终端模拟器）与普通工具照常
    if kind.is_some_and(|k| k.is_console_shell()) {
        launch_in_console(&cmd, Some(dir))
    } else {
        launch(&cmd, Some(dir))
    }
}

/// 常用工具启动参数里的占位符（纯字符串替换，不做 shell 展开）：
/// `{path}` 目标完整路径；`{dir}` / `$pwd` / `${pwd}` / `{pwd}` 目标目录；`{name}` 文件名。
pub fn expand_placeholders(token: &str, path: &str, dir: &str) -> String {
    let name = base_name(path);
    token
        .replace("${pwd}", dir)
        .replace("{pwd}", dir)
        .replace("$pwd", dir)
        .replace("{dir}", dir)
        .replace("{path}", path)
        .replace("{name}", name)
}

/// 最后一段路径名：同时认 `/` 与 `\`——exec 在 Windows 上是反斜杠路径，
/// 判断逻辑不应依赖运行平台的 Path 实现
fn base_name(p: &str) -> &str {
    p.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(p)
}

/// 启动参数里是否出现任何占位符（设置页用来判断是否需要把目录自动补在末尾）
pub fn has_placeholder(args: &str) -> bool {
    ["{path}", "{dir}", "{pwd}", "${pwd}", "$pwd", "{name}"]
        .iter()
        .any(|p| args.contains(p))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalKind {
    /// git-bash.exe（mintty 启动器，用 --cd=）
    GitBash,
    /// Windows Terminal（-d 起始目录）
    Wt,
    Cmd,
    PowerShell,
    /// bash / sh / zsh / fish / nu 等控制台 shell
    PosixShell,
    /// 其他已知终端模拟器（alacritty / wezterm / mintty …）：只设 cwd
    Other,
}

impl TerminalKind {
    /// 控制台子系统程序：Windows 上要 CREATE_NEW_CONSOLE 才有窗口
    pub fn is_console_shell(self) -> bool {
        matches!(self, TerminalKind::Cmd | TerminalKind::PowerShell | TerminalKind::PosixShell)
    }
}

/// 按可执行文件名判断是不是终端类程序（大小写不敏感，忽略 .exe）
pub fn terminal_kind(exec: &str) -> Option<TerminalKind> {
    let stem = base_name(exec).to_lowercase();
    let stem = stem.trim_end_matches(".exe");
    match stem {
        "git-bash" => Some(TerminalKind::GitBash),
        "wt" => Some(TerminalKind::Wt),
        "cmd" => Some(TerminalKind::Cmd),
        "powershell" | "pwsh" => Some(TerminalKind::PowerShell),
        "bash" | "sh" | "zsh" | "fish" | "nu" | "dash" | "ksh" => Some(TerminalKind::PosixShell),
        "mintty" | "alacritty" | "wezterm" | "wezterm-gui" | "conemu" | "conemu64" | "hyper"
        | "tabby" | "kitty" | "terminal" | "iterm" | "iterm2" => Some(TerminalKind::Other),
        _ => None,
    }
}

/// 目标对应的工作目录：目录就是自身，文件取父目录
fn work_dir_of(path: &str) -> &str {
    if Path::new(path).is_dir() {
        path
    } else {
        parent_of(path).unwrap_or(path)
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

/// 用 VSCode 打开文件或目录（v0.29.0 右键）
pub fn launch_vscode(path: &str) -> Result<(), String> {
    let v = detect::find_vscode();
    if let Some(app) = v.app_name {
        // .app：open -a（文件/目录都接受）
        return launch(
            &Command::new("open").arg("-a").arg(app).arg("--").arg(path),
            None,
        );
    }
    let exec = v.exec.ok_or("未找到 Visual Studio Code（可安装后重试，或把 code 加入 PATH）")?;
    launch(&Command::new(&exec).arg(path), None)
}

/// 用指定 Git 工具打开目录（v0.29.0 右键「Git 打开」折叠组）
pub fn launch_git_tool(tool_id: &str, dir: &str) -> Result<(), String> {
    if is_mac() {
        mac_git_tool(tool_id, dir)
    } else {
        win_git_tool(tool_id, dir)
    }
}

/// macOS：GUI Git 客户端以目录为参数 `open -a`（客户端自身会按仓库/目录打开）
fn mac_git_tool(tool_id: &str, dir: &str) -> Result<(), String> {
    let app = match tool_id {
        "github-desktop" => "GitHub Desktop",
        "fork" => "Fork",
        "tower" => "Tower",
        "sourcetree" => "Sourcetree",
        "sublime-merge" => "Sublime Merge",
        "gitkraken" => "GitKraken",
        _ => return Err(format!("未知 Git 工具：{tool_id}")),
    };
    launch(
        &Command::new("open").arg("-a").arg(app).arg("--").arg(dir),
        None,
    )
    .map_err(|e| format!("打开 {app} 失败：{e}"))
}

/// Windows：Git Bash / Git GUI（git 自带）+ 常见 GUI 客户端
fn win_git_tool(tool_id: &str, dir: &str) -> Result<(), String> {
    match tool_id {
        // git-bash.exe 的「Git Bash Here」即 --cd= 参数；cwd 双保险
        "gitbash" => {
            let exe = detect::find_git_bash().ok_or("未找到 Git Bash")?;
            launch(
                &Command::new(&exe).arg(format!("--cd={dir}")),
                Some(dir),
            )
        }
        // `git gui`：git.exe 是控制台程序，用 CREATE_NO_WINDOW 承载不弹黑框
        "gitgui" => {
            let git = detect::find_win_cli("git").ok_or("未找到 git")?;
            launch(&Command::new(&git).arg("gui"), Some(dir))
        }
        "github-desktop" => {
            let exe = detect::find_github_desktop().ok_or("未找到 GitHub Desktop")?;
            launch(&Command::new(&exe).arg(dir), None)
        }
        "sublime-merge" => {
            let exe = detect::find_sublime_merge().ok_or("未找到 Sublime Merge")?;
            launch(&Command::new(&exe).arg(dir), None)
        }
        "gitkraken" => {
            let exe = detect::find_win_cli("gitkraken").ok_or("未找到 GitKraken")?;
            launch(&Command::new(&exe).arg(dir), None)
        }
        _ => Err(format!("未知 Git 工具：{tool_id}")),
    }
}

/// 在指定目录新开终端窗口执行命令串（v0.22.0 地址栏命令执行）。
/// 唯一例外于"不拼 shell 字符串"原则：命令串本身就是用户要交给 shell 的输入
/// （含参数/管道等），按原样传递；路径部分（cd 目录）仍走转义，不经拼接注入。
pub fn exec_in_terminal(command: &str, dir: &str) -> Result<(), String> {
    if is_mac() {
        mac_exec(command, dir)
    } else {
        win_exec(command, dir)
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
            // AppleScript：cd 到目录再启动 shell；转义双引号与反斜杠。
            // do script 只开窗不激活（Terminal 在后台时新窗会藏在当前应用后面），
            // 末尾 activate 前台化
            let esc_dir = dir.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!(
                "tell application \"Terminal\"\ndo script \"cd \\\"{esc_dir}\\\" && {cli}\"\nactivate\nend tell"
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

/// macOS：AppleScript 在 Terminal 中 cd 到目录后执行命令串。
/// cd 目录与用户命令都做 AppleScript 字符串层转义（引号/反斜杠），
/// 转义后 Terminal 收到的仍是原始字符，由 shell 自行解释。
/// `do script` 只开窗不激活（Terminal 已在程序坞时新窗藏在当前应用后面），
/// 末尾 `activate` 把 Terminal 调到前台。
fn mac_exec(command: &str, dir: &str) -> Result<(), String> {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Terminal\"\ndo script \"cd \\\"{}\\\" && {}\"\nactivate\nend tell",
        esc(dir),
        esc(command)
    );
    launch(&Command::new("osascript").arg("-e").arg(&script), None).map_err(|e| {
        if e.contains("not authorized") || e.contains("不允许") || e.contains("-1743") {
            format!("执行命令需要授权：请在 系统设置 → 隐私与安全性 → 自动化 中允许本应用控制\"终端\"后再试。\n原始错误：{e}")
        } else {
            e
        }
    })
}

// ───────────────────────── Windows ─────────────────────────

fn win_exec(command: &str, dir: &str) -> Result<(), String> {
    // PowerShell 新控制台：-NoExit 保持窗口；工作目录由 OS 设置（cd 零转义）
    let ps = detect::find_win_cli("powershell").unwrap_or_else(|| "powershell.exe".into());
    launch_in_console(
        &Command::new(ps).arg("-NoExit").arg("-Command").arg(command),
        Some(dir),
    )
}

fn win_terminal(shell_id: &str, dir: &str) -> Result<(), String> {
    match shell_id {
        // Windows Terminal：-d 设置起始目录
        "wt" => {
            let wt = detect::find_win_cli("wt").ok_or("未找到 Windows Terminal")?;
            // wt 是 GUI 启动器，保持原行为（隐藏自身控制台不影响其窗口）
            launch(&Command::new(wt).arg("-d").arg(dir), None)
        }
        // PowerShell：-NoExit + 工作目录由 OS 设置（零转义）
        "powershell" => {
            let ps = detect::find_win_cli("powershell").unwrap_or_else(|| "powershell.exe".into());
            launch_in_console(&Command::new(ps).arg("-NoExit"), Some(dir))
        }
        // cmd：/k 保持窗口，工作目录由 OS 设置
        "cmd" => {
            let cmd = detect::find_win_cli("cmd").unwrap_or_else(|| "cmd.exe".into());
            launch_in_console(&Command::new(cmd).arg("/k"), Some(dir))
        }
        // fish / nushell：优先 Windows Terminal 承载；无 wt 时用 cmd /k 承载
        id @ ("fish" | "nu") => {
            let shell = if id == "fish" { "fish" } else { "nu" };
            if let Some(wt) = detect::find_win_cli("wt") {
                launch(&Command::new(wt).arg("-d").arg(dir).arg(shell), None)
            } else if let Some(sh) = detect::find_win_cli(shell) {
                let cmd = detect::find_win_cli("cmd").unwrap_or_else(|| "cmd.exe".into());
                launch_in_console(&Command::new(cmd).arg("/k").arg(&sh), Some(dir))
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
    launch_ex(cmd, cwd, false)
}

/// 启动终端：Windows 上必须新开控制台，否则 powershell/cmd 的控制台窗口会被一起隐藏
fn launch_in_console(cmd: &Command, cwd: Option<&str>) -> Result<(), String> {
    launch_ex(cmd, cwd, true)
}

fn launch_ex(cmd: &Command, cwd: Option<&str>, new_console: bool) -> Result<(), String> {
    let mut c = Command::new(cmd.get_program());
    c.args(cmd.get_args());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // GUI 子进程隐藏控制台（CREATE_NO_WINDOW）；终端子进程新开控制台（CREATE_NEW_CONSOLE）
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        c.creation_flags(if new_console { CREATE_NEW_CONSOLE } else { CREATE_NO_WINDOW });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = new_console;
    match c.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("启动失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{ensure_local_path, expand_placeholders, has_placeholder, terminal_kind, TerminalKind};

    #[test]
    fn remote_scheme_paths_are_rejected() {
        assert!(ensure_local_path("sftp://user@host:22/home/a.txt").is_err());
        assert!(ensure_local_path("http://example.com/a.txt").is_err());
        assert!(ensure_local_path("https://example.com/a.txt").is_err());
        assert!(ensure_local_path("/Users/me/a.txt").is_ok());
        assert!(ensure_local_path(r"C:\Users\me\a.txt").is_ok());
    }

    #[test]
    fn placeholders_expand_dir_path_name() {
        let path = r"C:\Work\My Repo\readme.md";
        let dir = r"C:\Work\My Repo";
        assert_eq!(expand_placeholders("--cd={dir}", path, dir), format!("--cd={dir}"));
        assert_eq!(expand_placeholders("$pwd", path, dir), dir);
        assert_eq!(expand_placeholders("${pwd}", path, dir), dir);
        assert_eq!(expand_placeholders("{pwd}", path, dir), dir);
        assert_eq!(expand_placeholders("{path}", path, dir), path);
        assert_eq!(expand_placeholders("{name}", path, dir), "readme.md");
        // 不含占位符的 token 原样返回
        assert_eq!(expand_placeholders("--login", path, dir), "--login");
    }

    #[test]
    fn placeholder_detection() {
        assert!(has_placeholder("--cd=$pwd"));
        assert!(has_placeholder("-n {path}"));
        assert!(!has_placeholder("--new-window"));
        assert!(!has_placeholder(""));
    }

    #[test]
    fn terminal_kind_by_file_name_case_insensitive() {
        assert_eq!(terminal_kind(r"C:\Program Files\Git\git-bash.exe"), Some(TerminalKind::GitBash));
        assert_eq!(terminal_kind(r"C:\Program Files\Git\bin\bash.exe"), Some(TerminalKind::PosixShell));
        assert_eq!(terminal_kind(r"C:\Windows\System32\cmd.EXE"), Some(TerminalKind::Cmd));
        assert_eq!(terminal_kind("pwsh.exe"), Some(TerminalKind::PowerShell));
        assert_eq!(terminal_kind("wt.exe"), Some(TerminalKind::Wt));
        assert_eq!(terminal_kind("/usr/local/bin/alacritty"), Some(TerminalKind::Other));
        assert_eq!(terminal_kind(r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"), None);
        assert_eq!(terminal_kind("/Applications/Visual Studio Code.app"), None);
    }

    #[test]
    fn console_shells_need_new_console() {
        assert!(TerminalKind::Cmd.is_console_shell());
        assert!(TerminalKind::PosixShell.is_console_shell());
        assert!(!TerminalKind::GitBash.is_console_shell());
        assert!(!TerminalKind::Wt.is_console_shell());
    }
}
