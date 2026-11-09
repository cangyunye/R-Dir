//! R-Dir 全盘索引搜索引擎（Everything 级体验）。
//!
//! 设计要点（详见各模块文档）：
//! - **查询热路径全内存**：字符级 2-gram 倒排索引，查询 = 多条 posting 的双指针交集
//!   + 原名精确校验，百万文件毫秒级；
//! - **正排打包 arena**：全部路径连续放一块 UTF-8 buffer，条目只记 (offset, len)，
//!   无每串堆分配（修正常见 LLM 方案里 `full_path: String` 撑爆内存的写法）；
//! - **枚举跨平台免管理员**：全量用 `ignore` 并行遍历（不识别 gitignore，索引即全量）；
//!   增量用「目录 mtime 剪枝」——目录 mtime 仅在子项增删改名时变化，未变目录的直接
//!   子项从索引直出（免 read_dir），只重枚举变更目录；
//! - **持久化**：bincode 快照原子落盘，启动加载 <1s；roots/排除清单指纹不符即弃用重建；
//! - **并发模型**：`EngineState` 不可变，后台构建新状态后整体换入（调用方
//!   `RwLock<Arc<EngineState>>`），查询 clone Arc 后无锁校验——增量更新不阻塞查询。

pub mod arena;
pub mod engine;
pub mod grams;
pub mod snapshot;
pub mod walk;

pub use arena::{name_offset, EntryMeta, PathArena};
pub use engine::{EngineState, IndexHit, MatchMode, MAX_HITS};
pub use grams::GramIndex;
pub use snapshot::{load_snapshot, save_snapshot, Snapshot, SNAPSHOT_VERSION};
pub use walk::{mtime_ms, walk_all, Exclusions, RawEntry};

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// roots + 排除清单的指纹：快照加载后校验，配置变了才全量重建。
/// 排序后哈希（等价集合同一指纹）。
pub fn roots_fingerprint(roots: &[String], exclusions: &[String]) -> u64 {
    let mut sorted_roots: Vec<&str> = roots.iter().map(|s| s.as_str()).collect();
    sorted_roots.sort_unstable();
    let mut sorted_excl: Vec<&str> = exclusions.iter().map(|s| s.as_str()).collect();
    sorted_excl.sort_unstable();
    let mut h = DefaultHasher::new();
    sorted_roots.hash(&mut h);
    sorted_excl.hash(&mut h);
    h.finish()
}

/// 从路径推断分隔符：含 `\` 视为 Windows 风格，否则 `/`。
/// 引擎其余部分对分隔符不敏感（arena 原样存），只有前缀范围查询需要。
pub fn sep_of(path: &str) -> char {
    if path.bytes().any(|b| b == b'\\') {
        '\\'
    } else {
        '/'
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_order_insensitive() {
        let a = roots_fingerprint(&["/a".into(), "/b".into()], &["/x".into()]);
        let b = roots_fingerprint(&["/b".into(), "/a".into()], &["/x".into()]);
        assert_eq!(a, b);
        let c = roots_fingerprint(&["/a".into(), "/b".into()], &[]);
        assert_ne!(a, c);
    }

    #[test]
    fn sep_detection() {
        assert_eq!(sep_of("/Users/x"), '/');
        assert_eq!(sep_of(r"C:\Users\x"), '\\');
        assert_eq!(sep_of("relative"), '/');
    }
}
