//! 平台工具探测：终端 + v0.29.0 右键内置工具（VSCode / Git 工具链）。
//! "打开方式"仍只显示用户自定义注册项（v0.6.3 约定）；
//! VSCode 与 Git 打开是固定的右键入口，探测逻辑集中在本文件。

use serde::Serialize;
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

/// 终端清单（v0.10）：mac = Terminal / zsh / iTerm2；win = PowerShell(默认) / cmd / nushell
/// 说明：fish 已移除；Terminal.app 置顶（最常用，open -a 直接以目录为起始目录开窗）
pub fn shell_items() -> Vec<ShellItem> {
    if is_mac() {
        let terminal_app =
            std::path::Path::new("/System/Applications/Utilities/Terminal.app").exists()
                || std::path::Path::new("/Applications/Utilities/Terminal.app").exists();
        vec![
            shell("terminal", "Terminal", terminal_app),
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

// ───────────────── v0.29.0 VSCode / Git 工具探测 ─────────────────

/// VSCode 可执行入口（启动方式二选一：mac 优先 .app（open -a），否则 CLI/EXE 直启）
pub struct VscodeLaunch {
    /// macOS：/Applications 下的 .app 存在时填应用名（open -a）；否则 None
    pub app_name: Option<&'static str>,
    /// 直启入口：mac 的 code CLI / win 的 Code.exe（.app 未命中时的兜底）
    pub exec: Option<String>,
}

impl VscodeLaunch {
    pub fn detected(&self) -> bool {
        self.app_name.is_some() || self.exec.is_some()
    }
}

/// 探测 VSCode：
/// - mac：/Applications/Visual Studio Code.app，或 PATH 上的 code CLI
/// - win：用户级/系统级标准安装路径的 Code.exe，或 PATH 上的 code.cmd
pub fn find_vscode() -> VscodeLaunch {
    if is_mac() {
        if std::path::Path::new("/Applications/Visual Studio Code.app").exists() {
            return VscodeLaunch {
                app_name: Some("Visual Studio Code"),
                exec: None,
            };
        }
        VscodeLaunch {
            app_name: None,
            exec: find_cli("code"),
        }
    } else {
        // 安装器默认路径：用户级 %LOCALAPPDATA%\Programs、系统级 Program Files
        let local =
            std::env::var("LOCALAPPDATA").map(|d| format!(r"{d}\Programs\Microsoft VS Code\Code.exe"));
        let candidates = [
            local.ok(),
            std::env::var("ProgramFiles").ok().map(|d| format!(r"{d}\Microsoft VS Code\Code.exe")),
            std::env::var("ProgramFiles(x86)").ok().map(|d| format!(r"{d}\Microsoft VS Code\Code.exe")),
        ];
        let exe = candidates
            .into_iter()
            .flatten()
            .find(|p| std::path::Path::new(p).exists())
            .or_else(|| find_win_cli("code"));
        VscodeLaunch {
            app_name: None,
            exec: exe,
        }
    }
}

/// Git 打开工具条目（右键「Git 打开」折叠组）
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitToolItem {
    /// 稳定 id：gitbash / gitgui / github-desktop / sourcetree / fork / tower / gitkraken / sublime-merge
    pub id: String,
    pub name: String,
    pub detected: bool,
}

/// 从 PATH 上 git.exe 推导同一次安装的 git-bash.exe（cmd\git.exe → 仓库根 git-bash.exe）。
/// 与本文件其余探测一致跨平台编译（mac 上 PATH 无 git.exe 自然返回 None）。
fn git_bash_from_path_git() -> Option<String> {
    let git = find_win_cli("git")?;
    let root = std::path::Path::new(&git).ancestors().nth(2)?;
    let p = root.join("git-bash.exe");
    p.exists().then(|| p.to_string_lossy().into_owned())
}

/// Git Bash（git-bash.exe）：标准安装路径优先，再从 PATH git.exe 推导
pub fn find_git_bash() -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").map(|d| format!(r"{d}\Programs\Git\git-bash.exe"));
    let candidates = [
        Some(r"C:\Program Files\Git\git-bash.exe".to_string()),
        Some(r"C:\Program Files (x86)\Git\git-bash.exe".to_string()),
        local.ok(),
        git_bash_from_path_git(),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| std::path::Path::new(p).exists())
}

/// win：GitHub Desktop 的 Squirrel 安装位置（%LOCALAPPDATA%\GitHubDesktop）
pub fn find_github_desktop() -> Option<String> {
    let p = std::env::var("LOCALAPPDATA")
        .ok()
        .map(|d| format!(r"{d}\GitHubDesktop\GitHubDesktop.exe"))?;
    std::path::Path::new(&p).exists().then_some(p)
}

/// win：Sublime Merge（系统安装 + PATH 上的 smerge CLI）
pub fn find_sublime_merge() -> Option<String> {
    let pf = std::env::var("ProgramFiles")
        .ok()
        .map(|d| format!(r"{d}\Sublime Merge\sublime_merge.exe"));
    let candidates = [pf, find_win_cli("smerge")];
    candidates
        .into_iter()
        .flatten()
        .find(|p| std::path::Path::new(p).exists())
}

/// 「Git 打开」工具清单：按平台探测常用 Git 前端（检测不到的置灰，
/// 由前端隐藏已装项之外的概念——这里始终返回全量清单 + detected 标记）。
pub fn git_tool_items() -> Vec<GitToolItem> {
    if is_mac() {
        let app = |name: &str| {
            std::path::Path::new(&format!("/Applications/{name}.app")).exists()
        };
        vec![
            GitToolItem { id: "github-desktop".into(), name: "GitHub Desktop".into(), detected: app("GitHub Desktop") },
            GitToolItem { id: "fork".into(), name: "Fork".into(), detected: app("Fork") },
            GitToolItem { id: "tower".into(), name: "Tower".into(), detected: app("Tower") },
            GitToolItem { id: "sourcetree".into(), name: "Sourcetree".into(), detected: app("Sourcetree") },
            GitToolItem { id: "sublime-merge".into(), name: "Sublime Merge".into(), detected: app("Sublime Merge") },
            GitToolItem { id: "gitkraken".into(), name: "GitKraken".into(), detected: app("GitKraken") },
        ]
    } else {
        vec![
            GitToolItem {
                id: "gitbash".into(),
                name: "Git Bash".into(),
                detected: find_git_bash().is_some(),
            },
            GitToolItem {
                id: "gitgui".into(),
                name: "Git GUI".into(),
                detected: find_win_cli("git").is_some(),
            },
            GitToolItem {
                id: "github-desktop".into(),
                name: "GitHub Desktop".into(),
                detected: find_github_desktop().is_some(),
            },
            GitToolItem {
                id: "sublime-merge".into(),
                name: "Sublime Merge".into(),
                detected: find_sublime_merge().is_some(),
            },
            GitToolItem {
                id: "gitkraken".into(),
                name: "GitKraken".into(),
                detected: find_win_cli("gitkraken").is_some(),
            },
        ]
    }
}

/// 「常用工具条」编辑器探测目录（v0.29.0 设置页「检测到本机已安装」建议用）。
/// id 是稳定 slug（加入常用条后作为 quickTools 的 id，用于 VSCode 固定行去重等）；
/// exec 是可执行入口：mac = .app 路径（launch_custom 走 open -a），win = exe 路径。
#[derive(Serialize, Clone)]
pub struct EditorCandidate {
    pub id: &'static str,
    pub name: &'static str,
    pub exec: String,
}

fn app_in_applications(name: &str) -> Option<String> {
    let p = format!("/Applications/{name}.app");
    std::path::Path::new(&p).exists().then_some(p)
}

fn exe_at(paths: &[Option<String>]) -> Option<String> {
    paths
        .iter()
        .flatten()
        .find(|p| std::path::Path::new(p).exists())
        .cloned()
}

fn win_local(exe: &str) -> Option<String> {
    std::env::var("LOCALAPPDATA").ok().map(|d| format!(r"{d}\Programs\{exe}"))
}

fn win_pf(exe: &str) -> Option<String> {
    std::env::var("ProgramFiles").ok().map(|d| format!(r"{d}\{exe}"))
}

/// 探测本机常见编辑器（按平台目录表；探不到的项不出现）
pub fn editor_candidates() -> Vec<EditorCandidate> {
    if is_mac() {
        let mut out = Vec::new();
        for (id, name, app) in [
            ("vscode", "Visual Studio Code", "Visual Studio Code"),
            ("cursor", "Cursor", "Cursor"),
            ("zed", "Zed", "Zed"),
            ("sublime", "Sublime Text", "Sublime Text"),
            ("textmate", "TextMate", "TextMate"),
            ("coteditor", "CotEditor", "CotEditor"),
            ("macvim", "MacVim", "MacVim"),
            ("fleet", "Fleet", "Fleet"),
        ] {
            if let Some(exec) = app_in_applications(app) {
                out.push(EditorCandidate {
                    id,
                    name,
                    exec,
                });
            }
        }
        out
    } else {
        let mut out = Vec::new();
        let mut push = |id: &'static str, name: &'static str, exec: Option<String>| {
            if let Some(exec) = exec {
                out.push(EditorCandidate { id, name, exec });
            }
        };
        push("vscode", "Visual Studio Code", find_vscode().exec);
        push(
            "cursor",
            "Cursor",
            exe_at(&[win_local(r"cursor\Cursor.exe")]),
        );
        push(
            "zed",
            "Zed",
            exe_at(&[win_local(r"Zed\Zed.exe"), win_pf(r"Zed\Zed.exe")]),
        );
        push(
            "sublime",
            "Sublime Text",
            exe_at(&[
                win_pf(r"Sublime Text\sublime_text.exe"),
                win_local(r"Sublime Text\sublime_text.exe"),
            ]),
        );
        push(
            "notepad-plus-plus",
            "Notepad++",
            exe_at(&[
                win_pf(r"Notepad++\notepad++.exe"),
                std::env::var("ProgramFiles(x86)")
                    .ok()
                    .map(|d| format!(r"{d}\Notepad++\notepad++.exe")),
            ]),
        );
        push(
            "fleet",
            "Fleet",
            exe_at(&[win_local(r"Fleet\Fleet.exe")]),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_tools_ids_unique_per_platform() {
        let items = git_tool_items();
        assert!(!items.is_empty());
        let mut ids: Vec<_> = items.iter().map(|t| t.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), items.len());
    }

    #[test]
    fn git_tools_match_platform() {
        let items = git_tool_items();
        let ids: Vec<_> = items.iter().map(|t| t.id.as_str()).collect();
        if cfg!(target_os = "macos") {
            // Git Bash 是 Git for Windows 专属，mac 清单不应出现
            assert!(!ids.contains(&"gitbash"));
            assert!(ids.contains(&"fork"));
        } else {
            assert!(ids.contains(&"gitbash"));
            assert!(!ids.contains(&"fork"));
        }
    }

    #[test]
    fn editor_candidates_ids_unique_and_slugs_valid() {
        let items = editor_candidates();
        let mut ids: Vec<_> = items.iter().map(|c| c.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), items.len());
        for c in &items {
            assert!(!c.name.is_empty());
            // 探测到的入口必须真实存在（exec 是探测的产物，不该是悬空路径）
            assert!(std::path::Path::new(&c.exec).exists(), "{}", c.exec);
        }
        if cfg!(target_os = "windows") {
            // Notepad++ 仅出现在 Windows 目录表
            assert!(items.iter().all(|c| c.id != "coteditor"));
        } else {
            assert!(items.iter().all(|c| c.id != "notepad-plus-plus"));
        }
    }
}
