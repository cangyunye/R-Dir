//! 索引快照持久化：bincode 序列化 + 原子落盘（tmp + rename，仿 json_store）。
//!
//! 快照是**可重建缓存**（非用户数据）：版本不符 / 指纹不符 / 解码失败一律弃用
//! 触发全量重建，不做迁移。百万文件量级快照 ~100-150MB 磁盘、加载 <1s。

use crate::arena::PathArena;
use crate::engine::EngineState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// 快照格式版本：结构变更时 +1，旧快照直接弃用重建
pub const SNAPSHOT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    pub roots_fp: u64,
    pub root_mtimes: Vec<i64>,
    /// 打包路径 buffer（PathArena 的原始字节）
    pub buf: Vec<u8>,
    pub meta: Vec<crate::arena::EntryMeta>,
    pub grams: crate::grams::GramIndex,
}

impl Snapshot {
    pub fn from_state(state: &EngineState) -> Snapshot {
        Snapshot {
            version: SNAPSHOT_VERSION,
            roots_fp: state.roots_fp,
            root_mtimes: state.root_mtimes.clone(),
            buf: state.arena.clone().into_bytes(),
            meta: state.meta.clone(),
            grams: state.grams.clone(),
        }
    }

    /// 还原为可查询状态；by_path 重建（百万条排序 ~1s，发生在后台线程）。
    /// 版本不符返回 None（调用方全量重建）。
    pub fn into_state(self) -> Option<EngineState> {
        if self.version != SNAPSHOT_VERSION {
            return None;
        }
        let mut state = EngineState {
            arena: PathArena::from_bytes(self.buf),
            meta: self.meta,
            grams: self.grams,
            by_path: Vec::new(),
            roots_fp: self.roots_fp,
            root_mtimes: self.root_mtimes,
        };
        state.rebuild_by_path();
        Some(state)
    }
}

/// 原子保存：先写 `path.tmp` 再 rename（进程被杀不会留下半截快照）
pub fn save_snapshot(path: &Path, snap: &Snapshot) -> Result<(), String> {
    let bytes =
        bincode::serialize(snap).map_err(|e| format!("SNAPSHOT_ENCODE|快照序列化失败：{e}"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("SNAPSHOT_IO|创建索引目录失败：{e}"))?;
    }
    let tmp = path.with_extension("bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("SNAPSHOT_IO|写快照失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("SNAPSHOT_IO|快照落盘失败：{e}"))
}

/// 加载快照：文件缺失 / 损坏 / 版本不符 → None（调用方全量重建）
pub fn load_snapshot(path: &Path) -> Option<EngineState> {
    let bytes = fs::read(path).ok()?;
    let snap: Snapshot = bincode::deserialize(&bytes).ok()?;
    snap.into_state()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::MatchMode;
    use crate::walk::RawEntry;

    #[test]
    fn roundtrip() {
        let st = EngineState::build(
            vec![
                RawEntry { path: "/x/alpha.txt".into(), is_dir: false, size: 3, mtime: 111, dir_mtime: 0 },
                RawEntry { path: "/x/beta".into(), is_dir: true, size: 0, mtime: 222, dir_mtime: 222 },
            ],
            99,
            vec![333],
        );
        let dir = std::env::temp_dir().join(format!("rdir_index_snap_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("snapshot.bin");
        save_snapshot(&path, &Snapshot::from_state(&st)).unwrap();

        let loaded = load_snapshot(&path).expect("加载成功");
        assert_eq!(loaded.len(), st.len());
        assert_eq!(loaded.roots_fp, 99);
        assert_eq!(loaded.root_mtimes, vec![333]);
        let hits = loaded.query("alpha", MatchMode::Contains, false, None, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/x/alpha.txt");
        assert_eq!(hits[0].size, 3);

        // 文件损坏 → None（触发重建）
        fs::write(&path, b"garbage").unwrap();
        assert!(load_snapshot(&path).is_none());

        fs::remove_dir_all(&dir).ok();
    }
}
