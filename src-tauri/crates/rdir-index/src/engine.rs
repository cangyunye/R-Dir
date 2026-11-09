//! 索引引擎：构建（全量 / mtime 剪枝增量）、查询、前缀范围辅助。
//!
//! 并发模型：`EngineState` 整体不可变。后台线程构建出新状态后由调用方
//! （src-tauri indexer）在 `RwLock<Arc<EngineState>>` 下整体换入；查询方拿到
//! Arc 克隆即释锁，校验与排序全部无锁——增量重扫不阻塞查询。
//!
//! 增量策略（v1，刻意不做 USN/实时监听）：
//! - **剪枝依据**：目录 mtime 只在其直接子项增删改名时变化（写文件内容不动目录
//!   mtime，而名字集合恰恰只受增删改名影响）⇒ 目录 mtime 未变 ⇒ 直接子项名字
//!   集合不变 ⇒ 直接子项从索引直出（免 read_dir），更深层级逐目录 stat 检查；
//! - mtime 未变目录里的文件 size/mtime 沿用旧值（内容编辑不改名字集合，展示
//!   元数据陈旧可接受，全量重建时校正）；
//! - 变更的代价集中在重建 gram 与 by_path（百万文件 ~1-2s，后台低频可接受），
//!   换来的是**磁盘 syscall 只花在变更目录**——全量 walk 的分钟级 → 秒级；
//! - 网络盘不在索引范围（调用方只喂本地固定卷）。
//!
//! 条目收录约定：**根目录自身不收录**（它是搜索的锚），其余所有文件/目录收录；
//! 目录条目由「其父层的枚举循环」负责收录，`walk_children_fresh` 与
//! `emit_children_from_old` 都只处理直接子项，不 push 目录自身——全量与增量的
//! 收录口径保持一致。

use crate::arena::{name_offset, EntryMeta, PathArena};
use crate::grams::{lower_chars, GramIndex};
use crate::walk::{mtime_ms, walk_all, Exclusions, RawEntry};
use crate::{roots_fingerprint, sep_of};
use globset::GlobBuilder;
use regex::Regex;
use serde::Serialize;

/// 结果上限（对齐主程序 find 的展示上限）
pub const MAX_HITS: usize = 500;
/// 候选集截断：gram 交集结果过大时先截断再校验（精度由原名校验兜底）
const CANDIDATE_CAP: usize = 10_000;

/// 匹配模式（语义对齐 fd 灯钮：glob/regex 都按文件名整段匹配）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchMode {
    /// 子串包含（默认）
    Contains,
    /// 通配符整名匹配（`*`/`?`）
    Glob,
    /// 正则整名匹配（语法错误返回 Err 给 UI）
    Regex,
}

/// 一条查询结果
#[derive(Clone, Debug, Serialize)]
pub struct IndexHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
}

/// 不可变的索引状态（整体换入换出；持久化经 snapshot::Snapshot，不走 serde derive）
#[derive(Clone, Debug)]
pub struct EngineState {
    pub arena: PathArena,
    pub meta: Vec<EntryMeta>,
    pub grams: GramIndex,
    /// 按 path 字节升序的 id：前缀范围查询（增量直出子树）与精确查找全靠二分
    pub by_path: Vec<u32>,
    /// roots + 排除清单指纹（快照校验）
    pub roots_fp: u64,
    /// 各根目录自身的 mtime（与 roots 顺序一一对应；增量剪枝第一层依据）
    pub root_mtimes: Vec<i64>,
}

impl EngineState {
    /// 由条目序列构建完整状态（全量构建与增量重扫共用：增量重扫产出的
    /// 「旧条目拷贝 + 变更子树新条目」同样从这里走，gram/by_path 整体重建）
    pub fn build(entries: Vec<RawEntry>, roots_fp: u64, root_mtimes: Vec<i64>) -> EngineState {
        let n = entries.len();
        // 平均路径 ~80 字节的预估容量，避免 arena 反复扩容
        let mut arena = PathArena::with_capacity(n.saturating_mul(80));
        let mut meta = Vec::with_capacity(n);
        let mut grams = GramIndex::default();
        for (id, e) in entries.into_iter().enumerate() {
            let (off, len) = arena.push(&e.path);
            let n_off = name_offset(&e.path);
            let name = &e.path[n_off..];
            grams.add(id as u32, name);
            meta.push(EntryMeta {
                off,
                len,
                name_len: (len as usize - n_off) as u32,
                is_dir: e.is_dir,
                size: e.size,
                mtime: e.mtime,
                dir_mtime: e.dir_mtime,
            });
        }
        let mut state = EngineState {
            arena,
            meta,
            grams,
            by_path: Vec::new(),
            roots_fp,
            root_mtimes,
        };
        state.rebuild_by_path();
        state
    }

    /// 全量枚举 + 构建
    pub fn build_full(roots: &[String], exclusions: &Exclusions) -> EngineState {
        let fp = roots_fingerprint(roots, &exclusions.dirs);
        let (entries, root_mtimes, _errs) = walk_all(roots, exclusions);
        EngineState::build(entries, fp, root_mtimes)
    }

    fn path_of(&self, id: u32) -> &str {
        let m = &self.meta[id as usize];
        self.arena.get(m.off, m.len)
    }

    fn name_of(&self, m: &EntryMeta) -> &str {
        let off = m.off + m.len - m.name_len;
        self.arena.get(off, m.name_len)
    }

    fn hit_of(&self, id: u32) -> IndexHit {
        let m = &self.meta[id as usize];
        IndexHit {
            path: self.path_of(id).to_string(),
            name: self.name_of(m).to_string(),
            is_dir: m.is_dir,
            size: m.size,
            mtime: m.mtime,
        }
    }

    /// 条目数
    pub fn len(&self) -> usize {
        self.meta.len()
    }

    pub fn is_empty(&self) -> bool {
        self.meta.is_empty()
    }

    // ==================== 查询 ====================

    /// 查询。`case_sensitive` 对 Contains 生效；Glob/Regex 自带大小写语义。
    /// gram 层恒为不区分大小写（归一在 add/query 两侧一致完成）。
    pub fn query(
        &self,
        query: &str,
        mode: MatchMode,
        case_sensitive: bool,
        is_dir: Option<bool>,
    ) -> Result<Vec<IndexHit>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits: Vec<u32> = Vec::new();
        match mode {
            MatchMode::Contains => {
                let needle: Vec<char> = lower_chars(q).collect();
                let cands = match self.grams.candidates_cap(q, CANDIDATE_CAP) {
                    Some(c) => c,
                    // 无 gram 可用（单字查询）：全量名字扫描回退
                    None => self.scan_fallback(&needle),
                };
                for id in cands {
                    let m = &self.meta[id as usize];
                    if let Some(d) = is_dir {
                        if m.is_dir != d {
                            continue;
                        }
                    }
                    let name = self.name_of(m);
                    let matched = if case_sensitive {
                        name.contains(q)
                    } else {
                        ci_contains(name, &needle)
                    };
                    if matched {
                        hits.push(id);
                        if hits.len() >= MAX_HITS {
                            break;
                        }
                    }
                }
            }
            MatchMode::Glob => {
                let gm = GlobBuilder::new(q)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map_err(|e| e.to_string())?
                    .compile_matcher();
                self.scan_linear(|name| gm.is_match(name), is_dir, &mut hits);
            }
            MatchMode::Regex => {
                let pattern = if case_sensitive { q.to_string() } else { format!("(?i){q}") };
                let re = Regex::new(&pattern).map_err(|e| e.to_string())?;
                self.scan_linear(|name| re.is_match(name), is_dir, &mut hits);
            }
        }
        // 结果按路径排序（≤MAX_HITS 条，代价可忽略）
        hits.sort_by(|&a, &b| self.path_of(a).cmp(self.path_of(b)));
        Ok(hits.into_iter().map(|id| self.hit_of(id)).collect())
    }

    /// glob/regex 的全量线性扫描（重量级模式，命中即攒，攒够即停）
    fn scan_linear(&self, test: impl Fn(&str) -> bool, is_dir: Option<bool>, hits: &mut Vec<u32>) {
        for (id, m) in self.meta.iter().enumerate() {
            if let Some(d) = is_dir {
                if m.is_dir != d {
                    continue;
                }
            }
            if test(self.name_of(m)) {
                hits.push(id as u32);
                if hits.len() >= MAX_HITS {
                    return;
                }
            }
        }
    }

    /// 单字（<2 字符）查询回退：全量名字扫描。needle 只会是 0/1 个字符——
    /// 0 已在上游拦截；1 字符走字节级双 case 探测，非 ASCII 走字符流比较。
    fn scan_fallback(&self, needle: &[char]) -> Vec<u32> {
        let mut out = Vec::new();
        if needle.is_empty() {
            return out;
        }
        let c = needle[0];
        for (id, m) in self.meta.iter().enumerate() {
            if ci_contains_char(self.name_of(m), c) {
                out.push(id as u32);
                if out.len() >= CANDIDATE_CAP {
                    break;
                }
            }
        }
        out
    }

    // ==================== 前缀范围辅助（增量重扫的地基） ====================

    /// 精确路径查找（by_path 二分）
    pub fn exact_lookup(&self, path: &str) -> Option<u32> {
        self.by_path
            .binary_search_by(|&id| self.path_of(id).cmp(path))
            .ok()
            .map(|i| self.by_path[i])
    }

    /// 以 `path` 为前缀（后跟分隔符）的条目 id 在 by_path 中的范围 `[start, end)`。
    /// 前缀上界用「分隔符字节 +1」：所有 `path+sep+*` 的字符串恰好落在
    /// `[path+sep, path+sep+1)` 区间内，兄弟路径（如 `/a/bc`）不会误入。
    /// 注：路径本身以分隔符结尾（如 `C:\`）也正确——它落在区间内但被
    /// `direct_children` 的长度过滤挡掉。
    fn range_under(&self, path: &str) -> (usize, usize) {
        let sep = sep_of(path);
        let lower = format!("{path}{sep}");
        let upper_ch = char::from_u32(sep as u32 + 1).unwrap_or('\u{10FFFF}');
        let upper = format!("{path}{upper_ch}");
        let start = self
            .by_path
            .partition_point(|&id| self.path_of(id).as_bytes() < lower.as_bytes());
        let end = self
            .by_path
            .partition_point(|&id| self.path_of(id).as_bytes() < upper.as_bytes());
        (start, end)
    }

    /// 直接子项 id（范围过滤掉更深层的后代：前缀之后不得再含分隔符）
    fn direct_children(&self, path: &str) -> Vec<u32> {
        let (s, e) = self.range_under(path);
        let plen = path.len() + 1;
        let sep = sep_of(path) as u8;
        self.by_path[s..e]
            .iter()
            .copied()
            .filter(|&id| {
                let p = self.path_of(id);
                p.len() > plen && !p.as_bytes()[plen..].contains(&sep)
            })
            .collect()
    }

    /// by_path 重建（build 与快照加载共用；crate 内可见）
    pub(crate) fn rebuild_by_path(&mut self) {
        let mut ids: Vec<u32> = (0..self.meta.len() as u32).collect();
        ids.sort_by(|&a, &b| self.path_of(a).cmp(self.path_of(b)));
        self.by_path = ids;
    }

    // ==================== 增量重扫 ====================

    /// 增量重扫：只重新枚举 mtime 变更的目录，未变目录的直接子项从索引直出。
    /// 无任何变化时返回 `None`（调用方免重建，零成本轮询）。
    /// roots/排除清单配置变化时自动退化为全量重建。
    pub fn rescan(
        old: &EngineState,
        roots: &[String],
        exclusions: &Exclusions,
    ) -> Option<EngineState> {
        let fp = roots_fingerprint(roots, &exclusions.dirs);
        if fp != old.roots_fp {
            return Some(EngineState::build_full(roots, exclusions));
        }
        let mut out = RescanCollector::default();
        let mut root_mtimes = Vec::with_capacity(roots.len());
        for (i, root) in roots.iter().enumerate() {
            let cur = std::fs::symlink_metadata(root).map(|md| mtime_ms(&md)).unwrap_or(0);
            if cur == 0 {
                // 根消失/不可读：整棵不再收录
                out.changed = true;
                root_mtimes.push(0);
                continue;
            }
            root_mtimes.push(cur);
            let stored = old.root_mtimes.get(i).copied().unwrap_or(0);
            if stored == cur {
                out.emit_children_from_old(old, root, exclusions);
            } else {
                out.changed = true;
                out.walk_children_fresh(old, root, cur, exclusions);
            }
        }
        if !out.changed {
            return None;
        }
        Some(EngineState::build(out.entries, fp, root_mtimes))
    }
}

/// 增量收集器：旧条目拷贝 + 变更子树新条目，攒齐后整体 build
#[derive(Default)]
struct RescanCollector {
    entries: Vec<RawEntry>,
    changed: bool,
}

impl RescanCollector {
    /// 未变目录（含根）：直接子项从旧索引直出（arena 字节 memcpy + meta 拷贝），
    /// 子目录逐个 stat 检查——变了走 fresh，未变继续直出。不收录 dir 自身
    /// （由其父层负责）。
    fn emit_children_from_old(&mut self, old: &EngineState, dir: &str, exclusions: &Exclusions) {
        for id in old.direct_children(dir) {
            let m = &old.meta[id as usize];
            let path = old.path_of(id).to_string();
            if m.is_dir {
                let sub_cur = std::fs::symlink_metadata(&path).map(|md| mtime_ms(&md)).unwrap_or(0);
                if sub_cur == 0 {
                    // 目录消失（防御：mtime 未变的父目录理论上不该出现）
                    self.changed = true;
                    continue;
                }
                // 先收录自身（携带当前 mtime），再下探
                self.push_copy(old, id, sub_cur);
                if m.dir_mtime != sub_cur {
                    self.changed = true;
                    self.walk_children_fresh(old, &path, sub_cur, exclusions);
                } else {
                    self.emit_children_from_old(old, &path, exclusions);
                }
            } else {
                // 文件：名字集合未变，size/mtime 沿用旧值（内容编辑不进增量）
                self.push_copy(old, id, 0);
            }
        }
    }

    /// 变更目录（含根）：全新 read_dir 枚举直接子项；子目录先收录再下探
    /// （下探内部仍按 mtime 做剪枝——变更目录下也可能有未变的子树）。
    /// 不收录 dir 自身（由其父层负责）。
    fn walk_children_fresh(
        &mut self,
        old: &EngineState,
        dir: &str,
        _dir_cur: i64,
        exclusions: &Exclusions,
    ) {
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return, // 读不到：该层消失，不收录
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if exclusions.is_excluded(&path) {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            let Ok(md) = entry.metadata() else { continue };
            let path_str = path.to_string_lossy().into_owned();
            if ft.is_dir() {
                let sub_cur = mtime_ms(&md);
                // 收录目录自身，再下探（mixed：子目录可能未变，仍可直出）
                self.entries.push(RawEntry {
                    path: path_str.clone(),
                    is_dir: true,
                    size: 0,
                    mtime: sub_cur,
                    dir_mtime: sub_cur,
                });
                self.walk_dir_mixed(old, &path_str, sub_cur, exclusions);
            } else {
                self.entries.push(RawEntry {
                    path: path_str,
                    is_dir: false,
                    size: md.len(),
                    mtime: mtime_ms(&md),
                    dir_mtime: 0,
                });
            }
        }
    }

    /// 目录下探的统一入口：mtime 未变走直出，变了走 fresh。
    /// 调用方（fresh 枚举循环）已收录目录自身，这里只处理其子项。
    fn walk_dir_mixed(
        &mut self,
        old: &EngineState,
        dir: &str,
        dir_cur: i64,
        exclusions: &Exclusions,
    ) {
        let old_id = old.exact_lookup(dir);
        let unchanged = dir_cur != 0
            && old_id.map(|id| old.meta[id as usize].dir_mtime == dir_cur).unwrap_or(false);
        if unchanged {
            self.emit_children_from_old(old, dir, exclusions);
        } else {
            self.changed = true;
            self.walk_children_fresh(old, dir, dir_cur, exclusions);
        }
    }

    /// 从旧索引拷贝一条条目（arena 字节 memcpy；目录条目可携带新 mtime）
    fn push_copy(&mut self, old: &EngineState, id: u32, dir_mtime_override: i64) {
        let m = &old.meta[id as usize];
        self.entries.push(RawEntry {
            path: old.path_of(id).to_string(),
            is_dir: m.is_dir,
            size: m.size,
            mtime: m.mtime,
            dir_mtime: if m.is_dir { dir_mtime_override } else { 0 },
        });
    }
}

/// 不区分大小写子串匹配（无分配）：needle 预小写成 char 数组（调用方缓存一份），
/// hay 侧逐字符小写流式比较。候选 ≤ CANDIDATE_CAP，朴素算法足够。
fn ci_contains(hay: &str, needle: &[char]) -> bool {
    if needle.is_empty() {
        return true;
    }
    let hay_l: Vec<char> = lower_chars(hay).collect();
    'outer: for start in 0..hay_l.len() {
        let mut ni = 0usize;
        while ni < needle.len() {
            if start + ni >= hay_l.len() || hay_l[start + ni] != needle[ni] {
                continue 'outer;
            }
            ni += 1;
        }
        return true;
    }
    false
}

/// 单字符不区分大小写包含（回退扫描专用，零分配）
fn ci_contains_char(hay: &str, c: char) -> bool {
    if c.is_ascii() {
        let lc = c.to_ascii_lowercase() as u8;
        let uc = c.to_ascii_uppercase() as u8;
        return hay.bytes().any(|b| b == lc || b == uc);
    }
    lower_chars(hay).any(|h| h == c)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(path: &str, is_dir: bool) -> RawEntry {
        RawEntry {
            path: path.into(),
            is_dir,
            size: 1,
            mtime: 100,
            dir_mtime: if is_dir { 100 } else { 0 },
        }
    }

    fn state_with(entries: Vec<RawEntry>) -> EngineState {
        EngineState::build(entries, 42, vec![100])
    }

    #[test]
    fn build_and_contains_query() {
        let st = state_with(vec![
            raw("/data/Readme.md", false),
            raw("/data/读取我.md", false),
            raw("/data/src", true),
            raw("/data/src/main.rs", false),
            raw("/data/src/lib", true),
            raw("/data/src/lib/子目录文档.docx", false),
        ]);
        // 子串（不区分大小写）
        let hits = st.query("readme", MatchMode::Contains, false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/data/Readme.md");
        let hits = st.query("MAIN", MatchMode::Contains, false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "main.rs");
        // 中文 2 字查询
        let hits = st.query("读取", MatchMode::Contains, false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "读取我.md");
        // 大小写敏感
        assert_eq!(st.query("Readme", MatchMode::Contains, true, None).unwrap().len(), 1);
        assert!(st.query("readme", MatchMode::Contains, true, None).unwrap().is_empty());
        // is_dir 过滤
        let hits = st.query("lib", MatchMode::Contains, false, Some(true)).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].is_dir);
        // 结果按路径排序
        let hits = st.query(".md", MatchMode::Contains, false, None).unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort_unstable();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn single_char_fallback() {
        let st = state_with(vec![raw("/a/x.txt", false), raw("/b/y.log", false), raw("/c/z", false)]);
        let hits = st.query("z", MatchMode::Contains, false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/c/z");
        let hits = st.query("X", MatchMode::Contains, false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/a/x.txt");
    }

    #[test]
    fn glob_and_regex_modes() {
        let st = state_with(vec![
            raw("/d/a.rs", false),
            raw("/d/b.txt", false),
            raw("/d/子目录.rs", false),
        ]);
        let hits = st.query("*.rs", MatchMode::Glob, false, None).unwrap();
        assert_eq!(hits.len(), 2);
        // glob 无通配 = 整名相等
        assert_eq!(st.query("a.rs", MatchMode::Glob, false, None).unwrap().len(), 1);
        assert!(st.query("a", MatchMode::Glob, false, None).unwrap().is_empty());
        let hits = st.query(r"\.txt$", MatchMode::Regex, false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(st.query("(unclosed", MatchMode::Regex, false, None).is_err());
    }

    #[test]
    fn range_children_windows_and_unix() {
        let st = state_with(vec![
            raw("C:\\d\\a.txt", false),
            raw("C:\\d\\sub", true),
            raw("C:\\d\\sub\\deep.txt", false),
            raw("C:\\d\\sub2.txt", false), // 兄弟：d 的直接子项
            raw("/u/x/y", false),
            raw("/u/x/y/z", true),
        ]);
        let names: Vec<String> = st
            .direct_children("C:\\d")
            .into_iter()
            .map(|id| st.path_of(id).to_string())
            .collect();
        assert_eq!(names, vec!["C:\\d\\a.txt", "C:\\d\\sub", "C:\\d\\sub2.txt"]);
        assert_eq!(st.direct_children("C:\\d\\sub").len(), 1);
        let y = st.direct_children("/u/x/y");
        assert_eq!(y.len(), 1);
        assert!(st.meta[y[0] as usize].is_dir);
    }

    /// 真实 FS 的增量重扫：无变化 / 深层新增 / 顶层增删
    #[test]
    fn rescan_incremental() {
        let root = std::env::temp_dir().join(format!("rdir_index_rescan_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let a = root.join("a");
        let b = a.join("b");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(root.join("top.txt"), "t").unwrap();
        std::fs::write(b.join("deep.txt"), "d").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));

        let roots = vec![root.to_str().unwrap().to_string()];
        let excl = Exclusions::default();
        let st0 = EngineState::build_full(&roots, &excl);
        // 根自身不收录：a、b、top.txt、deep.txt = 4 条
        assert_eq!(st0.len(), 4);

        // 无变化：None，零重建
        assert!(EngineState::rescan(&st0, &roots, &excl).is_none());

        // 深层新增（root mtime 不变，a/b 变）
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(b.join("new.txt"), "n").unwrap();
        let st1 = EngineState::rescan(&st0, &roots, &excl).expect("应检测到变更");
        assert!(st1.exact_lookup(b.join("new.txt").to_str().unwrap()).is_some());
        assert!(st1.exact_lookup(b.join("deep.txt").to_str().unwrap()).is_some());
        assert!(st1.exact_lookup(&root.join("top.txt").to_string_lossy()).is_some());

        // 顶层新增 + 深层删除
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(root.join("second.log"), "s").unwrap();
        std::fs::remove_file(b.join("deep.txt")).unwrap();
        let st2 = EngineState::rescan(&st1, &roots, &excl).expect("应检测到变更");
        assert!(st2.exact_lookup(&root.join("second.log").to_string_lossy()).is_some());
        assert!(st2.exact_lookup(b.join("deep.txt").to_str().unwrap()).is_none());
        // 未动过的子树内容保持
        assert!(st2.exact_lookup(b.join("new.txt").to_str().unwrap()).is_some());

        // 查询仍正常
        let hits = st2.query("second", MatchMode::Contains, false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "second.log");

        std::fs::remove_dir_all(&root).ok();
    }

    /// 剪枝正确性：深层目录变更不能被「父目录 mtime 未变」吞掉
    #[test]
    fn rescan_deep_change_not_swallowed() {
        let root = std::env::temp_dir().join(format!("rdir_index_deep_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let deep = root.join("l1").join("l2").join("l3");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("old.txt"), "o").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let roots = vec![root.to_str().unwrap().to_string()];
        let excl = Exclusions::default();
        let st0 = EngineState::build_full(&roots, &excl);

        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(deep.join("fresh.txt"), "f").unwrap();
        let st1 = EngineState::rescan(&st0, &roots, &excl).expect("深层变更必须被检出");
        assert!(st1.exact_lookup(deep.join("fresh.txt").to_str().unwrap()).is_some());
        std::fs::remove_dir_all(&root).ok();
    }

    /// 目录自身收录口径：全量与增量一致（根不收录；嵌套目录收录）
    #[test]
    fn dir_entries_consistent_between_full_and_rescan() {
        let root = std::env::temp_dir().join(format!("rdir_index_dirs_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("f.txt"), "f").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let roots = vec![root.to_str().unwrap().to_string()];
        let excl = Exclusions::default();
        let st0 = EngineState::build_full(&roots, &excl);
        assert!(st0.exact_lookup(&root.to_string_lossy()).is_none(), "根不收录");
        assert!(st0.exact_lookup(sub.to_str().unwrap()).is_some(), "嵌套目录收录");

        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(sub.join("g.txt"), "g").unwrap();
        let st1 = EngineState::rescan(&st0, &roots, &excl).expect("变更");
        assert!(st1.exact_lookup(&root.to_string_lossy()).is_none(), "增量后根仍不收录");
        assert!(st1.exact_lookup(sub.to_str().unwrap()).is_some());
        std::fs::remove_dir_all(&root).ok();
    }
}
