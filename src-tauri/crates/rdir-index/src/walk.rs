//! 枚举层。
//!
//! - 全量构建：`ignore` 的并行遍历（`standard_filters(false)`——不识别
//!   gitignore/隐藏过滤，索引即全量；`follow_links(false)` 防符号链接环），
//!   跨平台、无需管理员权限（刻意不走 Windows MFT/USN：跨平台且免提权）；
//! - 排除清单：路径组件级前缀匹配（`Path::starts_with`，`/System` 不会误伤
//!   `/System2`），目录命中整棵剪枝；
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

/// 排除清单：组件级路径前缀匹配。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Exclusions {
    pub dirs: Vec<String>,
}

impl Exclusions {
    pub fn new(list: &[String]) -> Self {
        Self { dirs: list.to_vec() }
    }

    /// path 等于排除项或位于其下（`Path::starts_with` 按组件比较）
    pub fn is_excluded(&self, path: &Path) -> bool {
        self.dirs.iter().any(|e| path.starts_with(e))
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
                            if excl.is_excluded(path) {
                                // 命中的目录整棵剪枝，文件直接跳过
                                return if dent.file_type().map_or(false, |ft| ft.is_dir()) {
                                    WalkState::Skip
                                } else {
                                    WalkState::Continue
                                };
                            }
                            let ft = match dent.file_type() {
                                Some(ft) => ft,
                                None => return WalkState::Continue,
                            };
                            let md = match dent.metadata() {
                                Ok(md) => md,
                                Err(_) => {
                                    errs.fetch_add(1, Ordering::Relaxed);
                                    return WalkState::Continue;
                                }
                            };
                            let is_dir = ft.is_dir(); // follow_links(false)：目录符号链接不算目录
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
        std::fs::write(root.join("a.txt"), "aaa").unwrap();
        std::fs::write(sub.join("b.md"), "bbbb").unwrap();
        std::fs::write(sub.join("deep").join("c.txt"), "ccccc").unwrap();
        std::fs::write(excl.join("d.txt"), "dddddd").unwrap();
        root
    }

    #[test]
    fn walk_all_collects_and_excludes() {
        let root = fixture();
        let root_str = root.to_str().unwrap().to_string();
        let excl = Exclusions::new(&[root.join("skipme").to_str().unwrap().to_string()]);
        let (entries, root_mtimes, errs) = walk_all(&[root_str.clone()], &excl);
        assert_eq!(errs, 0);
        assert_eq!(root_mtimes.len(), 1);
        assert!(root_mtimes[0] > 0);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        // 根自身不收录；排除目录整棵跳过
        assert!(!paths.iter().any(|p| *p == root_str));
        assert!(paths.iter().all(|p| !p.contains("skipme")));
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
}
