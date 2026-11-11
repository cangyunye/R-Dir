//! 枚举层。
//!
//! - 全量构建：`ignore` 的并行遍历（`standard_filters(false)`——不识别
//!   gitignore/隐藏过滤，索引即全量；`follow_links(false)` 防符号链接环），
//!   跨平台、无需管理员权限（刻意不走 Windows MFT/USN：跨平台且免提权）；
//! - 排除清单：路径组件级前缀匹配（`Path::starts_with`，`/System` 不会误伤
//!   `/System2`），目录命中整棵剪枝；另有名字级排除（node_modules 等，对
//!   任意层级下的同名**目录**生效，同名文件不受影响）；
//! - 隐藏与文件类型过滤（索引期）：`hidden=false` 时 dot 开头条目不收录
//!   （目录整棵剪枝），文件类型按 Exclude/Include 模式剪枝（目录恒收录）；
//! - 节流：每 N 条目微休眠，降低对前台 IO 的挤压（「空闲时间」构建的实现方式，
//!   不引线程优先级依赖）。

use ignore::{DirEntry, WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

/// 一条待索引条目（枚举层产出、引擎消费）
#[derive(Clone, Debug)]
pub struct RawEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    /// 目录自身 mtime（剪枝依据）；非目录恒为 0
    pub dir_mtime: i64,
}

/// 文件类型索引模式：`All` = 全部收录；`Exclude` = 不索引列表内扩展名；
/// `Include` = 仅索引列表内扩展名（定向索引）。只作用文件，目录不受影响。
/// 扩展名统一小写、不含前导点（`Path::extension` 语义——`a.tar.gz` 的扩展名
/// 是 `gz`；无扩展名文件在 Exclude 模式照收、Include 模式不收）。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum FileFilter {
    #[default]
    All,
    Exclude(Vec<String>),
    Include(Vec<String>),
}

/// 扩展名归一：trim、去前导点、小写、去空、去重（配置侧与过滤器共用）
pub fn normalize_exts(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = list
        .iter()
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

impl FileFilter {
    /// 配置三元组 → 过滤器：`exclude` 用排除列表、`include` 用定向列表，
    /// 其余值（含缺省/非法）回落 `All`
    pub fn from_config(mode: &str, exclude: &[String], include: &[String]) -> Self {
        match mode {
            "exclude" => Self::Exclude(normalize_exts(exclude)),
            "include" => Self::Include(normalize_exts(include)),
            _ => Self::All,
        }
    }
}

/// 排除清单：组件级路径前缀匹配 + 名字级匹配 + 隐藏/文件类型过滤。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Exclusions {
    pub dirs: Vec<String>,
    /// 名字级排除（`node_modules`、`.venv` 等）：目录最后一段组件命中即整棵
    /// 剪枝（同名文件不受影响）。与 dirs 不同，无需绝对路径，对任意层级生效。
    #[serde(default)]
    pub names: Vec<String>,
    /// 文件类型索引模式（缺省 All = 不过滤）
    #[serde(default)]
    pub files: FileFilter,
    /// 是否索引隐藏条目（dot 开头；索引期过滤，缺省 true 兼容旧行为）
    #[serde(default = "default_true")]
    pub hidden: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Exclusions {
    /// 手动实现（而非派生）：`hidden` 的缺省是 true（索引隐藏 = 旧行为），
    /// `bool` 派生 Default 会落成 false
    fn default() -> Self {
        Self {
            dirs: Vec::new(),
            names: Vec::new(),
            files: FileFilter::All,
            hidden: true,
        }
    }
}

impl Exclusions {
    pub fn new(dirs: &[String], names: &[String]) -> Self {
        Self {
            dirs: dirs.to_vec(),
            names: names.to_vec(),
            files: FileFilter::All,
            hidden: true,
        }
    }

    /// path 等于排除项或位于其下（`Path::starts_with` 按组件比较，文件与目录都适用）
    pub fn is_excluded(&self, path: &Path) -> bool {
        self.dirs.iter().any(|e| path.starts_with(e))
    }

    /// 名字级排除：最后一段组件命中 names。仅对**目录**调用（调用方以 is_dir
    /// 门控）——同名文件不剔除，避免误伤恰好叫 build/dist 的普通文件。
    pub fn name_excluded(&self, path: &Path) -> bool {
        match path.file_name() {
            Some(n) if !self.names.is_empty() => {
                let n = n.to_string_lossy();
                self.names.iter().any(|x| x.as_str() == n)
            }
            _ => false,
        }
    }

    /// 最后一段组件是否 `.` 开头（与查询期 show_hidden 同语义）
    pub fn is_hidden_path(path: &Path) -> bool {
        path.file_name()
            .map_or(false, |n| n.to_string_lossy().starts_with('.'))
    }

    /// 文件类型过滤（只对文件调用；目录恒收录）
    pub fn is_file_allowed(&self, path: &Path) -> bool {
        match &self.files {
            FileFilter::All => true,
            FileFilter::Exclude(exts) => match path.extension() {
                None => true,
                Some(e) => {
                    let e = e.to_string_lossy().to_lowercase();
                    !exts.iter().any(|x| x == &e)
                }
            },
            FileFilter::Include(exts) => match path.extension() {
                None => false,
                Some(e) => {
                    let e = e.to_string_lossy().to_lowercase();
                    exts.iter().any(|x| x == &e)
                }
            },
        }
    }
}

/// mtime → Unix 毫秒（取不到属性/纪元前为 0）
pub fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 全量枚举所有根。返回（条目, 各根的目录 mtime——增量剪枝基线, 跳过的错误计数）。
/// 根自身不收录（它是搜索的锚，不出现在结果里）；符号链接不跟随。
pub fn walk_all(roots: &[String], exclusions: &Exclusions) -> (Vec<RawEntry>, Vec<i64>, u64) {
    let excl = Arc::new(exclusions.clone());
    let entries: Arc<Mutex<Vec<RawEntry>>> = Arc::new(Mutex::new(Vec::new()));
    let errs = Arc::new(AtomicU64::new(0));
    let mut root_mtimes = Vec::with_capacity(roots.len());

    for root in roots {
        let rp = Path::new(root);
        root_mtimes.push(
            std::fs::symlink_metadata(rp)
                .map(|md| {
                    if md.is_dir() {
                        mtime_ms(&md)
                    } else {
                        0
                    }
                })
                .unwrap_or(0),
        );
        let entries2 = entries.clone();
        let errs2 = errs.clone();
        let excl2 = excl.clone();
        WalkBuilder::new(rp)
            .standard_filters(false)
            .follow_links(false)
            .build_parallel()
            .run(move || {
                // 每线程一份节流计数；收集器经 Arc 共享
                let mut since_throttle = 0u32;
                let entries = entries2.clone();
                let errs = errs2.clone();
                let excl = excl2.clone();
                Box::new(move |result: Result<DirEntry, ignore::Error>| -> WalkState {
                    match result {
                        Ok(dent) => {
                            // 根自身不收录
                            if dent.depth() == 0 {
                                return WalkState::Continue;
                            }
                            let path = dent.path();
                            let ft = match dent.file_type() {
                                Some(ft) => ft,
                                None => return WalkState::Continue,
                            };
                            let is_dir = ft.is_dir(); // follow_links(false)：目录符号链接不算目录
                            if excl.is_excluded(path) {
                                // 命中的目录整棵剪枝，文件直接跳过
                                return if is_dir {
                                    WalkState::Skip
                                } else {
                                    WalkState::Continue
                                };
                            }
                            // 名字级排除只剪目录（同名文件不误伤）
                            if is_dir && excl.name_excluded(path) {
                                return WalkState::Skip;
                            }
                            // 隐藏过滤（索引期；目录整棵剪枝，文件直接跳过）
                            if !excl.hidden && Exclusions::is_hidden_path(path) {
                                return if is_dir {
                                    WalkState::Skip
                                } else {
                                    WalkState::Continue
                                };
                            }
                            // 文件类型过滤（目录不受影响）
                            if !is_dir && !excl.is_file_allowed(path) {
                                return WalkState::Continue;
                            }
                            let md = match dent.metadata() {
                                Ok(md) => md,
                                Err(_) => {
                                    errs.fetch_add(1, Ordering::Relaxed);
                                    return WalkState::Continue;
                                }
                            };
                            entries.lock().unwrap().push(RawEntry {
                                path: path.to_string_lossy().into_owned(),
                                is_dir,
                                size: if is_dir { 0 } else { md.len() },
                                mtime: mtime_ms(&md),
                                dir_mtime: if is_dir { mtime_ms(&md) } else { 0 },
                            });
                            // 节流：周期性微休眠，把磁盘让给前台
                            since_throttle += 1;
                            if since_throttle >= THROTTLE_EVERY {
                                since_throttle = 0;
                                std::thread::sleep(THROTTLE_SLEEP);
                            }
                            WalkState::Continue
                        }
                        Err(_) => {
                            // 权限/消失等：静默跳过并计数（UI 可展示「n 项不可读」）
                            errs.fetch_add(1, Ordering::Relaxed);
                            WalkState::Continue
                        }
                    }
                })
            });
    }

    let drained = entries.lock().unwrap().split_off(0);
    (drained, root_mtimes, errs.load(Ordering::Relaxed))
}

const THROTTLE_EVERY: u32 = 8192;
const THROTTLE_SLEEP: Duration = Duration::from_millis(2);

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("rdir_index_walk_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("sub");
        let excl = root.join("skipme");
        std::fs::create_dir_all(sub.join("deep")).unwrap();
        std::fs::create_dir_all(&excl).unwrap();
        std::fs::create_dir_all(sub.join("node_modules").join("pkg")).unwrap();
        std::fs::write(root.join("a.txt"), "aaa").unwrap();
        std::fs::write(sub.join("b.md"), "bbbb").unwrap();
        std::fs::write(sub.join("deep").join("c.txt"), "ccccc").unwrap();
        std::fs::write(excl.join("d.txt"), "dddddd").unwrap();
        std::fs::write(sub.join("node_modules").join("pkg").join("e.js"), "eeeee").unwrap();
        root
    }

    #[test]
    fn walk_all_collects_and_excludes() {
        let root = fixture();
        let root_str = root.to_str().unwrap().to_string();
        let excl = Exclusions::new(
            &[root.join("skipme").to_str().unwrap().to_string()],
            &["node_modules".to_string()],
        );
        let (entries, root_mtimes, errs) = walk_all(&[root_str.clone()], &excl);
        assert_eq!(errs, 0);
        assert_eq!(root_mtimes.len(), 1);
        assert!(root_mtimes[0] > 0);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        // 根自身不收录；排除目录与名字级排除（任意层级）整棵跳过
        assert!(!paths.iter().any(|p| *p == root_str));
        assert!(paths.iter().all(|p| !p.contains("skipme")));
        assert!(paths.iter().all(|p| !p.contains("node_modules")));
        assert!(paths.iter().any(|p| p.ends_with("a.txt")));
        assert!(paths.iter().any(|p| p.ends_with("b.md")));
        assert!(paths.iter().any(|p| p.ends_with("c.txt")));
        // 元数据
        let a = entries.iter().find(|e| e.path.ends_with("a.txt")).unwrap();
        assert!(!a.is_dir);
        assert_eq!(a.size, 3);
        assert!(a.mtime > 0);
        let sub = entries.iter().find(|e| e.path.ends_with("sub")).unwrap();
        assert!(sub.is_dir);
        assert!(sub.dir_mtime > 0);
        std::fs::remove_dir_all(&root).ok();
    }

    /// 名字级排除只命中最后一段组件且只剪目录：子目录自身的名字不受父级名字
    /// 影响；同名文件（如恰好叫 dist 的普通文件）不误伤
    #[test]
    fn name_exclusion_matches_last_component_only() {
        let root = std::env::temp_dir().join(format!("rdir_index_names_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("dist").join("inner")).unwrap();
        std::fs::create_dir_all(root.join("other")).unwrap();
        std::fs::write(root.join("dist").join("f.js"), "x").unwrap();
        std::fs::write(root.join("dist").join("inner").join("g.css"), "y").unwrap();
        std::fs::write(root.join("keep.txt"), "z").unwrap();
        std::fs::write(root.join("other").join("dist"), "同名普通文件").unwrap();
        let excl = Exclusions::new(&[], &["dist".to_string()]);
        let (entries, _, errs) = walk_all(&[root.to_str().unwrap().to_string()], &excl);
        assert_eq!(errs, 0);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        // 同名目录整棵剪枝（含子树）；包含 dist 的路径只能是同名文件自身
        assert!(paths.iter().all(|p| !p.contains("dist") || p.ends_with("dist")));
        assert!(paths.iter().any(|p| p.ends_with("dist")), "同名文件不误伤");
        assert!(paths.iter().any(|p| p.ends_with("keep.txt")));
        std::fs::remove_dir_all(&root).ok();
    }

    /// hidden=false：隐藏目录整棵剪枝、隐藏文件跳过；隐藏名根目录自身不参与
    /// 隐藏判断（depth 0 不检查），其子项照常收录
    #[test]
    fn hidden_filter_prunes_at_index_time() {
        let root = std::env::temp_dir().join(format!("rdir_index_hidden_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let hidden_dir = root.join(".hid");
        std::fs::create_dir_all(hidden_dir.join("deep")).unwrap();
        std::fs::write(root.join(".dotfile"), "x").unwrap();
        std::fs::write(root.join("plain.txt"), "y").unwrap();
        std::fs::write(hidden_dir.join("deep").join("z.md"), "z").unwrap();
        let excl = Exclusions::new(&[], &[]);
        // 默认（hidden=true）全收录
        let (all, _, _) = walk_all(&[root.to_str().unwrap().to_string()], &excl);
        assert!(all.iter().any(|e| e.path.ends_with(".dotfile")));
        assert!(all.iter().any(|e| e.path.ends_with("z.md")));
        // hidden=false：dot 开头条目不收录，明文照收
        let no_hidden = Exclusions {
            hidden: false,
            ..Exclusions::new(&[], &[])
        };
        let (kept, _, errs) = walk_all(&[root.to_str().unwrap().to_string()], &no_hidden);
        assert_eq!(errs, 0);
        let paths: Vec<&str> = kept.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.iter().all(|p| !p.contains(".hid") && !p.contains(".dotfile")));
        assert!(paths.iter().any(|p| p.ends_with("plain.txt")));
        // 隐藏名根目录：子项不受根自身名字影响
        let hidden_root = root.join(".cacheroot");
        std::fs::create_dir_all(&hidden_root).unwrap();
        std::fs::write(hidden_root.join("inside.txt"), "w").unwrap();
        let (kept2, _, _) = walk_all(&[hidden_root.to_str().unwrap().to_string()], &no_hidden);
        assert!(kept2.iter().any(|e| e.path.ends_with("inside.txt")));
        std::fs::remove_dir_all(&root).ok();
    }

    /// 文件类型过滤：Exclude 不收列表扩展名（无扩展名照收）、Include 只收列表
    /// 扩展名（大小写不敏感）；目录恒收录不受模式影响
    #[test]
    fn file_filter_include_and_exclude() {
        let root = std::env::temp_dir().join(format!("rdir_index_ext_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.log"), "x").unwrap();
        std::fs::write(root.join("A.TXT"), "x").unwrap(); // 大写扩展名：归一小写比对
        std::fs::write(root.join("Makefile"), "x").unwrap(); // 无扩展名
        std::fs::write(root.join("b.rs"), "y").unwrap();
        std::fs::write(root.join("sub").join("c.log"), "z").unwrap();
        let root_str = root.to_str().unwrap().to_string();

        // Exclude [log]：log 全剪、无扩展名照收、目录照收
        let excl = Exclusions {
            files: FileFilter::from_config("exclude", &["log".to_string()], &[]),
            ..Exclusions::new(&[], &[])
        };
        let (kept, _, errs) = walk_all(&[root_str.clone()], &excl);
        assert_eq!(errs, 0);
        let paths: Vec<&str> = kept.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.iter().all(|p| !p.ends_with(".log")));
        assert!(paths.iter().any(|p| p.ends_with("A.TXT")));
        assert!(paths.iter().any(|p| p.ends_with("Makefile")));
        assert!(paths.iter().any(|p| p.ends_with("b.rs")));
        assert!(paths.iter().any(|p| p.ends_with("sub")), "目录不受类型过滤");
        assert_eq!(paths.len(), 4, "{paths:?}");

        // Include [TXT]：只收 txt（归一小写）与目录；无扩展名不收
        let incl = Exclusions {
            files: FileFilter::from_config("include", &[], &["TXT".to_string()]),
            ..Exclusions::new(&[], &[])
        };
        let (kept, _, _) = walk_all(&[root_str], &incl);
        let paths: Vec<&str> = kept.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.ends_with("A.TXT")));
        assert!(paths.iter().any(|p| p.ends_with("sub")));
        assert_eq!(paths.len(), 2, "{paths:?}");
        std::fs::remove_dir_all(&root).ok();
    }
}
