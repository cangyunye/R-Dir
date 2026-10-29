//! 地址栏命令执行（v0.22.0）。
//! 设计：
//! - 扫描范围 = 进程 env PATH ∪（macOS）常见兜底目录——GUI 应用从 launchd 拿到的
//!   PATH 常缺 /opt/homebrew/bin 等；索引持久化到配置目录，启动签名一致直接加载；
//! - 新鲜度 = 维护线程（后台/Windows 空闲优先级）每 TTL 一轮**哨兵抽查**：
//!   逐目录比对 mtime + 条目数 + 字母桶首尾名（纯枚举零 metadata，首个不一致
//!   短路）——无漂移零重建；有漂移后台全量重建（30ms 级），期间按旧记录补全；
//! - 补全只做前缀匹配（大小写不敏感、同名先到先得，与 shell PATH 语义一致），
//!   永不阻塞主线程（重建在后台线程，重建期间返回现有条目）；
//! - 执行 = 新开终端窗口 cd 到当前目录后执行用户输入的命令串（opener::launch），
//!   执行前先在 PATH 中校验首 token，未命中就地报错而不是开一个报错的终端；
//! - 插件注册表 gating（id = "cmdrun"）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 补全条目：命令名 + 命中的可执行文件完整路径
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggest {
    pub name: String,
    pub path: String,
}

/// 扫描缓存条目（含持久化：落盘到配置目录，启动直接加载免重扫）
#[derive(Serialize, Deserialize, Clone)]
struct ExecEntry {
    name: String,
    path: String,
}

/// 索引文件（app_config_dir/cmd-index.json）：{ 版本, PATH 签名, 条目, 哨兵表 }。
/// 启动时加载：签名与当前 PATH 一致 → 直接可用；之后由维护线程按哨兵漂移检测。
#[derive(Serialize, Deserialize)]
struct PersistedIndex {
    version: u32,
    sig: u64,
    items: Vec<ExecEntry>,
    sentinels: Vec<DirSentinel>,
}

/// 索引格式版本（结构变更时递增，旧文件按未命中处理）
const INDEX_VERSION: u32 = 2;
/// 索引文件名（app_config_dir 下）
pub const INDEX_FILE: &str = "cmd-index.json";

/// 可执行扫描缓存（AppState 持有 Arc；目录签名或 TTL 失效时**后台线程**重建，
/// 重建期间返回现有条目——补全命令本身永远不阻塞主线程）
#[derive(Default)]
pub struct ExecCache {
    items: Vec<ExecEntry>,
    /// 各 PATH 目录的变更哨兵（mtime/条目数/字母桶首尾名），供空闲期漂移检测
    sentinels: Vec<DirSentinel>,
    sig: u64,
    built_at: Option<Instant>,
    rebuilding: bool,
}

/// 单目录变更哨兵：目录 mtime + 条目总数 + 按首字母分桶（a-z + 其他）的
/// 排序首/尾文件名。纯枚举零 metadata（一次全表抽查 ≈ 只读遍历）；目录内
/// 增/删/改名必然改变其中至少一项。文件内容变化不感知也不需要感知。
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
struct DirSentinel {
    path: String,
    /// 目录最后写入时间（epoch 毫秒；目录不可读为 None）
    mtime_ms: Option<i64>,
    /// 条目总数（含非可执行——哨兵只关心名字层面的变化）
    count: u32,
    /// 27 个桶（0=特殊字符，1..=26=a-z）各自排序后的 [首名, 尾名]
    bounds: Vec<(Option<String>, Option<String>)>,
}

/// 哨兵桶数：0 = 特殊字符，1..=26 = a-z（大小写不敏感取首字符）
const SENTINEL_BUCKETS: usize = 27;

fn bucket_of(name_lower: &str) -> usize {
    match name_lower.chars().next() {
        Some(c @ 'a'..='z') => c as usize - 'a' as usize + 1,
        _ => 0,
    }
}

/// 枚举目录全部条目名（小写排序）→ 每桶首/尾名
fn bounds_of(names_lower_sorted: &[String]) -> Vec<(Option<String>, Option<String>)> {
    let mut bounds: Vec<(Option<String>, Option<String>)> =
        (0..SENTINEL_BUCKETS).map(|_| (None, None)).collect();
    for n in names_lower_sorted {
        let b = bucket_of(n);
        if bounds[b].0.is_none() {
            bounds[b].0 = Some(n.clone());
        }
        bounds[b].1 = Some(n.clone());
    }
    bounds
}

/// 单目录哨兵：一次 read_dir 枚举（无逐文件 metadata）+ 一次目录 mtime
fn sentinel_of(dir: &std::path::Path) -> DirSentinel {
    let mut names: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            names.push(e.file_name().to_string_lossy().to_lowercase());
        }
    }
    names.sort();
    let mtime_ms = std::fs::metadata(dir)
        .ok()
        .and_then(|md| md.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    DirSentinel {
        path: dir.to_string_lossy().to_string(),
        mtime_ms,
        count: names.len() as u32,
        bounds: bounds_of(&names),
    }
}

/// 漂移检测：逐目录比对哨兵（读一个比对一个，首个不一致即短路返回 true）。
/// 目录数/路径/顺序变化也算漂移。
fn drift(dirs: &[PathBuf], sentinels: &[DirSentinel]) -> bool {
    if dirs.len() != sentinels.len() {
        return true;
    }
    for (d, old) in dirs.iter().zip(sentinels) {
        let fresh = sentinel_of(d);
        if fresh.path != old.path || fresh != *old {
            return true;
        }
    }
    false
}

/// 缓存有效期：PATH 不变也定期后台重扫（新安装的工具最迟 10 分钟后可见）
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

/// 扫描单目录：可执行文件 → 条目；同名命令先到先得（与 shell PATH 顺序一致）。
/// Windows 用目录枚举自带的 file_type（零额外系统调用，实测全量 ~30ms），
/// 仅软链接回退 metadata 跟随目标；unix 需 metadata 看执行位（homebrew bin 多为软链）。
fn scan_dir(dir: &std::path::Path, out: &mut Vec<ExecEntry>, seen: &mut HashSet<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    #[cfg(windows)]
    let exts = pathext_list();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        #[cfg(windows)]
        let is_file = match e.file_type() {
            Ok(ft) if ft.is_symlink() => {
                std::fs::metadata(e.path()).map(|m| m.is_file()).unwrap_or(false)
            }
            Ok(ft) => ft.is_file(),
            Err(_) => false,
        } && pathext_match_list(&name, &exts);
        #[cfg(not(windows))]
        let is_file = {
            // metadata 跟随软链（homebrew bin 里多为指向 Cellar 的链接）
            match std::fs::metadata(e.path()) {
                Ok(md) => is_executable(&md, &name),
                Err(_) => false,
            }
        };
        if !is_file {
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

/// 索引文件路径（app_config_dir/cmd-index.json）；解析失败返回 None（仅内存缓存）
pub fn index_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(INDEX_FILE))
}

/// 从磁盘加载索引：文件存在、格式正确、PATH 签名与当前一致才采用。
/// 返回是否填充了缓存。
fn load_index(cache: &mut ExecCache, file: &Option<PathBuf>) -> bool {
    let Some(p) = file else { return false };
    let Ok(s) = std::fs::read_to_string(p) else {
        return false;
    };
    let Ok(idx) = serde_json::from_str::<PersistedIndex>(&s) else {
        return false;
    };
    if idx.version != INDEX_VERSION || idx.sig != dir_sig(&search_dirs()) {
        return false;
    }
    cache.items = idx.items;
    cache.sig = idx.sig;
    cache.built_at = Some(Instant::now());
    true
}

/// 写索引文件（tmp + rename 原子替换；失败静默——持久化只是加速，不可靠也能跑）
fn save_index(cache: &ExecCache, file: &Option<PathBuf>) {
    let Some(p) = file else { return };
    let idx = PersistedIndex {
        version: INDEX_VERSION,
        sig: cache.sig,
        items: cache.items.clone(),
        sentinels: cache.sentinels.clone(),
    };
    if let Ok(s) = serde_json::to_string(&idx) {
        // 失败静默——持久化只是加速，不可靠也能跑（错误文案占位不会被展示）
        let _ = crate::json_store::write_atomic(p, &s, "写入索引失败", "保存索引失败");
    }
}

/// 重建收尾：写入缓存 + 哨兵表 + 落盘（调用方已持锁）
fn commit_rebuild(cache: &mut ExecCache, dirs: &[PathBuf], file: &Option<PathBuf>) {
    cache.items = rebuild(dirs);
    cache.sentinels = dirs.iter().map(|d| sentinel_of(d)).collect();
    cache.sig = dir_sig(dirs);
    cache.built_at = Some(Instant::now());
    cache.rebuilding = false;
    save_index(cache, file);
}

/// 确保缓存新鲜：不新鲜且没有进行中的重建 → 交给后台线程重建，立即返回。
/// 重建期间补全返回现有条目（可能为空/过期），永不阻塞调用方（主线程）。
fn ensure_fresh(cache: &Arc<Mutex<ExecCache>>, file: &Option<PathBuf>) {
    let Ok(mut c) = cache.lock() else { return };
    let dirs_sig = dir_sig(&search_dirs());
    let fresh = c.built_at.is_some_and(|t| t.elapsed() < CACHE_TTL);
    if (fresh && c.sig == dirs_sig) || c.rebuilding {
        return;
    }
    c.rebuilding = true;
    drop(c);
    let arc = Arc::clone(cache);
    let file = file.clone();
    std::thread::spawn(move || {
        let dirs = search_dirs();
        let Ok(mut c) = arc.lock() else { return };
        commit_rebuild(&mut c, &dirs, &file);
    });
}

/// Windows 空闲优先级：维护线程只在 CPU 空闲时被调度，不与前台争抢
#[cfg(windows)]
fn set_idle_priority() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_IDLE,
    };
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_IDLE);
    }
}

#[cfg(not(windows))]
fn set_idle_priority() {}

/// 启动预热 + 常驻维护（后台线程，Windows 下空闲优先级）：
/// 1. 启动即校验一次——优先加载磁盘索引（PATH 签名一致 → 免扫描），无索引/签名
///    变化 → 重建并回写；
/// 2. 此后每 CACHE_TTL 一轮**哨兵抽查**：逐目录比对 mtime/条目数/字母桶首尾名
///    （纯枚举零 metadata，首个不一致即短路）——无漂移则顺延 TTL，零重建；
///    有漂移（PATH 下文件增删/改名/挪动）→ 后台重建并回写，期间补全按旧记录出结果。
/// 用户输入路径的 ensure_fresh 仅作为兜底（正常情况下维护线程已保持缓存新鲜）。
pub fn warm_cache_async(cache: Arc<Mutex<ExecCache>>, file: Option<PathBuf>, enabled: bool) {
    if !enabled {
        return;
    }
    std::thread::spawn(move || {
        set_idle_priority();
        loop {
            let dirs = search_dirs();
            let sig = dir_sig(&dirs);
            // 锁内只读状态做决策；哨兵枚举/重建的枚举阶段在锁外做,
            // 仅落缓存与写盘短暂持锁——补全调用的锁等待始终亚毫秒级
            enum Check {
                LoadOrRebuild,
                Rebuild,
                Extend(Vec<DirSentinel>),
                Skip,
            }
            let check = match cache.lock() {
                Ok(c) => {
                    if c.built_at.is_none() {
                        Check::LoadOrRebuild
                    } else if c.rebuilding {
                        Check::Skip
                    } else if c.sig != sig {
                        Check::Rebuild
                    } else {
                        Check::Extend(c.sentinels.clone())
                    }
                }
                Err(_) => Check::Skip,
            };
            match check {
                Check::Skip => {}
                Check::LoadOrRebuild => {
                    if let Ok(mut c) = cache.lock() {
                        if c.built_at.is_none() && !load_index(&mut c, &file) {
                            c.rebuilding = true;
                            commit_rebuild(&mut c, &dirs, &file);
                        }
                    }
                }
                Check::Rebuild => {
                    if let Ok(mut c) = cache.lock() {
                        if !c.rebuilding {
                            c.rebuilding = true;
                            commit_rebuild(&mut c, &dirs, &file);
                        }
                    }
                }
                Check::Extend(sentinels) => {
                    if drift(&dirs, &sentinels) {
                        if let Ok(mut c) = cache.lock() {
                            // ensure_fresh 兜底可能已先开重建：已在重建则跳过，防重复
                            if !c.rebuilding {
                                c.rebuilding = true;
                                commit_rebuild(&mut c, &dirs, &file);
                            }
                        }
                    } else if let Ok(mut c) = cache.lock() {
                        // 无漂移：顺延 TTL，本轮零重建
                        c.built_at = Some(Instant::now());
                    }
                }
            }
            std::thread::sleep(CACHE_TTL);
        }
    });
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

/// 地址栏命令补全：PATH 可执行前缀匹配（停用插件时返回空）。
/// 缓存不新鲜时只触发后台重建并立即返回现有条目——本命令永不阻塞主线程。
#[tauri::command]
pub fn complete_commands(
    app: tauri::AppHandle,
    prefix: String,
    state: tauri::State<'_, crate::AppState>,
) -> Vec<CommandSuggest> {
    if !crate::plugins::plugin_enabled(&state.plugins, "cmdrun") {
        return Vec::new();
    }
    let file = index_path(&app);
    ensure_fresh(&state.cmd_cache, &file);
    match state.cmd_cache.lock() {
        Ok(c) => filter_entries(&c.items, &prefix, MAX_SUGGEST),
        Err(_) => Vec::new(),
    }
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

    /// 索引落盘往返：save → load 采用；签名不匹配（PATH 变更）→ 拒绝采用
    #[test]
    fn persist_roundtrip_and_sig_mismatch() {
        let dir = std::env::temp_dir().join(format!("rdir-cmdtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = Some(dir.join("cmd-index.json"));

        let mut c = ExecCache::default();
        c.items = vec![ExecEntry {
            name: "git.exe".into(),
            path: "C:/tools/git.exe".into(),
        }];
        c.sig = dir_sig(&search_dirs());
        c.built_at = Some(Instant::now());
        save_index(&c, &file);

        let mut loaded = ExecCache::default();
        assert!(load_index(&mut loaded, &file), "签名一致应采用");
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].name, "git.exe");

        let bad = PersistedIndex {
            version: INDEX_VERSION,
            sig: 12345,
            items: Vec::new(),
            sentinels: Vec::new(),
        };
        std::fs::write(
            file.as_ref().unwrap(),
            serde_json::to_string(&bad).unwrap(),
        )
        .unwrap();
        let mut rejected = ExecCache::default();
        assert!(!load_index(&mut rejected, &file), "签名不匹配应拒绝");
        assert!(rejected.items.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 哨兵：目录内增/删/改名 → 至少一项变化；重扫未变更目录可跳过
    #[test]
    fn sentinel_detects_changes() {
        let base = std::env::temp_dir().join(format!("rdir-sentinel-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let write = |names: &[&str]| {
            for n in names {
                std::fs::write(base.join(n), b"x").unwrap();
            }
        };
        write(&["apple.exe", "banana.exe", "0tool.exe"]);
        let s1 = sentinel_of(&base);

        // 无变化：哨兵稳定（mtime 精度内的立即重读应一致）
        let s1b = sentinel_of(&base);
        assert_eq!(s1, s1b, "未变更目录哨兵应一致");
        assert_eq!(s1.count, 3);
        // 'a' 桶首尾=apple.exe（banana 落 b 桶）；'0' 开头落特殊字符桶
        assert_eq!(s1.bounds[1].0.as_deref(), Some("apple.exe"));
        assert_eq!(s1.bounds[1].1.as_deref(), Some("apple.exe"));
        assert_eq!(s1.bounds[2].0.as_deref(), Some("banana.exe"));
        assert_eq!(s1.bounds[0].0.as_deref(), Some("0tool.exe"));

        // 新增文件 → count 与所在桶尾变化
        write(&["cherry.exe"]);
        let s2 = sentinel_of(&base);
        assert_ne!(s1, s2);
        assert_eq!(s2.count, 4);
        assert_eq!(s2.bounds[3].1.as_deref(), Some("cherry.exe"));

        // 删除 → 名字集合与数量都回到初始状态，只剩目录 mtime 能区分；
        // 创建与删除可能落在同一时间戳刻度内（CI 上真实发生过：前后快照连
        // mtime_ms 都相同），先跨过 tick 再删，保证这条覆盖稳定
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::remove_file(base.join("cherry.exe")).unwrap();
        assert_ne!(s1, sentinel_of(&base));

        // 重命名（数量不变、mtime 可能精度内相同）：字母桶首/尾必须抓住
        std::fs::rename(base.join("banana.exe"), base.join("banana2.exe")).unwrap();
        let s3 = sentinel_of(&base);
        assert_ne!(s1, s3, "重命名应被哨兵捕获");
        assert_eq!(s3.count, 3);
        assert_eq!(s3.bounds[2].1.as_deref(), Some("banana2.exe"));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 漂移检测：目录数变化 → true；全部一致 → false
    #[test]
    fn drift_on_dir_count_change() {
        let dir = std::env::temp_dir().join(format!("rdir-drift-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dirs = vec![dir.clone()];
        let sents = dirs.iter().map(|d| sentinel_of(d)).collect::<Vec<_>>();
        assert!(!drift(&dirs, &sents));
        assert!(drift(&dirs, &[]), "目录数变化应判漂移");
        let _ = std::fs::remove_dir_all(&dir);
    }

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
