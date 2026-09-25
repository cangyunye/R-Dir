//! 目录差异比对（v0.17 右键「差异比对」）。
//! 一层：名称比对（左右目录的条目名集合差异）。
//! 二层：同名文件比对内容大小。
//! 三层：同名文件比对内容 hash 与修改时间戳。
//! 仅比对顶层（不递归），与 Windows「同步」类工具的目录级比对语义一致。

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use crate::fs_ops::FileEntry;

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
    /// 差异原因（二层/三层）："size" | "content" | "mtime"
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

/// FNV-1a 64 位流式哈希（确定性、无依赖；仅用于比对相等性）
fn fnv1a_file(path: &Path) -> std::io::Result<u64> {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut f = std::fs::File::open(path)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    Ok(h)
}

/// 比对两个目录的顶层条目；level ∈ {1,2,3}。
pub fn diff_dirs(left: &str, right: &str, level: u8) -> Result<Vec<DiffEntry>, String> {
    let l = crate::fs_ops::list_dir(left)?;
    let r = crate::fs_ops::list_dir(right)?;
    let mut map: HashMap<String, (Option<FileEntry>, Option<FileEntry>)> = HashMap::new();
    for e in l {
        let name = e.name.clone();
        map.entry(name).or_default().0 = Some(e);
    }
    for e in r {
        let name = e.name.clone();
        map.entry(name).or_default().1 = Some(e);
    }

    let mut out = Vec::with_capacity(map.len());
    for (name, (le, re)) in map {
        match (le, re) {
            (Some(l), None) => out.push(DiffEntry {
                name,
                is_dir: l.is_dir,
                left: Some(side(&l)),
                right: None,
                status: "left-only".into(),
                reason: None,
            }),
            (None, Some(r)) => out.push(DiffEntry {
                name,
                is_dir: r.is_dir,
                left: None,
                right: Some(side(&r)),
                status: "right-only".into(),
                reason: None,
            }),
            (Some(l), Some(r)) => {
                let is_dir = l.is_dir || r.is_dir;
                let (status, reason) = if is_dir || level <= 1 {
                    // 目录只比名称；一层只比名称
                    ("same".to_string(), None)
                } else if l.size != r.size {
                    ("different".to_string(), Some("size".to_string()))
                } else if level >= 3 {
                    let lh = fnv1a_file(Path::new(&l.path)).ok();
                    let rh = fnv1a_file(Path::new(&r.path)).ok();
                    if lh != rh {
                        ("different".to_string(), Some("content".to_string()))
                    } else if l.modified != r.modified {
                        ("different".to_string(), Some("mtime".to_string()))
                    } else {
                        ("same".to_string(), None)
                    }
                } else {
                    ("same".to_string(), None)
                };
                out.push(DiffEntry {
                    name,
                    is_dir,
                    left: Some(side(&l)),
                    right: Some(side(&r)),
                    status,
                    reason,
                });
            }
            (None, None) => {}
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
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
}
