//! 平台工具探测：macOS（.app + CLI）、Windows（exe 路径模板 + 注册表 + where.exe）
//! 结果进程内缓存（Mutex<Option<Vec<OpenerItem>>>），懒加载，首次右键时探测一次。

use super::{OpenerItem, ShellItem};

/// 内置工具定义（平台相关）
struct BuiltinDef {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
    /// macOS .app 名称（如 "Visual Studio Code"）
    mac_apps: &'static [&'static str],
    /// Windows exe 名称（用于 App Paths 注册表 / where.exe），如 "Code.exe"
    win_exes: &'static [&'static str],
    /// 跨平台 CLI 命令（PATH 查找），如 "claude"
    cli: &'static [&'static str],
}

const BUILTINS: &[BuiltinDef] = &[
    // ── 编辑器 ──
    BuiltinDef { id: "builtin:vscode", name: "VS Code", kind: "editor", mac_apps: &["Visual Studio Code"], win_exes: &["Code.exe"], cli: &["code"] },
    BuiltinDef { id: "builtin:sublime", name: "Sublime Text", kind: "editor", mac_apps: &["Sublime Text"], win_exes: &["sublime_text.exe"], cli: &["subl"] },
    BuiltinDef { id: "builtin:notepad", name: "记事本", kind: "editor", mac_apps: &["TextEdit"], win_exes: &["notepad.exe"], cli: &[] },
    // ── 浏览器 ──
    BuiltinDef { id: "builtin:chrome", name: "Chrome", kind: "browser", mac_apps: &["Google Chrome"], win_exes: &["chrome.exe"], cli: &[] },
    BuiltinDef { id: "builtin:edge", name: "Edge", kind: "browser", mac_apps: &["Microsoft Edge"], win_exes: &["msedge.exe"], cli: &[] },
    // ── 播放器 ──
    BuiltinDef { id: "builtin:vlc", name: "VLC", kind: "player", mac_apps: &["VLC"], win_exes: &["vlc.exe"], cli: &["vlc"] },
    BuiltinDef { id: "builtin:iina", name: "IINA", kind: "player", mac_apps: &["IINA"], win_exes: &[], cli: &["iina"] },
    BuiltinDef { id: "builtin:potplayer", name: "PotPlayer", kind: "player", mac_apps: &[], win_exes: &["PotPlayerMini64.exe", "PotPlayerMini.exe"], cli: &[] },
    // ── 图片 ──
    BuiltinDef { id: "builtin:preview", name: "预览", kind: "image", mac_apps: &["Preview", "预览"], win_exes: &[], cli: &[] },
    BuiltinDef { id: "builtin:quicktime", name: "QuickTime", kind: "player", mac_apps: &["QuickTime Player"], win_exes: &[], cli: &[] },
    // ── Agent 工具（CLI / 桌面应用）──
    BuiltinDef { id: "agent:zcode", name: "ZCode", kind: "agent", mac_apps: &["ZCode"], win_exes: &["zcode.exe"], cli: &["zcode"] },
    BuiltinDef { id: "agent:omp", name: "Oh My Pi (omp)", kind: "agent", mac_apps: &[], win_exes: &[], cli: &["omp"] },
    BuiltinDef { id: "agent:pi", name: "Pi", kind: "agent", mac_apps: &[], win_exes: &[], cli: &["pi"] },
    BuiltinDef { id: "agent:opencode", name: "OpenCode", kind: "agent", mac_apps: &[], win_exes: &[], cli: &["opencode"] },
    BuiltinDef { id: "agent:claude", name: "Claude Code", kind: "agent", mac_apps: &["Claude"], win_exes: &["claude.exe"], cli: &["claude"] },
    BuiltinDef { id: "agent:codex", name: "Codex", kind: "agent", mac_apps: &[], win_exes: &[], cli: &["codex"] },
    BuiltinDef { id: "agent:trae", name: "Trae (CN)", kind: "agent", mac_apps: &["Trae", "Trae CN"], win_exes: &["Trae.exe", "trae-cn.exe"], cli: &[] },
    BuiltinDef { id: "agent:dsh", name: "DSH", kind: "agent", mac_apps: &["DeepSeek Harness"], win_exes: &[], cli: &["dsh"] },
    BuiltinDef { id: "agent:reasonix", name: "Reasonix", kind: "agent", mac_apps: &[], win_exes: &[], cli: &["reasonix"] },
];

fn is_mac() -> bool {
    cfg!(target_os = "macos")
}
fn is_win() -> bool {
    cfg!(target_os = "windows")
}

/// 生成内置条目（未填充 detected）
pub fn builtin_openers() -> Vec<OpenerItem> {
    BUILTINS
        .iter()
        .map(|b| OpenerItem {
            id: b.id.to_string(),
            name: b.name.to_string(),
            kind: b.kind.to_string(),
            detected: false,
            exec: None,
            cli: false,
            extensions: Vec::new(),
        })
        .collect()
}

/// 探测单条工具是否安装；命中时把 exec 填为可执行信息
pub fn detect_opener(it: &mut OpenerItem) -> bool {
    let Some(def) = BUILTINS.iter().find(|b| b.id == it.id) else {
        return false;
    };
    if is_mac() {
        for app in def.mac_apps {
            if let Some(app_name) = find_mac_app(app) {
                it.exec = Some(app_name);
                it.cli = false;
                return true;
            }
        }
        for cli in def.cli {
            if find_cli(cli).is_some() {
                it.exec = Some(cli.to_string());
                it.cli = true;
                return true;
            }
        }
    } else if is_win() {
        for exe in def.win_exes {
            if let Some(p) = find_win_exe(exe) {
                it.exec = Some(p);
                it.cli = false;
                return true;
            }
        }
        for cli in def.cli {
            if let Some(p) = find_win_cli(cli) {
                it.exec = Some(p);
                it.cli = true;
                return true;
            }
        }
    }
    false
}

/// 根据可执行路径（Windows）或 .app 名称（macOS）反查 opener id（系统默认应用 → 打开方式工具）
pub fn opener_id_for_exec(exec: &str, app_name: &str) -> Option<String> {
    // 1) app 名精确匹配 mac_apps
    let name = app_name.to_lowercase();
    if !name.is_empty() {
        for b in BUILTINS {
            if b.mac_apps.iter().any(|a| a.to_lowercase() == name) {
                return Some(b.id.to_string());
            }
        }
    }
    // 2) 可执行文件名包含匹配
    let fname = std::path::Path::new(exec)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if fname.is_empty() {
        return None;
    }
    for (pat, id) in [
        ("potplayer", "builtin:potplayer"),
        ("sublime_text", "builtin:sublime"),
        ("msedge", "builtin:edge"),
        ("vlc", "builtin:vlc"),
        ("notepad", "builtin:notepad"),
        ("code.exe", "builtin:vscode"),
        ("chrome", "builtin:chrome"),
    ] {
        if fname.contains(pat) {
            return Some(id.to_string());
        }
    }
    None
}

// ───────────────────────── macOS ─────────────────────────

/// 查找 .app：/Applications 与 ~/Applications 顶层精确名 + 扫描模糊匹配
fn find_mac_app(name: &str) -> Option<String> {
    let dirs = [
        "/Applications".to_string(),
        format!("{}/Applications", home_dir()),
    ];
    for dir in dirs {
        let app_path = format!("{dir}/{name}.app");
        if std::path::Path::new(&app_path).exists() {
            return Some(name.to_string());
        }
        // 模糊匹配（大小写不敏感、忽略空格）：扫描目录
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let fname = e.file_name().to_string_lossy().to_lowercase();
                let target = name.to_lowercase();
                if fname.ends_with(".app") && fname.trim_end_matches(".app").replace(' ', "") == target.replace(' ', "") {
                    return Some(e.file_name().to_string_lossy().trim_end_matches(".app").to_string());
                }
            }
        }
    }
    None
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| ".".into())
}

/// PATH 查找 CLI
pub fn find_cli(cmd: &str) -> Option<String> {
    // 直接检查 PATH 各目录，避免依赖 which
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

// ───────────────────────── Windows ─────────────────────────

/// Windows exe 查找：App Paths 注册表 + 常见安装路径 + PATH
fn find_win_exe(exe: &str) -> Option<String> {
    // 1) App Paths 注册表（HKLM + HKCU）
    for hive in ["HKLM", "HKCU"] {
        let key = format!("{hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}");
        if let Ok(out) = std::process::Command::new("reg").args(["query", &key, "/ve"]).output() {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("    ") {
                    if v.contains("REG_SZ") {
                        if let Some(p) = v.split("REG_SZ").nth(1) {
                            let p = p.trim();
                            if std::path::Path::new(p).exists() {
                                return Some(p.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    // 2) 常见安装路径模板
    for tmpl in [
        format!(r"%ProgramFiles%\Microsoft VS Code\{exe}"),
        format!(r"%LocalAppData%\Programs\Microsoft VS Code\{exe}"),
        format!(r"%ProgramFiles%\Sublime Text\{exe}"),
        format!(r"%ProgramFiles%\Google\Chrome\Application\{exe}"),
        format!(r"%LocalAppData%\Google\Chrome\Application\{exe}"),
        format!(r"%ProgramFiles(x86)%\Google\Chrome\Application\{exe}"),
        format!(r"%ProgramFiles%\Microsoft\Edge\Application\{exe}"),
        format!(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\{exe}"),
        format!(r"%ProgramFiles%\VideoLAN\VLC\{exe}"),
        format!(r"%ProgramFiles(x86)%\VideoLAN\VLC\{exe}"),
        format!(r"%ProgramFiles%\DAUM\PotPlayer\{exe}"),
        format!(r"%ProgramFiles(x86)%\DAUM\PotPlayer\{exe}"),
        format!(r"%LocalAppData%\Programs\{exe}"),
    ] {
        let expanded = expand_env(&tmpl);
        if std::path::Path::new(&expanded).exists() {
            return Some(expanded);
        }
    }
    // 3) PATH（where.exe 语义等价：遍历 PATH）
    find_win_cli(exe)
}

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

fn expand_env(p: &str) -> String {
    let mut out = p.to_string();
    for (k, v) in [
        ("%ProgramFiles%", "ProgramFiles"),
        ("%ProgramFiles(x86)%", "ProgramFiles(x86)"),
        ("%LocalAppData%", "LOCALAPPDATA"),
        ("%SystemRoot%", "SystemRoot"),
    ] {
        if out.contains(k) {
            if let Ok(vv) = std::env::var(v) {
                out = out.replace(k, &vv);
            }
        }
    }
    out
}

// ───────────────────────── 终端 ─────────────────────────

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
        let wt = find_win_cli("wt").is_some();
        vec![
            shell("wt", "Windows Terminal", wt),
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
