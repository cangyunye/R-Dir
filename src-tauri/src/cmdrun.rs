//! 地址栏命令执行（v0.22.0）。
//! 设计：
//! - 扫描范围 = 进程 env PATH ∪（macOS）常见兜底目录——GUI 应用从 launchd 拿到的
//!   PATH 常缺 /opt/homebrew/bin 等；进程内缓存，PATH 变化或超时自动重建；
//! - 补全只做前缀匹配（大小写不敏感、同名先到先得，与 shell PATH 语义一致）；
//! - 执行 = 新开终端窗口 cd 到当前目录后执行用户输入的命令串（opener::launch），
//!   执行前先在 PATH 中校验首 token，未命中就地报错而不是开一个报错的终端；
//! - 插件注册表 gating（id = "cmdrun"）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;

/// 补全条目：命令名 + 命中的可执行文件完整路径
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggest {
    pub name: String,
    pub path: String,
}

/// 扫描缓存条目
#[derive(Clone)]
struct ExecEntry {
    name: String,
    path: String,
}

/// 可执行扫描缓存（AppState 持有；目录签名或 TTL 失效时重建）
#[derive(Default)]
pub struct ExecCache {
    items: Vec<ExecEntry>,
    sig: u64,
    built_at: Option<Instant>,
}

/// 缓存有效期：PATH 不变也定期重扫（新安装的工具最迟 10 分钟后可见）
const CACHE_TTL: Duration = Duration::from_secs(600);
/// 单次补全返回上限
const MAX_SUGGEST: usize = 20;

/// macOS 常见兜底目录：Finder/启动台启动的 GUI 应用拿不到登录 shell 的 PATH
fn fallback_dirs() -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let mut v = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".cargo/bin"));
        v.push(home.join(".local/bin"));
        v.push(home.join("bin"));
    }
    v
}

/// 扫描目录列表：env PATH 拆分 + 兜底目录（存在且未包含才补），保序去重
fn search_dirs() -> Vec<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut out: Vec<PathBuf> = Vec::new();
    for d in std::env::var("PATH").unwrap_or_default().split(sep) {
        if d.is_empty() {
            continue;
        }
        let p = PathBuf::from(d);
        if !out.contains(&p) {
            out.push(p);
        }
    }
    for d in fallback_dirs() {
        if d.is_dir() && !out.contains(&d) {
            out.push(d);
        }
    }
    out
}

/// 目录列表签名：PATH 串或兜底目录集合变化 → 缓存重建
fn dir_sig(dirs: &[PathBuf]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for d in dirs {
        d.to_string_lossy().hash(&mut h);
    }
    h.finish()
}

/// Windows PATHEXT 扩展表（小写含点）；env 缺省用系统默认值
fn pathext_list() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    raw.split(';')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 纯函数：文件名是否命中 PATHEXT 扩展表（大小写不敏感，末尾匹配含点扩展名）
fn pathext_match_list(name: &str, exts: &[String]) -> bool {
    let lower = name.to_lowercase();
    exts.iter().any(|e| lower.ends_with(e.as_str()))
}

/// 可执行判定：unix 看任一执行位；win 看扩展名 ∈ PATHEXT
fn is_executable(md: &std::fs::Metadata, file_name: &str) -> bool {
    if !md.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        let _ = file_name;
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        pathext_match_list(file_name, &pathext_list())
    }
}

/// 扫描去重键：Windows 文件名不区分大小写（git.exe = GIT.EXE），unix 区分
fn dedupe_key(name: &str) -> String {
    if cfg!(windows) {
        name.to_lowercase()
    } else {
        name.to_string()
    }
}

/// 扫描单目录：可执行文件 → 条目；同名命令先到先得（与 shell PATH 顺序一致）
fn scan_dir(dir: &std::path::Path, out: &mut Vec<ExecEntry>, seen: &mut HashSet<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        // metadata 跟随软链（homebrew bin 里多为指向 Cellar 的链接）
        let Ok(md) = std::fs::metadata(e.path()) else {
            continue;
        };
        if !is_executable(&md, &name) {
            continue;
        }
        if seen.insert(dedupe_key(&name)) {
            out.push(ExecEntry {
                name,
                path: e.path().to_string_lossy().to_string(),
            });
        }
    }
}

/// 全量扫描：按目录顺序去重，结果按名称排序（补全顺序稳定）
fn rebuild(dirs: &[PathBuf]) -> Vec<ExecEntry> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for d in dirs {
        scan_dir(d, &mut out, &mut seen);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 取缓存条目（必要时重建）；加锁由调用方负责
fn cached_items(cache: &mut ExecCache) -> &[ExecEntry] {
    let dirs = search_dirs();
    let sig = dir_sig(&dirs);
    let fresh = cache.built_at.is_some_and(|t| t.elapsed() < CACHE_TTL);
    if !fresh || cache.sig != sig {
        cache.items = rebuild(&dirs);
        cache.sig = sig;
        cache.built_at = Some(Instant::now());
    }
    &cache.items
}

/// 纯函数：条目按前缀过滤（大小写不敏感）+ 截断
fn filter_entries(entries: &[ExecEntry], prefix: &str, max: usize) -> Vec<CommandSuggest> {
    let prefix = prefix.trim().to_lowercase();
    if prefix.is_empty() {
        return Vec::new();
    }
    entries
        .iter()
        .filter(|e| e.name.to_lowercase().starts_with(&prefix))
        .take(max)
        .map(|e| CommandSuggest {
            name: e.name.clone(),
            path: e.path.clone(),
        })
        .collect()
}

/// 命令名候选：Windows 依次尝试原名 + PATHEXT 各扩展（与 shell 解析顺序一致）
fn candidates(name: &str) -> Vec<String> {
    if !cfg!(windows) {
        return vec![name.to_string()];
    }
    let mut v = vec![name.to_string()];
    v.extend(pathext_list().iter().map(|e| format!("{name}{e}")));
    v
}

/// PATH 顺序解析命令名 → 可执行文件完整路径（校验执行位 / PATHEXT）
pub fn find_exec(name: &str) -> Option<String> {
    for dir in search_dirs() {
        for cand in candidates(name) {
            let p = dir.join(&cand);
            if let Ok(md) = std::fs::metadata(&p) {
                if is_executable(&md, &cand) {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// 引号感知 tokenize：单/双引号包裹的部分可含空格（`"a b"` → 一个 token）；
/// 引号未闭合时按到串尾处理，不出错（与 shell 宽松行为一致）
pub fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for ch in s.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                c if c.is_whitespace() => {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                }
                c => cur.push(c),
            },
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 地址栏命令补全：PATH 可执行前缀匹配（停用插件时返回空）
#[tauri::command]
pub fn complete_commands(
    prefix: String,
    state: tauri::State<'_, crate::AppState>,
) -> Vec<CommandSuggest> {
    if !crate::plugins::plugin_enabled(&state.plugins, "cmdrun") {
        return Vec::new();
    }
    let mut cache = state.cmd_cache.lock().unwrap();
    filter_entries(cached_items(&mut cache), &prefix, MAX_SUGGEST)
}

/// 地址栏命令执行：在指定目录新开终端窗口执行用户命令串。
/// 执行前先在 PATH 中校验首 token（未命中就地报错，不开报错终端）。
#[tauri::command]
pub fn run_command(
    input: String,
    cwd: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if !crate::plugins::plugin_enabled(&state.plugins, "cmdrun") {
        return Err("“地址栏命令”插件已禁用（设置 → 插件中可重新启用）".into());
    }
    let input = input.trim();
    if input.is_empty() {
        return Err("命令为空".into());
    }
    let tokens = tokenize(input);
    let Some(first) = tokens.first() else {
        return Err("命令为空".into());
    };
    if first.contains('/') || first.contains('\\') || first.contains(':') {
        return Err(format!("未找到命令：{first}"));
    }
    find_exec(first).ok_or_else(|| format!("未找到命令：{first}（不在 PATH 中）"))?;
    crate::opener::launch::exec_in_terminal(input, &cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_splits_on_whitespace() {
        assert_eq!(tokenize("git status"), vec!["git", "status"]);
        assert_eq!(tokenize("  ls   -la  "), vec!["ls", "-la"]);
        assert_eq!(tokenize(""), Vec::<String>::new());
    }

    #[test]
    fn tokenize_honors_quotes() {
        assert_eq!(
            tokenize("echo \"hello world\" x"),
            vec!["echo", "hello world", "x"]
        );
        assert_eq!(tokenize("echo 'a b' \"c\""), vec!["echo", "a b", "c"]);
    }

    #[test]
    fn tokenize_unclosed_quote_takes_rest() {
        assert_eq!(tokenize("echo \"unclosed"), vec!["echo", "unclosed"]);
    }

    #[test]
    fn pathext_match_case_insensitive_and_dotted() {
        let exts: Vec<String> = [".com", ".exe", ".bat", ".cmd"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(pathext_match_list("GIT.EXE", &exts));
        assert!(pathext_match_list("tool.cmd", &exts));
        assert!(!pathext_match_list("readme.txt", &exts));
        // 无点前缀不算命中（gitexe 不匹配 .exe）
        assert!(!pathext_match_list("gitexe", &exts));
    }

    #[cfg(unix)]
    #[test]
    fn executable_bit_filter() {
        let dir = std::env::temp_dir().join(format!("rdir-cmdrun-bit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let yes = dir.join("yes-cmd");
        let no = dir.join("no-cmd");
        std::fs::write(&yes, b"#!/bin/sh\n").unwrap();
        std::fs::write(&no, b"not exec").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&yes, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&no, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(is_executable(&std::fs::metadata(&yes).unwrap(), "yes-cmd"));
        assert!(!is_executable(&std::fs::metadata(&no).unwrap(), "no-cmd"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn scan_dir_first_wins_and_skips_hidden() {
        let base = std::env::temp_dir().join(format!("rdir-cmdrun-dedup-{}", std::process::id()));
        let d1 = base.join("d1");
        let d2 = base.join("d2");
        for d in [&d1, &d2] {
            std::fs::create_dir_all(d).unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        let mk = |dir: &std::path::Path, name: &str, mode: u32| {
            let p = dir.join(name);
            std::fs::write(&p, b"#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            p
        };
        mk(&d1, "dup", 0o755);
        mk(&d2, "dup", 0o755); // 同名：d1 先到先得
        mk(&d2, "only-d2", 0o755);
        mk(&d2, ".hidden", 0o755); // 隐藏文件跳过

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        scan_dir(&d1, &mut out, &mut seen);
        scan_dir(&d2, &mut out, &mut seen);

        let dup = out.iter().filter(|e| e.name == "dup").collect::<Vec<_>>();
        assert_eq!(dup.len(), 1, "同名命令只保留先扫到的");
        assert_eq!(
            dup[0].path,
            d1.join("dup").to_string_lossy().to_string(),
            "先到的目录胜出"
        );
        assert!(out.iter().any(|e| e.name == "only-d2"));
        assert!(!out.iter().any(|e| e.name == ".hidden"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn filter_entries_case_insensitive_prefix_and_cap() {
        let mk = |name: &str, path: &str| ExecEntry {
            name: name.into(),
            path: path.into(),
        };
        let mut entries: Vec<ExecEntry> = (1..=30)
            .map(|i| mk(&format!("git{i:02}"), &format!("/bin/git{i:02}")))
            .collect();
        entries.push(mk("GIT-UPPER", "/bin/git-upper"));
        entries.push(mk("zzz", "/bin/zzz"));

        let out = filter_entries(&entries, "Git", 20);
        assert_eq!(out.len(), 20, "31 个 git 前缀命中（大小写不敏感）→ 截断 20");
        assert!(out.iter().all(|s| s.name.to_lowercase().starts_with("git")));
        assert_eq!(filter_entries(&entries, "zzz", 20)[0].name, "zzz");
        assert!(filter_entries(&entries, "", 20).is_empty());
    }

    #[test]
    fn find_exec_rejects_nonexistent() {
        assert!(find_exec("definitely-not-exist-xyz-9182").is_none());
    }
}
