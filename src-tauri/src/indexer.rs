//! 全盘索引（rdir-index crate）的主程序集成：后台维护线程 + 配置 + 状态。
//!
//! 生命周期：GUI 在 setup 启动（indexer::init），web 桥首条 index_* 命令惰性启动
//! （indexer::ensure）——同一进程只有一份实例（OnceLock）。后台线程职责：
//! - 启动优先加载快照（<1s 恢复可查）；无快照/指纹不符 → 全量构建（空闲节流）；
//! - 之后周期性增量重扫（rdir-index 的 mtime 剪枝：无变化零成本返回 None）；
//! - 有变更/全量重建完成 → 快照原子落盘，下一秒启动即可秒级恢复；
//! - 「重建」命令置 wants_full 旗标，线程 ≤ POLL_INTERVAL 内响应。
//!
//! 并发模型：EngineState 不可变整体换入 `RwLock<Arc<Option<EngineState>>>`；
//! 查询 clone Arc 即释锁，构建期间旧状态继续可查（首建期间为 None → 空结果，
//! 前端据 index_status 显示「构建中」）。

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

/// 配置文件（config_dir/index.json：roots + 排除清单，前端设置分区读写）
const INDEX_CONFIG_FILE: &str = "index.json";
/// 快照目录/文件（config_dir/index/snapshot.bin；索引是可重建缓存，与 thumbs 同级语义）
const SNAP_SUBDIR: &str = "index";
const SNAP_FILE: &str = "snapshot.bin";
/// 增量重扫间隔（v1 固定 10 分钟；mtime 剪枝下无变化的重扫是纯 stat，成本秒级）
const RESCAN_INTERVAL: Duration = Duration::from_secs(600);
/// 后台轮询间隔（检查开关/重建请求/重扫到点，全部是廉价检查）
const POLL_INTERVAL: Duration = Duration::from_secs(2);

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

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct IndexConfigFile {
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub exclusions: Vec<String>,
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
    /// 配置缓存（线程每轮读取；set_config 更新缓存 + 落盘）
    cfg: Mutex<IndexConfigFile>,
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
            cfg: Mutex::new(cfg),
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

    /// 手动全量重建（≤ POLL_INTERVAL 内被后台线程响应）
    pub fn rebuild(&self) {
        self.wants_full.store(true, Ordering::Relaxed);
    }

    pub fn get_config(&self) -> IndexConfigFile {
        self.cfg.lock().unwrap().clone()
    }

    /// 更新 roots/排除清单：落盘 + 更新缓存；指纹变化由后台线程检测后自动全量重建
    pub fn set_config(&self, roots: Vec<String>, exclusions: Vec<String>) -> Result<(), String> {
        save_config(&self.config_dir, &IndexConfigFile { roots: roots.clone(), exclusions: exclusions.clone() })?;
        *self.cfg.lock().unwrap() = IndexConfigFile { roots, exclusions };
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

/// 后台主循环
fn thread_loop(idx: Arc<Indexer>) {
    let mut last_rescan: Option<Instant> = None;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        if !idx.enabled.load(Ordering::Relaxed) {
            idx.phase.store(PHASE_DISABLED, Ordering::Relaxed);
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
                if st.roots_fp != fp {
                    // 配置变化：全量重建（swap 前旧状态继续可查）
                    idx.phase.store(PHASE_BUILDING, Ordering::Relaxed);
                    let t0 = Instant::now();
                    let (new, errs) = EngineState::build_full(&cfg.roots, &excl);
                    idx.errors.store(errs, Ordering::Relaxed);
                    idx.last_duration_ms.store(t0.elapsed().as_millis() as i64, Ordering::Relaxed);
                    idx.swap(new);
                    persist(&idx);
                    last_rescan = Some(Instant::now());
                } else if idx.wants_full.swap(false, Ordering::Relaxed) {
                    idx.phase.store(PHASE_BUILDING, Ordering::Relaxed);
                    let t0 = Instant::now();
                    let (new, errs) = EngineState::build_full(&cfg.roots, &excl);
                    idx.errors.store(errs, Ordering::Relaxed);
                    idx.last_duration_ms.store(t0.elapsed().as_millis() as i64, Ordering::Relaxed);
                    idx.swap(new);
                    persist(&idx);
                    last_rescan = Some(Instant::now());
                } else if last_rescan.map_or(true, |t| t.elapsed() >= RESCAN_INTERVAL) {
                    // 周期增量：无变化时 rescan 返回 None，零成本
                    if let Some(new) = EngineState::rescan(st, &cfg.roots, &excl) {
                        idx.swap(new);
                        persist(&idx);
                    }
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
