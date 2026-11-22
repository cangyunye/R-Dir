//! 索引快照持久化：bincode 序列化 + 原子落盘（tmp + rename，仿 json_store）。
//!
//! 快照是**可重建缓存**（非用户数据）：版本不符 / 指纹不符 / 解码失败一律弃用
//! 触发全量重建，不做迁移。百万文件量级快照 ~100-150MB 磁盘、加载 <1s。

use crate::arena::PathArena;
use crate::engine::EngineState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use bincode::Options;

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

/// 快照体积 sanity 上限（2GB）：1M 条目级快照 ~100-150MB，此值已有 10× 余量。
/// 超限直接弃用重建——防御损坏/伪造文件的资源放大，也让「声明长度不得超过
/// 文件实际大小」成为显式契约。
const SNAPSHOT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// 加载快照：文件缺失 / 损坏 / 版本不符 → None（调用方全量重建）。
///
/// 编码配置与 `bincode::serialize`（save 侧）逐项对齐：fixint 长度前缀 +
/// 允许尾部字节——`bincode::options()` 缺省是 varint + 拒绝尾部，直接用会把
/// 存量快照全部解爆（静默退化为每次启动全量重建）。
/// `with_limit(bytes.len())` 把所有声明长度上限钉在文件实际大小上：损坏/
/// 伪造文件的巨大 Vec 长度前缀在分配前即被 SizeLimit 拒绝（切片路径本就有
/// SliceReader 越界检查 + serde 集合 1MB 预分配上限兜底，此 limit 是显式
/// 契约化——若未来改流式 `deserialize_from`，IoReader 会按声明长度 resize，
/// 没有这层 limit 就真会放大分配）。
pub fn load_snapshot(path: &Path) -> Option<EngineState> {
    if let Ok(md) = fs::metadata(path) {
        if md.len() > SNAPSHOT_MAX_BYTES {
            eprintln!("indexer 快照异常偏大（{md_len} 字节 > 上限），弃用重建", md_len = md.len());
            return None;
        }
    }
    let bytes = fs::read(path).ok()?;
    let snap: Snapshot = bincode::options()
        .with_fixint_encoding()
        .allow_trailing_bytes()
        .with_limit(bytes.len() as u64)
        .deserialize(&bytes)
        .ok()?;
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

    /// 伪造快照（声明长度远超文件实际大小）必须在分配前被拒绝：
    /// with_limit 把声明长度钉在文件大小上，巨大长度前缀 → SizeLimit 错误，
    /// 全链路 load_snapshot 返回 None 走重建——不能分配失败 abort 或 panic。
    #[test]
    fn malicious_length_prefix_rejected() {
        // Snapshot 字段序：version: u32, roots_fp: u64, root_mtimes: Vec<i64>,
        // buf: Vec<u8>（fixint 8 字节长度前缀）
        let mut evil: Vec<u8> = Vec::new();
        evil.extend(1u32.to_le_bytes()); // version = SNAPSHOT_VERSION
        evil.extend(0u64.to_le_bytes()); // roots_fp
        evil.extend(0u64.to_le_bytes()); // root_mtimes len = 0
        evil.extend(u64::MAX.to_le_bytes()); // buf len = u64::MAX ≫ 文件大小
        evil.extend_from_slice(b"tiny garbage");

        let decoded = bincode::options()
            .with_fixint_encoding()
            .allow_trailing_bytes()
            .with_limit(evil.len() as u64)
            .deserialize::<Snapshot>(&evil);
        assert!(decoded.is_err(), "巨大声明长度必须被 SizeLimit 拒绝");

        let dir = std::env::temp_dir().join(format!("rdir_index_evil_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("snapshot.bin");
        fs::write(&path, &evil).unwrap();
        assert!(load_snapshot(&path).is_none(), "伪造快照必须弃用重建");
        fs::remove_dir_all(&dir).ok();
    }

    /// 编码对齐回归：save（bincode::serialize = fixint）写出的存量快照，
    /// load 侧 options()+fixint+trailing 配置必须原样解出——否则升级后
    /// 每次启动都静默全量重建。
    #[test]
    fn load_matches_save_encoding() {
        let st = EngineState::build(
            vec![RawEntry { path: "/x/a.txt".into(), is_dir: false, size: 1, mtime: 1, dir_mtime: 0 }],
            7,
            vec![9],
        );
        let dir = std::env::temp_dir().join(format!("rdir_index_enc_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("snapshot.bin");
        save_snapshot(&path, &Snapshot::from_state(&st)).unwrap();
        let loaded = load_snapshot(&path).expect("save/load 编码必须一致");
        assert_eq!(loaded.len(), 1);
        fs::remove_dir_all(&dir).ok();
    }
}
