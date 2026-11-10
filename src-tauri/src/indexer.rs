//! 全盘索引（rdir-index crate）的主程序集成：后台维护线程 + 配置 + 状态。
//!
//! 生命周期：GUI 在 setup 启动（indexer::init），web 桥首条 index_* 命令惰性启动
//! （indexer::ensure）——同一进程只有一份实例（OnceLock）。后台线程职责：
//! - 启动优先加载快照（<1s 恢复可查）；无快照/指纹不符 → 全量构建（空闲节流）；
//! - 之后增量重扫（rdir-index 的 mtime 剪枝：无变化零成本返回 None），触发时机
//!   二选一：例行（rescan_interval_secs 可配，0=关闭例行）或事件驱动（notify
//!   内核监视置脏 → 安静 quiet_ms 后重扫，秒级进索引；监视失败自动退回例行）；
//! - 有变更/全量重建完成 → 快照原子落盘，下一秒启动即可秒级恢复；
//! - 「重建」命令置 wants_full 旗标，线程 ≤ poll_ms 内响应。
//!
//! 并发模型：EngineState 不可变整体换入 `RwLock<Arc<Option<EngineState>>>`；
//! 查询 clone Arc 即释锁，构建期间旧状态继续可查（首建期间为 None → 空结果，
//! 前端据 index_status 显示「构建中」）。
//!
//! 监视器资源语义：空闲（无文件活动）0% CPU / 0 磁盘 IO（内核推送，线程阻塞
//! 等待），内存 <1MB；事件回调仅两次原子写，风暴免疫；事件 Err（溢出/停止）
//! 同样置脏——可能漏了事件，靠重扫对账。

use crate::plugins;
use rdir_index::{
    load_snapshot, roots_fingerprint, save_snapshot, EngineState, Exclusions, MatchMode, Snapshot,
};
/// 命令返回类型经本模块透出（lib.rs / bridge 引用 indexer::IndexHit）
pub use rdir_index::IndexHit;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 配置文件（config_dir/index.json：roots + 排除清单 + 扫描选项，前端设置分区读写）
const INDEX_CONFIG_FILE: &str = "index.json";
/// 快照目录/文件（config_dir/index/snapshot.bin；索引是可重建缓存，与 thumbs 同级语义）
const SNAP_SUBDIR: &str = "index";
const SNAP_FILE: &str = "snapshot.bin";
/// 例行重扫默认间隔（10 分钟；可配，0 = 仅事件触发）
const DEFAULT_RESCAN_SECS: u64 = 600;
/// 事件防抖安静期（默认 3s）：外部批量操作（git checkout / npm install）停手后才重扫
const DEFAULT_QUIET_MS: u64 = 3000;
/// 后台轮询间隔（检查开关/重建请求/脏标志/重扫到点，全部是廉价检查）
const DEFAULT_POLL_MS: u64 = 2000;

/// phase 取值（AtomicU8）
const PHASE_DISABLED: u8 = 0;
const PHASE_BUILDING: u8 = 1;
const PHASE_READY: u8 = 2;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ==================== 配置 ====================

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexConfigFile {
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub exclusions: Vec<String>,
    /// 例行重扫间隔秒（默认 600；0 = 仅事件触发，关闭例行重扫）
    #[serde(default = "default_rescan_secs")]
    pub rescan_interval_secs: u64,
    /// 实时监视开关（notify 内核事件；失败自动降级为仅例行扫描）
    #[serde(default = "default_true")]
    pub watch_enabled: bool,
}

fn default_rescan_secs() -> u64 {
    DEFAULT_RESCAN_SECS
}
fn default_true() -> bool {
    true
}

impl Default for IndexConfigFile {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            exclusions: Vec::new(),
            rescan_interval_secs: DEFAULT_RESCAN_SECS,
            watch_enabled: true,
        }
    }
}

/// 默认索引根：Windows = 所有本地固定盘；macOS = 根卷（排除系统目录与挂载点，
/// 外置盘/网络卷由用户显式添加）；其余平台为空。
pub fn default_roots() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        crate::volumes::list_volumes()
            .into_iter()
            .filter(|v| v.kind == "fixed")
            .map(|v| v.path)
            .collect()
    }
    #[cfg(target_os = "macos")]
    {
        vec!["/".to_string()]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}

/// 默认排除清单：系统目录 / 回收站 / 卷挂载点（防 /Volumes 下的重复索引与网络卷）
pub fn default_exclusions() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        vec![
            "/System".to_string(),
            "/private".to_string(),
            "/Volumes".to_string(),
            "/dev".to_string(),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        crate::volumes::list_volumes()
            .into_iter()
            .filter(|v| v.kind == "fixed")
            .flat_map(|v| {
                let p = v.path.trim_end_matches(['\\', '/']).to_string();
                vec![
                    format!("{p}\\$Recycle.Bin"),
                    format!("{p}\\System Volume Information"),
                ]
            })
            .collect()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}

/// 载入配置；文件缺失或 roots 为空时落一份默认值（首次启动即写盘，设置分区可见）
pub fn load_config(config_dir: &Path) -> IndexConfigFile {
    let path = config_dir.join(INDEX_CONFIG_FILE);
    let loaded: Option<IndexConfigFile> = crate::json_store::read_json(&path, "读索引配置失败", "解析索引配置失败")
        .ok()
        .flatten();
    match loaded {
        Some(cfg) if !cfg.roots.is_empty() => cfg,
        _ => {
            let cfg = IndexConfigFile {
                roots: default_roots(),
                exclusions: default_exclusions(),
                rescan_interval_secs: DEFAULT_RESCAN_SECS,
                watch_enabled: true,
            };
            save_config(config_dir, &cfg).ok();
            cfg
        }
    }
}

pub fn save_config(config_dir: &Path, cfg: &IndexConfigFile) -> Result<(), String> {
    let path = config_dir.join(INDEX_CONFIG_FILE);
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    crate::json_store::write_atomic(&path, &body, "写索引配置失败", "保存索引配置失败")
}

// ==================== 状态视图 / 查询结果 ====================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusView {
    /// disabled / building / ready
    pub phase: &'static str,
    pub entries: usize,
    /// 上次扫描完成时间（Unix 毫秒；0 = 从未）
    pub last_scan_ms: i64,
    /// 上次扫描耗时（毫秒）
    pub last_duration_ms: i64,
    /// 枚举期跳过的错误数（权限/消失等）
    pub errors: u64,
    /// 当前生效的 roots（默认值会写回配置文件，这里原样透出）
    pub roots: Vec<String>,
    pub exclusions: Vec<String>,
    /// 实时监视是否已配置开启
    pub watch_enabled: bool,
    /// 实时监视是否实际挂上（false 且 watch_enabled=true = 降级：例行扫描兜底）
    pub watch: bool,
    /// 例行重扫间隔秒（0 = 仅事件触发）
    pub rescan_interval_secs: u64,
}

// ==================== 索引器 ====================

pub struct Indexer {
    config_dir: PathBuf,
    /// 当前可查状态；None = 尚未构建
    state: RwLock<Arc<Option<EngineState>>>,
    phase: AtomicU8,
    /// 插件启用旗标（由命令层 sync_enabled 同步；后台线程据此决定是否构建）
    enabled: AtomicBool,
    /// 手动「重建索引」请求（全量）
    wants_full: AtomicBool,
    last_scan_ms: AtomicI64,
    last_duration_ms: AtomicI64,
    errors: AtomicU64,
    /// 事件脏标志 + 最后一次事件时刻（notify 回调仅写这两个原子量）
    dirty: AtomicBool,
    dirty_at: AtomicI64,
    /// 监视器是否至少挂上一个 root（false 且 watch_enabled = 降级态）
    watch_ok: AtomicBool,
    /// 配置缓存（线程每轮读取；set_config 更新缓存 + 落盘）
    cfg: Mutex<IndexConfigFile>,
    /// 可测性：事件防抖安静期 / 轮询间隔（生产默认 3000 / 2000，测试传短值）
    quiet_ms: u64,
    poll_ms: u64,
}

static INDEXER: OnceLock<Arc<Indexer>> = OnceLock::new();

/// 惰性启动（GUI setup 与 web 桥共用；同进程仅一份）。
/// `enabled` 为启动瞬间的插件开关（后台线程由命令层持续同步）。
pub fn ensure(config_dir: &Path, enabled: bool) -> &'static Arc<Indexer> {
    INDEXER.get_or_init(|| Indexer::init(config_dir.to_path_buf(), enabled))
}

/// 已启动则取实例（未启动返回 None——命令层先 ensure 再用）
pub fn shared() -> Option<&'static Arc<Indexer>> {
    INDEXER.get()
}

impl Indexer {
    fn init(config_dir: PathBuf, enabled: bool) -> Arc<Indexer> {
        Indexer::new(config_dir, enabled, DEFAULT_POLL_MS, DEFAULT_QUIET_MS)
    }

    fn new(config_dir: PathBuf, enabled: bool, poll_ms: u64, quiet_ms: u64) -> Arc<Indexer> {
        let cfg = load_config(&config_dir);
        let idx = Arc::new(Indexer {
            config_dir,
            state: RwLock::new(Arc::new(None)),
            phase: AtomicU8::new(if enabled { PHASE_BUILDING } else { PHASE_DISABLED }),
            enabled: AtomicBool::new(enabled),
            wants_full: AtomicBool::new(false),
            last_scan_ms: AtomicI64::new(0),
            last_duration_ms: AtomicI64::new(0),
            errors: AtomicU64::new(0),
            dirty: AtomicBool::new(false),
            dirty_at: AtomicI64::new(0),
            watch_ok: AtomicBool::new(false),
            cfg: Mutex::new(cfg),
            quiet_ms,
            poll_ms,
        });
        let thread_idx = idx.clone();
        // 8MB 栈：增量重扫的递归下探深度受路径长度约束，留足余量
        let _ = std::thread::Builder::new()
            .name("rdir-indexer".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || thread_loop(thread_idx));
        idx
    }

    /// 命令层把插件开关同步进来（设置分区/搜索面板/插件开关路径都会轮询状态）
    pub fn sync_enabled(&self, state: &plugins::PluginState) {
        let on = plugins::plugin_enabled(state, "index-search");
        self.enabled.store(on, Ordering::Relaxed);
        if !on {
            self.phase.store(PHASE_DISABLED, Ordering::Relaxed);
        }
    }

    pub fn status(&self) -> IndexStatusView {
        let st = self.state.read().unwrap().clone();
        let phase = match self.phase.load(Ordering::Relaxed) {
            PHASE_READY => "ready",
            PHASE_BUILDING => "building",
            _ => "disabled",
        };
        let cfg = self.cfg.lock().unwrap().clone();
        let entries = match st.as_ref() {
            Some(s) => s.len(),
            None => 0,
        };
        IndexStatusView {
            phase,
            entries,
            last_scan_ms: self.last_scan_ms.load(Ordering::Relaxed),
            last_duration_ms: self.last_duration_ms.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            roots: cfg.roots,
            exclusions: cfg.exclusions,
            watch_enabled: cfg.watch_enabled,
            watch: cfg.watch_enabled && self.watch_ok.load(Ordering::Relaxed),
            rescan_interval_secs: cfg.rescan_interval_secs,
        }
    }

    /// 查询（构建中返回空结果，前端据 status 显示「索引构建中」）
    pub fn query(
        &self,
        query: &str,
        case_sensitive: bool,
        glob: bool,
        regex: bool,
        is_dir: Option<bool>,
    ) -> Result<Vec<IndexHit>, String> {
        let mode = if glob {
            MatchMode::Glob
        } else if regex {
            MatchMode::Regex
        } else {
            MatchMode::Contains
        };
        let st = self.state.read().unwrap().clone();
        match st.as_ref() {
            None => Ok(Vec::new()),
            Some(s) => s.query(query, mode, case_sensitive, is_dir),
        }
    }

    /// 手动全量重建（≤ poll_ms 内被后台线程响应）
    pub fn rebuild(&self) {
        self.wants_full.store(true, Ordering::Relaxed);
    }

    pub fn get_config(&self) -> IndexConfigFile {
        self.cfg.lock().unwrap().clone()
    }

    /// 更新 roots/排除清单/扫描选项：落盘 + 更新缓存；指纹/选项变化由后台线程
    /// 每轮检测（监视器随 watch_enabled 与 roots 指纹自动重建，间隔即时生效）
    pub fn set_config(
        &self,
        roots: Vec<String>,
        exclusions: Vec<String>,
        rescan_interval_secs: u64,
        watch_enabled: bool,
    ) -> Result<(), String> {
        // 间隔合法性：仅接受预设档位（0/60/300/600/1800），其余回落默认
        let interval = match rescan_interval_secs {
            0 | 60 | 300 | 600 | 1800 => rescan_interval_secs,
            _ => DEFAULT_RESCAN_SECS,
        };
        save_config(
            &self.config_dir,
            &IndexConfigFile {
                roots: roots.clone(),
                exclusions: exclusions.clone(),
                rescan_interval_secs: interval,
                watch_enabled,
            },
        )?;
        *self.cfg.lock().unwrap() = IndexConfigFile {
            roots,
            exclusions,
            rescan_interval_secs: interval,
            watch_enabled,
        };
        Ok(())
    }

    fn snap_path(&self) -> PathBuf {
        self.config_dir.join(SNAP_SUBDIR).join(SNAP_FILE)
    }

    /// 换入新状态（错误计数由调用方在 swap 前显式写入，这里不动——
    /// 增量重扫沿用上次的错误数）
    fn swap(&self, st: EngineState) {
        self.last_scan_ms.store(now_ms(), Ordering::Relaxed);
        self.phase.store(PHASE_READY, Ordering::Relaxed);
        *self.state.write().unwrap() = Arc::new(Some(st));
    }
}

/// 重扫时机判定（纯函数，便于真值表单测）：
/// - 事件驱动：脏且距最后事件已安静 `quiet_ms`（防抖：批量操作停手才动）；
/// - 例行：`interval_secs > 0` 且距上次重扫到期（None = 从未重扫 → 立即到期）。
fn should_rescan(
    dirty: bool,
    dirty_at_ms: i64,
    now_ms: i64,
    quiet_ms: u64,
    interval_secs: u64,
    since_rescan: Option<Duration>,
) -> bool {
    if dirty && now_ms - dirty_at_ms >= quiet_ms as i64 {
        return true;
    }
    if interval_secs > 0 && since_rescan.map_or(true, |t| t >= Duration::from_secs(interval_secs)) {
        return true;
    }
    false
}

/// 事件回调（notify v7）：仅置脏 + 记时刻，零分配——风暴免疫。
/// Access/Other 事件不置脏：Linux inotify 会把「读取」当事件上报，若不过滤，
/// 自家重扫的 stat 会喂回脏标志形成自我反馈循环；macOS FSEvents / Windows
/// ReadDirectoryChangesW 本就不产生 Access 事件，过滤只为 Linux 一致性。
fn on_watch_event(idx: &Indexer, res: Result<notify::Event, notify::Error>) {
    let relevant = match &res {
        Ok(ev) => !matches!(ev.kind, notify::EventKind::Access(_) | notify::EventKind::Other),
        Err(_) => true, // 溢出/停止：可能漏事件，置脏靠重扫对账
    };
    if !relevant {
        return;
    }
    if let Err(e) = &res {
        eprintln!("indexer 监视事件异常（已置脏，等待重扫对账）：{e}");
    }
    idx.dirty.store(true, Ordering::Relaxed);
    idx.dirty_at.store(now_ms(), Ordering::Relaxed);
}

/// 挂监视器：逐 root 递归监视；至少一个成功即算挂上（watch_ok）。
/// root 不存在/无权限 → 跳过（FSEvents 受 TCC 限权时自然走这里 → 降级态）。
fn spawn_watcher(idx: &Arc<Indexer>, roots: &[String]) -> Option<notify::RecommendedWatcher> {
    use notify::Watcher;
    let cb_idx = Arc::clone(idx);
    let mut watcher = match notify::recommended_watcher(move |res| on_watch_event(&cb_idx, res)) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("indexer 监视器创建失败（降级为仅例行扫描）：{e}");
            idx.watch_ok.store(false, Ordering::Relaxed);
            return None;
        }
    };
    let mut ok = false;
    for r in roots {
        let p = Path::new(r);
        if p.is_dir() {
            if let Err(e) = watcher.watch(p, notify::RecursiveMode::Recursive) {
                eprintln!("indexer 监视 {r} 失败（跳过）：{e}");
            } else {
                ok = true;
            }
        }
    }
    idx.watch_ok.store(ok, Ordering::Relaxed);
    if ok {
        Some(watcher)
    } else {
        None
    }
}

/// 后台主循环
fn thread_loop(idx: Arc<Indexer>) {
    let mut last_rescan: Option<Instant> = None;
    // 监视器句柄（drop = 停止监视）；签名为 (roots指纹, watch_enabled)，
    // 任一变化即重建（重新挂 root 集合）
    let mut watcher: Option<notify::RecommendedWatcher> = None;
    let mut watch_sig: Option<(u64, bool)> = None;
    loop {
        std::thread::sleep(Duration::from_millis(idx.poll_ms));
        if !idx.enabled.load(Ordering::Relaxed) {
            idx.phase.store(PHASE_DISABLED, Ordering::Relaxed);
            if watcher.is_some() {
                watcher = None;
                watch_sig = None;
                idx.watch_ok.store(false, Ordering::Relaxed);
            }
            continue;
        }
        let cfg = idx.cfg.lock().unwrap().clone();
        let excl = Exclusions::new(&cfg.exclusions);
        let fp = roots_fingerprint(&cfg.roots, &cfg.exclusions);

        let cur = idx.state.read().unwrap().clone();
        match cur.as_ref() {
            None => {
                // 首建：优先快照（<1s），否则全量构建（可能数分钟，期间可查为空）
                idx.phase.store(PHASE_BUILDING, Ordering::Relaxed);
                let t0 = Instant::now();
                if let Some(st) = load_snapshot(&idx.snap_path()) {
                    if st.roots_fp == fp {
                        idx.errors.store(0, Ordering::Relaxed);
                        idx.last_scan_ms.store(now_ms(), Ordering::Relaxed);
                        idx.last_duration_ms.store(t0.elapsed().as_millis() as i64, Ordering::Relaxed);
                        idx.phase.store(PHASE_READY, Ordering::Relaxed);
                        *idx.state.write().unwrap() = Arc::new(Some(st));
                        last_rescan = Some(Instant::now());
                        continue;
                    }
                }
                let (st, errs) = EngineState::build_full(&cfg.roots, &excl);
                idx.errors.store(errs, Ordering::Relaxed);
                idx.last_duration_ms.store(t0.elapsed().as_millis() as i64, Ordering::Relaxed);
                idx.swap(st);
                persist(&idx);
                last_rescan = Some(Instant::now());
            }
            Some(st) => {
                // ---- 监视器维护：有状态且开关开 → 按 (指纹, 开关) 签名重建 ----
                let sig = (fp, cfg.watch_enabled);
                if cfg.watch_enabled && watch_sig != Some(sig) {
                    watcher = spawn_watcher(&idx, &cfg.roots);
                    watch_sig = Some(sig);
                } else if !cfg.watch_enabled && watcher.is_some() {
                    watcher = None;
                    watch_sig = None;
                    idx.watch_ok.store(false, Ordering::Relaxed);
                }

                let do_full = st.roots_fp != fp || idx.wants_full.swap(false, Ordering::Relaxed);
                if do_full {
                    // 配置变化 / 手动重建：全量重建（swap 前旧状态继续可查）
                    idx.phase.store(PHASE_BUILDING, Ordering::Relaxed);
                    let t0 = Instant::now();
                    let (new, errs) = EngineState::build_full(&cfg.roots, &excl);
                    idx.errors.store(errs, Ordering::Relaxed);
                    idx.last_duration_ms.store(t0.elapsed().as_millis() as i64, Ordering::Relaxed);
                    idx.swap(new);
                    persist(&idx);
                    last_rescan = Some(Instant::now());
                } else if should_rescan(
                    idx.dirty.load(Ordering::Relaxed),
                    idx.dirty_at.load(Ordering::Relaxed),
                    now_ms(),
                    idx.quiet_ms,
                    cfg.rescan_interval_secs,
                    last_rescan.map(|t| t.elapsed()),
                ) {
                    // 事件驱动 / 例行增量：无变化时 rescan 返回 None，零成本
                    if let Some(new) = EngineState::rescan(st, &cfg.roots, &excl) {
                        idx.swap(new);
                        persist(&idx);
                    }
                    idx.dirty.store(false, Ordering::Relaxed);
                    idx.dirty_at.store(0, Ordering::Relaxed);
                    idx.last_scan_ms.store(now_ms(), Ordering::Relaxed);
                    last_rescan = Some(Instant::now());
                }
            }
        }
    }
}

/// 快照落盘（失败只影响下次启动的速度，不影响当前可查——静默容忍）
fn persist(idx: &Indexer) {
    let st = idx.state.read().unwrap().clone();
    if let Some(s) = st.as_ref() {
        let snap = Snapshot::from_state(s);
        save_snapshot(&idx.snap_path(), &snap).ok();
    }
}

/// 搜索命令的共享执行体（GUI 与 web 桥同构）：插件门禁 + 后台线程查询。
/// 结果上限 MAX_HITS=500（rdir-index 内常量），与 fd 引擎展示口径一致；
/// gram 交集查询亚毫秒级，无需 spawn_blocking。
pub fn search_checked(
    plugins_state: &plugins::PluginState,
    indexer: &Indexer,
    query: &str,
    case_sensitive: bool,
    glob: bool,
    regex: bool,
    is_dir: Option<bool>,
) -> Result<Vec<IndexHit>, String> {
    if !plugins::plugin_enabled(plugins_state, "index-search") {
        return Err("INDEX_DISABLED|全盘索引未启用：请在 设置 → 插件 中开启".into());
    }
    indexer.sync_enabled(plugins_state);
    indexer.query(query, case_sensitive, glob, regex, is_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_rescan_truth_table() {
        // 干净且未到期：不扫
        assert!(!should_rescan(false, 0, 10_000, 3_000, 600, Some(Duration::from_secs(1))));
        // 脏但未安静（最后事件距今 < quiet）：不扫（防抖）
        assert!(!should_rescan(true, 9_000, 10_000, 3_000, 600, Some(Duration::from_secs(1))));
        // 脏且已安静：扫
        assert!(should_rescan(true, 6_000, 10_000, 3_000, 600, Some(Duration::from_secs(1))));
        // 干净但例行到期：扫
        assert!(should_rescan(false, 0, 10_000, 3_000, 60, Some(Duration::from_secs(61))));
        // 干净、未到期：不扫
        assert!(!should_rescan(false, 0, 10_000, 3_000, 60, Some(Duration::from_secs(59))));
        // 仅事件模式（interval=0）：干净时不扫，脏且安静时照扫
        assert!(!should_rescan(false, 0, 10_000, 3_000, 0, None));
        assert!(should_rescan(true, 0, 10_000, 3_000, 0, None));
        // 从未重扫且例行开：立即到期
        assert!(should_rescan(false, 0, 10_000, 3_000, 600, None));
    }

    /// 配置 serde default 兼容：旧版 index.json（缺新字段）读入即得默认值
    #[test]
    fn config_defaults_for_legacy_file() {
        let dir = std::env::temp_dir().join(format!("rdir_indexer_cfg_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(INDEX_CONFIG_FILE),
            r#"{"roots":["/tmp/x"],"exclusions":[]}"#,
        )
        .unwrap();
        let cfg = load_config(&dir);
        assert_eq!(cfg.roots, vec!["/tmp/x".to_string()]);
        assert_eq!(cfg.rescan_interval_secs, DEFAULT_RESCAN_SECS);
        assert!(cfg.watch_enabled);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 端到端（真实 FS + 真实内核监视器）：外部新增 → 秒级进索引 → 外部删除 → 秒级出索引。
    /// 全程短间隔（poll 50ms / quiet 200ms），总超时 10s/步。
    #[test]
    fn watcher_picks_up_external_changes() {
        let root = std::env::temp_dir().join(format!("rdir_indexer_watch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("base.txt"), "b").unwrap();

        // 预写配置（roots 指向测试目录），再构造短间隔 Indexer
        let cfg_dir = std::env::temp_dir().join(format!("rdir_indexer_cfg_w_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cfg_dir);
        std::fs::create_dir_all(&cfg_dir).unwrap();
        save_config(&cfg_dir, &IndexConfigFile {
            roots: vec![root.to_string_lossy().into_owned()],
            exclusions: vec![],
            rescan_interval_secs: 0, // 关例行：本测试只验事件驱动路径
            watch_enabled: true,
        })
        .unwrap();
        let idx = Indexer::new(cfg_dir.clone(), true, 50, 200);

        // 等首次全量就绪
        let deadline = Instant::now() + Duration::from_secs(10);
        while idx.status().phase != "ready" {
            assert!(Instant::now() < deadline, "首次构建超时");
            std::thread::sleep(Duration::from_millis(50));
        }
        // 监视器在就绪后的下一轮循环挂上（≤ poll_ms），轮询等待
        let deadline = Instant::now() + Duration::from_secs(10);
        while !idx.status().watch {
            assert!(Instant::now() < deadline, "监视器未挂上（测试目录在本地 APFS 上）");
            std::thread::sleep(Duration::from_millis(50));
        }

        // 外部新增 → 事件驱动重扫 → 可查
        std::fs::write(root.join("外部新增.txt"), "x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let hits = idx.query("外部新增", false, false, false, None).unwrap();
            if hits.len() == 1 {
                break;
            }
            assert!(Instant::now() < deadline, "外部新增未在 10s 内进索引");
            std::thread::sleep(Duration::from_millis(100));
        }

        // 外部新建子目录树 → 整树收录
        let sub = root.join("新建目录");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("深层.txt"), "y").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let hits = idx.query("深层", false, false, false, None).unwrap();
            if hits.len() == 1 {
                break;
            }
            assert!(Instant::now() < deadline, "外部新建子树未在 10s 内进索引");
            std::thread::sleep(Duration::from_millis(100));
        }

        // 外部删除 → 秒级出索引
        std::fs::remove_file(root.join("外部新增.txt")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let hits = idx.query("外部新增", false, false, false, None).unwrap();
            if hits.is_empty() {
                break;
            }
            assert!(Instant::now() < deadline, "外部删除未在 10s 内出索引");
            std::thread::sleep(Duration::from_millis(100));
        }

        // 例行已关（interval=0）：置脏归零后不再自动扫——状态不再变化的轻断言
        let s1 = idx.status();
        std::thread::sleep(Duration::from_millis(idx.poll_ms * 3));
        let s2 = idx.status();
        assert_eq!(s1.entries, s2.entries, "interval=0 时无事件不应触发重扫");

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&cfg_dir).ok();
    }
}
