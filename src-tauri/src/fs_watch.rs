//! 目录内容监视（v0.26.1）：让「程序外新增/删除/改名」的文件变化刷新到已打开的窗体。
//!
//! 方案与 `volumes.rs` 的卷监视一致——后台线程轮询 + 集合签名比对，不引入新依赖：
//! 前端把「所有标签里全部本地窗格的当前目录」经 `fs_watch_set` 全量上报，后台线程
//! 每 2 秒对每个目录做一次 `read_dir` 签名（条目名+目录标记，排序后拼接），签名
//! 变化的目录经 `fs://changed` 事件批量推送；前端把事件目录对应的窗格 `refreshKey`
//! +1 触发重读（含 keep-alive 的非活动标签——激活时按 key 失配自动重读）。
//! 首次纳入监视的目录不触发事件（前端刚导航过去，数据是新的）。
//! `read_dir` 只取名字与类型，典型目录开销微秒级；线程随进程退出而结束（detach）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// 前端上报的当前打开目录集合（全量替换）。上限防御：异常多的标签/窗格时截断，
/// 避免轮询成本失控（正常使用远达不到）。
const MAX_WATCH_DIRS: usize = 128;

static WATCH_DIRS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// 全量替换监视目录集合（前端在打开目录集合变化时调用）。
#[tauri::command]
pub fn fs_watch_set(dirs: Vec<String>) {
    let Ok(mut w) = WATCH_DIRS.lock() else {
        return;
    };
    *w = dirs
        .into_iter()
        .filter(|d| !d.trim().is_empty())
        .take(MAX_WATCH_DIRS)
        .collect();
}

/// 目录内容签名：条目名 + 目录标记 `/`，排序后拼接。目录不可读（已删除/无权限）返回 None。
fn dir_signature(dir: &Path) -> Option<String> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut items: Vec<(String, bool)> = rd
        .flatten()
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (e.file_name().to_string_lossy().to_string(), is_dir)
        })
        .collect();
    items.sort();
    let mut sig = String::new();
    for (name, is_dir) in items {
        sig.push_str(&name);
        if is_dir {
            sig.push('/');
        }
        sig.push('\u{2}');
    }
    Some(sig)
}

/// 后台轮询：签名变化的目录批量经 `fs://changed` 推送（载荷为目录路径数组）。
pub fn spawn_fs_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    thread::spawn(move || {
        // dir → 上次签名；None 签名（目录消失）也记录，避免每轮重复推送
        let mut last: BTreeMap<String, Option<String>> = BTreeMap::new();
        loop {
            thread::sleep(Duration::from_secs(2));
            let Ok(w) = WATCH_DIRS.lock() else {
                continue;
            };
            let dirs: Vec<String> = w.iter().cloned().collect();
            drop(w);
            let mut seen: BTreeSet<String> = BTreeSet::new();
            let mut changed: Vec<String> = Vec::new();
            for d in dirs {
                if !seen.insert(d.clone()) {
                    continue;
                }
                let sig = dir_signature(Path::new(&d));
                match last.get(&d) {
                    // 首次监视：记录基线，不触发刷新
                    None => {
                        last.insert(d, sig);
                    }
                    // 签名未变：无事
                    Some(prev) if *prev == sig => {}
                    // 变化（含目录消失）：推送并记录
                    Some(_) => {
                        last.insert(d.clone(), sig);
                        changed.push(d);
                    }
                }
            }
            // 清理不再监视的目录，避免 last 无限增长
            last.retain(|k, _| seen.contains(k));
            if !changed.is_empty() {
                let _ = app.emit("fs://changed", &changed);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_reflects_entries_and_type() {
        let base = std::env::temp_dir().join(format!("rdir-fswatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.txt"), b"x").unwrap();
        std::fs::create_dir(base.join("sub")).unwrap();

        let s1 = dir_signature(&base).unwrap();
        assert!(s1.contains("a.txt"));
        assert!(s1.contains("sub/"), "目录应带 / 标记：{s1}");

        // 新增文件 → 签名变化
        std::fs::write(base.join("b.txt"), b"y").unwrap();
        let s2 = dir_signature(&base).unwrap();
        assert_ne!(s1, s2);

        // 删除文件 → 签名变化
        std::fs::remove_file(base.join("b.txt")).unwrap();
        assert_eq!(dir_signature(&base).unwrap(), s1);

        // 改名 → 签名变化
        std::fs::rename(base.join("a.txt"), base.join("c.txt")).unwrap();
        assert_ne!(dir_signature(&base).unwrap(), s1);

        // 目录消失 → None
        std::fs::remove_dir_all(&base).unwrap();
        assert_eq!(dir_signature(&base), None);
    }

    #[test]
    fn fs_watch_set_filters_empty_and_caps_size() {
        // 直接调用命令处理函数（静态集合为进程级，测试后重置）
        fs_watch_set(vec!["/a".into(), "".into(), "  ".into(), "/b".into()]);
        let w = WATCH_DIRS.lock().unwrap();
        assert_eq!(w.len(), 2);
        assert!(w.contains("/a") && w.contains("/b"));
        drop(w);

        let many: Vec<String> = (0..(MAX_WATCH_DIRS + 10)).map(|i| format!("/d{i}")).collect();
        fs_watch_set(many);
        let w = WATCH_DIRS.lock().unwrap();
        assert_eq!(w.len(), MAX_WATCH_DIRS);
        drop(w);
        fs_watch_set(vec![]);
        assert!(WATCH_DIRS.lock().unwrap().is_empty());
    }
}
