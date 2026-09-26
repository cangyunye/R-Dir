//! 目录差异比对（v0.17 右键「差异比对」，v0.18 增强）。
//! 一层：名称比对（左右目录的条目名集合差异）。
//! 二层：同名文件比对内容大小。
//! 三层：同名文件比对内容 hash 与修改时间戳。
//! 仅比对顶层（不递归），与 Windows「同步」类工具的目录级比对语义一致。
//!
//! v0.18 增强：
//! - 支持中途取消（`AtomicBool` 取消标记）与进度回调（`DiffProgress`）。
//! - 识别「同名但一侧目录一侧文件」的类型冲突（reason = "type"）。
//! - 名称匹配可配置大小写敏感；三层时间戳比较支持容差（跨文件系统精度差异）。
//! - 三层 hash 阶段单独推送进度，便于前端展示「正在比较」的进度。

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::fs_ops::FileEntry;

/// 三层 mtime 比较默认容差：跨文件系统（FAT/exFAT 2s 粒度、网络盘）常有时差噪声。
pub const DEFAULT_MTIME_TOLERANCE_MS: i64 = 2000;

/// 比对选项。
#[derive(Clone, Debug)]
pub struct DiffOptions {
    /// 1 名称 / 2 大小 / 3 hash+时间戳
    pub level: u8,
    /// 名称匹配是否区分大小写（Windows/macOS 文件系统不敏感）
    pub case_sensitive: bool,
    /// 三层 mtime 容差（毫秒）；差值的绝对值不超过容差视为相同
    pub mtime_tolerance_ms: i64,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            level: 1,
            case_sensitive: true,
            mtime_tolerance_ms: DEFAULT_MTIME_TOLERANCE_MS,
        }
    }
}

/// 比对进度（camelCase 输出）。前端据此在下方展示进度与「停止」。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffProgress {
    /// 任务标识（用于取消命令定位）
    pub id: String,
    /// "compare"（逐条比对）| "hash"（三层逐文件哈希）
    pub phase: String,
    pub done: usize,
    pub total: usize,
    /// 当前处理的条目/文件名（展示用）
    pub current: String,
    /// 全部完成
    pub done_all: bool,
    /// 用户已取消
    pub cancelled: bool,
}

/// 比对结果。`cancelled=true` 时 `entries` 为不完整结果，前端应丢弃。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOutcome {
    pub entries: Vec<DiffEntry>,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSide {
    pub path: String,
    pub size: u64,
    pub modified: Option<i64>,
    pub is_dir: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub name: String,
    pub is_dir: bool,
    pub left: Option<DiffSide>,
    pub right: Option<DiffSide>,
    /// "left-only" | "right-only" | "same" | "different"
    pub status: String,
    /// 差异原因：二层/三层 "size" | "content" | "mtime"；类型冲突 "type"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn side(e: &FileEntry) -> DiffSide {
    DiffSide {
        path: e.path.clone(),
        size: e.size,
        modified: e.modified,
        is_dir: e.is_dir,
    }
}

fn name_key(name: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        name.to_string()
    } else {
        name.to_lowercase()
    }
}

/// 三层哈希结果：正常值 / 被取消 / 读取失败。
enum HashOutcome {
    Ok(u64),
    Cancelled,
    Error,
}

/// FNV-1a 64 位流式哈希（确定性、无依赖；仅用于比对相等性）。
/// 支持取消：每读一块检查一次，保证大文件也能及时停止。
fn fnv1a_file(path: &Path, cancel: &AtomicBool) -> HashOutcome {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return HashOutcome::Error,
    };
    let mut buf = [0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return HashOutcome::Cancelled;
        }
        let n = match f.read(&mut buf) {
            Ok(n) => n,
            Err(_) => return HashOutcome::Error,
        };
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    HashOutcome::Ok(h)
}

/// 比对两个目录的顶层条目，支持进度回调与取消。
/// 本地专用入口：内部列目录后转交 [`compare_entries`]。
pub fn compare<F: FnMut(&DiffProgress)>(
    id: &str,
    left: &str,
    right: &str,
    opts: &DiffOptions,
    cancel: &AtomicBool,
    mut emit: F,
) -> Result<DiffOutcome, String> {
    let l = crate::fs_ops::list_dir(left)?;
    let r = crate::fs_ops::list_dir(right)?;
    compare_entries(id, l, r, opts, cancel, emit)
}

/// 纯比对核心（v0.18 同步比对抽象点）：输入两侧条目集合，不感知任何后端协议。
/// 本地与 SFTP 的条目都是 `fs_ops::FileEntry`，未来其他后端（S3/网盘）同样只喂这个结构。
/// 注意：level >= 3 时 hash 阶段按 `entry.path` 走 `std::fs` 读取，仅对本地条目有意义；
/// 含远程侧时调用方必须先把 level 钳制到 2 以内（见 lib.rs 的能力表）。
pub fn compare_entries<F: FnMut(&DiffProgress)>(
    id: &str,
    left: Vec<FileEntry>,
    right: Vec<FileEntry>,
    opts: &DiffOptions,
    cancel: &AtomicBool,
    mut emit: F,
) -> Result<DiffOutcome, String> {
    // 名称 → (展示名, 左侧, 右侧)。大小写不敏感时以 lower(key) 归并同名条目。
    let mut map: HashMap<String, (String, Option<FileEntry>, Option<FileEntry>)> = HashMap::new();
    for e in left {
        let name = e.name.clone();
        let key = name_key(&name, opts.case_sensitive);
        map.entry(key)
            .or_insert_with(|| (name.clone(), None, None))
            .1 = Some(e);
    }
    for e in right {
        let name = e.name.clone();
        let key = name_key(&name, opts.case_sensitive);
        let slot = map.entry(key).or_insert_with(|| (name.clone(), None, None));
        // 优先展示左侧名称；仅右侧存在时用右侧名称
        if slot.1.is_none() {
            slot.0 = name;
        }
        slot.2 = Some(e);
    }

    let total = map.len();
    let mut out: Vec<DiffEntry> = Vec::with_capacity(total);
    // 三层待哈希项：out 下标 + 左右 FileEntry
    let mut pending: Vec<(usize, FileEntry, FileEntry)> = Vec::new();
    let mut done = 0usize;
    let mut last = Instant::now();

    for (_, (name, le, re)) in map {
        if cancel.load(Ordering::Relaxed) {
            return Ok(DiffOutcome { entries: out, cancelled: true });
        }
        let (entry, hash_pair) = classify(name, le, re, opts);
        done += 1;
        if let Some(pair) = hash_pair {
            pending.push((out.len(), pair.0, pair.1));
        }
        out.push(entry);
        if last.elapsed() >= Duration::from_millis(80) || done == total {
            emit(&DiffProgress {
                id: id.into(),
                phase: "compare".into(),
                done,
                total,
                current: out.last().map(|e| e.name.clone()).unwrap_or_default(),
                done_all: false,
                cancelled: false,
            });
            last = Instant::now();
        }
    }

    // 三层：逐文件哈希，进度单独推送。
    if opts.level >= 3 && !pending.is_empty() {
        let hash_total = pending.len();
        for (i, (idx, a, b)) in pending.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Ok(DiffOutcome { entries: out, cancelled: true });
            }
            let (status, reason) = hash_verdict(a, b, opts, cancel);
            if let Some(entry) = out.get_mut(*idx) {
                entry.status = status;
                entry.reason = reason;
            }
            if last.elapsed() >= Duration::from_millis(80) || i + 1 == hash_total {
                emit(&DiffProgress {
                    id: id.into(),
                    phase: "hash".into(),
                    done: i + 1,
                    total: hash_total,
                    current: b.name.clone(),
                    done_all: false,
                    cancelled: false,
                });
                last = Instant::now();
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    emit(&DiffProgress {
        id: id.into(),
        phase: "compare".into(),
        done: total,
        total,
        current: String::new(),
        done_all: true,
        cancelled: false,
    });
    Ok(DiffOutcome { entries: out, cancelled: false })
}

/// 判定单条目的状态；三层中「同名同大小的文件」延迟到 hash 阶段再定论。
fn classify(
    name: String,
    le: Option<FileEntry>,
    re: Option<FileEntry>,
    opts: &DiffOptions,
) -> (DiffEntry, Option<(FileEntry, FileEntry)>) {
    let is_dir = match (&le, &re) {
        (Some(a), Some(b)) => a.is_dir && b.is_dir,
        (Some(a), None) => a.is_dir,
        (None, Some(b)) => b.is_dir,
        (None, None) => false,
    };
    let mut hash_pair = None;
    let (status, reason): (String, Option<String>) = match (&le, &re) {
        (Some(_), None) => ("left-only".into(), None),
        (None, Some(_)) => ("right-only".into(), None),
        (Some(a), Some(b)) => {
            if a.is_dir != b.is_dir {
                // 同名但类型不同：目录 vs 文件，属结构性冲突
                ("different".into(), Some("type".into()))
            } else if a.is_dir {
                // 目录仅比名称（顶层，不递归）
                ("same".into(), None)
            } else if opts.level <= 1 {
                ("same".into(), None)
            } else if a.size != b.size {
                ("different".into(), Some("size".into()))
            } else if opts.level >= 3 {
                hash_pair = Some((a.clone(), b.clone()));
                ("same".into(), None)
            } else {
                ("same".into(), None)
            }
        }
        (None, None) => ("same".into(), None),
    };
    (
        DiffEntry {
            name,
            is_dir,
            left: le.as_ref().map(side),
            right: re.as_ref().map(side),
            status,
            reason,
        },
        hash_pair,
    )
}

/// 三层同名同大小文件的最终判定：hash 不同 → content；hash 相同但时间超容差 → mtime。
fn hash_verdict(
    a: &FileEntry,
    b: &FileEntry,
    opts: &DiffOptions,
    cancel: &AtomicBool,
) -> (String, Option<String>) {
    let (lh, rh) = match (fnv1a_file(Path::new(&a.path), cancel), fnv1a_file(Path::new(&b.path), cancel)) {
        (_, HashOutcome::Cancelled) | (HashOutcome::Cancelled, _) => {
            return ("same".into(), None);
        }
        (HashOutcome::Ok(x), HashOutcome::Ok(y)) => (Some(x), Some(y)),
        // 任一侧读取失败：无法确认相等，按内容差异处理
        _ => (None, None),
    };
    match (lh, rh) {
        (Some(x), Some(y)) if x != y => ("different".into(), Some("content".into())),
        (None, None) => ("different".into(), Some("content".into())),
        _ => match (a.modified, b.modified) {
            (Some(x), Some(y)) if (x - y).abs() > opts.mtime_tolerance_ms => {
                ("different".into(), Some("mtime".into()))
            }
            // 一侧缺失时间戳时按差异处理，提示用户注意
            (Some(_), None) | (None, Some(_)) => ("different".into(), Some("mtime".into())),
            _ => ("same".into(), None),
        },
    }
}

/// 兼容旧调用（v0.17 测试用）：默认选项 + 不取消。
pub fn diff_dirs(left: &str, right: &str, level: u8) -> Result<Vec<DiffEntry>, String> {
    let cancel = AtomicBool::new(false);
    let opts = DiffOptions {
        level,
        ..Default::default()
    };
    compare("", left, right, &opts, &cancel, |_| {}).map(|o| o.entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rdir-diff-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn compare_with(left: &std::path::Path, right: &std::path::Path, level: u8) -> Vec<DiffEntry> {
        let cancel = AtomicBool::new(false);
        let opts = DiffOptions {
            level,
            ..Default::default()
        };
        compare("t", &left.to_string_lossy(), &right.to_string_lossy(), &opts, &cancel, |_| {})
            .unwrap()
            .entries
    }

    #[test]
    fn level1_reports_name_diff() {
        let base = tmp("l1");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("only-left.txt"), b"x").unwrap();
        fs::write(b.join("only-right.txt"), b"y").unwrap();
        fs::write(a.join("both.txt"), b"same").unwrap();
        fs::write(b.join("both.txt"), b"same").unwrap();

        let d = diff_dirs(&a.to_string_lossy(), &b.to_string_lossy(), 1).unwrap();
        let by = |n: &str| d.iter().find(|e| e.name == n).unwrap().status.clone();
        assert_eq!(by("only-left.txt"), "left-only");
        assert_eq!(by("only-right.txt"), "right-only");
        assert_eq!(by("both.txt"), "same"); // 一层只比名称
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn level2_detects_size_diff() {
        let base = tmp("l2");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("f.txt"), b"12345").unwrap();
        fs::write(b.join("f.txt"), b"123").unwrap();

        let d = diff_dirs(&a.to_string_lossy(), &b.to_string_lossy(), 2).unwrap();
        let e = d.iter().find(|e| e.name == "f.txt").unwrap();
        assert_eq!(e.status, "different");
        assert_eq!(e.reason.as_deref(), Some("size"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn level3_detects_content_diff_same_size() {
        let base = tmp("l3");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        // 同大小、不同内容 → 二层看不出，三层 hash 能看出
        fs::write(a.join("f.bin"), b"AAAA").unwrap();
        fs::write(b.join("f.bin"), b"BBBB").unwrap();

        let l2 = diff_dirs(&a.to_string_lossy(), &b.to_string_lossy(), 2).unwrap();
        assert_eq!(l2.iter().find(|e| e.name == "f.bin").unwrap().status, "same");

        let l3 = diff_dirs(&a.to_string_lossy(), &b.to_string_lossy(), 3).unwrap();
        let e = l3.iter().find(|e| e.name == "f.bin").unwrap();
        assert_eq!(e.status, "different");
        assert_eq!(e.reason.as_deref(), Some("content"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn type_conflict_is_different_at_all_levels() {
        let base = tmp("type");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(a.join("item")).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(b.join("item"), b"file").unwrap();

        for level in [1u8, 2, 3] {
            let d = compare_with(&a, &b, level);
            let e = d.iter().find(|e| e.name == "item").unwrap();
            assert_eq!(e.status, "different", "level {level}");
            assert_eq!(e.reason.as_deref(), Some("type"), "level {level}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn level3_mtime_within_tolerance_is_same() {
        let base = tmp("mtime-tol");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("f.txt"), b"same").unwrap();
        fs::write(b.join("f.txt"), b"same").unwrap();

        let cancel = AtomicBool::new(false);
        let opts = DiffOptions {
            level: 3,
            mtime_tolerance_ms: i64::MAX, // 任意时差都视为相同
            ..Default::default()
        };
        let out = compare("t", &a.to_string_lossy(), &b.to_string_lossy(), &opts, &cancel, |_| {})
            .unwrap();
        let e = out.entries.iter().find(|e| e.name == "f.txt").unwrap();
        assert_eq!(e.status, "same");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn case_insensitive_merges_names() {
        let base = tmp("case");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("Readme.md"), b"x").unwrap();
        fs::write(b.join("readme.md"), b"x").unwrap();

        let cancel = AtomicBool::new(false);
        let sensitive = DiffOptions {
            level: 1,
            case_sensitive: true,
            ..Default::default()
        };
        let out = compare("t", &a.to_string_lossy(), &b.to_string_lossy(), &sensitive, &cancel, |_| {})
            .unwrap();
        assert_eq!(out.entries.len(), 2, "大小写敏感 → 两条独立条目");

        let insensitive = DiffOptions {
            level: 1,
            case_sensitive: false,
            ..Default::default()
        };
        let out = compare("t", &a.to_string_lossy(), &b.to_string_lossy(), &insensitive, &cancel, |_| {})
            .unwrap();
        assert_eq!(out.entries.len(), 1, "不敏感 → 合并为一条");
        assert_eq!(out.entries[0].status, "same");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cancel_stops_and_reports() {
        let base = tmp("cancel");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        for i in 0..20 {
            fs::write(a.join(format!("f{i}.txt")), b"x").unwrap();
            fs::write(b.join(format!("f{i}.txt")), b"x").unwrap();
        }

        let cancel = AtomicBool::new(true); // 立刻取消
        let opts = DiffOptions {
            level: 3,
            ..Default::default()
        };
        let out = compare("t", &a.to_string_lossy(), &b.to_string_lossy(), &opts, &cancel, |_| {})
            .unwrap();
        assert!(out.cancelled, "应报告已取消");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn emits_progress_and_done() {
        let base = tmp("progress");
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("f.txt"), b"x").unwrap();
        fs::write(b.join("f.txt"), b"x").unwrap();

        let cancel = AtomicBool::new(false);
        let opts = DiffOptions {
            level: 3,
            ..Default::default()
        };
        let mut last_done = false;
        let mut last_phase = String::new();
        let _ = compare(
            "t",
            &a.to_string_lossy(),
            &b.to_string_lossy(),
            &opts,
            &cancel,
            |p| {
                last_done = p.done_all;
                last_phase = p.phase.clone();
            },
        )
        .unwrap();
        assert!(last_done, "最后应推送 doneAll");
        assert_eq!(last_phase, "compare");
        let _ = fs::remove_dir_all(&base);
    }

    // ---- v0.18 compare_entries 纯函数（不经过文件系统，直接喂 FileEntry）----

    fn fe(name: &str, is_dir: bool, size: u64) -> FileEntry {
        FileEntry {
            name: name.into(),
            path: format!("/fake/{name}"),
            is_dir,
            is_symlink: false,
            size,
            modified: Some(1_000),
            created: None,
            permissions: String::new(),
            extension: String::new(),
        }
    }

    fn run_entries(l: Vec<FileEntry>, r: Vec<FileEntry>, level: u8) -> Vec<DiffEntry> {
        let cancel = AtomicBool::new(false);
        let opts = DiffOptions {
            level,
            ..Default::default()
        };
        compare_entries("t", l, r, &opts, &cancel, |_| {})
            .unwrap()
            .entries
    }

    #[test]
    fn entries_only_sides_reported() {
        let d = run_entries(vec![fe("a.txt", false, 1)], vec![fe("b.txt", false, 2)], 1);
        assert_eq!(d.iter().find(|e| e.name == "a.txt").unwrap().status, "left-only");
        assert_eq!(d.iter().find(|e| e.name == "b.txt").unwrap().status, "right-only");
    }

    #[test]
    fn entries_type_conflict() {
        let d = run_entries(vec![fe("item", true, 0)], vec![fe("item", false, 4)], 2);
        let e = d.iter().find(|x| x.name == "item").unwrap();
        assert_eq!(e.status, "different");
        assert_eq!(e.reason.as_deref(), Some("type"));
    }

    #[test]
    fn entries_level2_same_size_is_same_without_hash() {
        // 同名同大小但路径不存在于本地：层 2 不进入 hash 阶段（hash 仅层 3，且调用方
        // 须保证两侧本地），因此不会因读不到 /fake/... 而误判为内容差异
        let d = run_entries(vec![fe("f.bin", false, 10)], vec![fe("f.bin", false, 10)], 2);
        assert_eq!(d.iter().find(|x| x.name == "f.bin").unwrap().status, "same");
    }

    #[test]
    fn entries_case_insensitive_merge() {
        let cancel = AtomicBool::new(false);
        let opts = DiffOptions {
            level: 1,
            case_sensitive: false,
            ..Default::default()
        };
        let out = compare_entries(
            "t",
            vec![fe("Readme.md", false, 5)],
            vec![fe("readme.md", false, 5)],
            &opts,
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].status, "same");
    }
}
