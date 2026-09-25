//! 目录/文件递归大小统计（右键「属性」，v0.16）。
//! 迭代式 DFS（symlink_metadata 不跟随符号链接，避免重复计数/成环），
//! 按 ~80ms 节流通过回调推送增量进度，前端做滚动数字动画。

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// 最终统计结果（camelCase 输出）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeStat {
    pub bytes: u64,
    pub files: u64,
    pub dirs: u64,
}

/// 增量进度（camelCase 输出）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeProgress {
    pub id: String,
    pub bytes: u64,
    pub files: u64,
    pub dirs: u64,
    pub done: bool,
}

/// 统计给定路径集合的总字节/文件数/目录数；cancel 置位时提前结束。
/// 目录数不含传入的顶层路径本身（与 Windows「属性」的「文件夹」计数语义一致）。
/// 进度通过 `emit` 回调推送（由调用方桥接到 Tauri 事件，便于单测）。
pub fn compute<F: FnMut(&SizeProgress)>(
    id: &str,
    paths: &[String],
    cancel: &AtomicBool,
    mut emit: F,
) -> SizeStat {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut dirs = 0u64;
    let mut last = Instant::now();
    let mut stack: Vec<(PathBuf, bool)> = paths.iter().map(|p| (PathBuf::from(p), true)).collect();

    while let Some((p, is_root)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let md = match std::fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(_) => continue, // 无权限/已删除 → 跳过
        };
        let ft = md.file_type();
        if ft.is_symlink() {
            // 符号链接不递归，按 0 字节的文件计入
            files += 1;
        } else if md.is_dir() {
            if !is_root {
                dirs += 1;
            }
            if let Ok(rd) = std::fs::read_dir(&p) {
                for e in rd.flatten() {
                    stack.push((e.path(), false));
                }
            }
        } else {
            files += 1;
            bytes += md.len();
        }

        if last.elapsed() >= Duration::from_millis(80) {
            emit(&SizeProgress {
                id: id.into(),
                bytes,
                files,
                dirs,
                done: false,
            });
            last = Instant::now();
        }
    }

    emit(&SizeProgress {
        id: id.into(),
        bytes,
        files,
        dirs,
        done: true,
    });
    SizeStat { bytes, files, dirs }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn counts_bytes_files_dirs() {
        let dir = std::env::temp_dir().join(format!("rdir-sizestat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("sub").join("b.txt"), vec![0u8; 200]).unwrap();

        let cancel = AtomicBool::new(false);
        let stat = compute("t", &[dir.to_string_lossy().to_string()], &cancel, |_| {});
        assert_eq!(stat.bytes, 300, "总字节");
        assert_eq!(stat.files, 2, "文件数");
        assert_eq!(stat.dirs, 1, "目录数不含根");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emits_done_progress() {
        let dir = std::env::temp_dir().join(format!("rdir-sizestat-done-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x"), vec![0u8; 7]).unwrap();

        let cancel = AtomicBool::new(false);
        let mut last_done = false;
        let stat = compute("t", &[dir.to_string_lossy().to_string()], &cancel, |p| {
            last_done = p.done;
        });
        assert!(last_done, "最后应推送 done");
        assert_eq!(stat.bytes, 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_stops_early() {
        let cancel = AtomicBool::new(true);
        let stat = compute("t", &["/no/such/path".into()], &cancel, |_| {});
        assert_eq!(stat.bytes, 0);
        assert_eq!(stat.files, 0);
    }
}
