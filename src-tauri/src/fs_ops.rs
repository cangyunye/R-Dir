use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 单个文件/目录条目，默认字段对齐 lsd：名称、大小、修改时间、类型、权限。
#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix 毫秒时间戳
    pub modified: Option<i64>,
    pub created: Option<i64>,
    /// 权限字符串，unix 为 "drwxr-xr-x" 风格
    pub permissions: String,
    /// 小写扩展名（无点）
    pub extension: String,
}

impl FileEntry {
    /// 从 DirEntry 直接构造：用枚举时已拿到的 file_type/metadata，避免对每个条目
    /// 再做一次 symlink_metadata + metadata 的双重 stat（大目录下 2N 次 syscall 极慢）。
    fn from_direntry(entry: std::fs::DirEntry) -> Self {
        let path = entry.path();
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        // DirEntry.file_type() 来自目录枚举本身，零额外 syscall
        let ft = entry.file_type();
        let is_symlink = ft.as_ref().map(|f| f.is_symlink()).unwrap_or(false);
        let is_dir_fallback = ft.as_ref().map(|f| f.is_dir()).unwrap_or(false);
        // DirEntry.metadata() 一次 syscall（比 symlink_metadata+metadata 两次少一半）
        let meta = entry.metadata();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(is_dir_fallback);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = meta
            .as_ref()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let created = meta
            .as_ref()
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let permissions = meta.as_ref().map(perm_string).unwrap_or_default();
        let extension = path
            .extension()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        Self {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            is_symlink,
            size,
            modified,
            created,
            permissions,
            extension,
        }
    }
}

/// Windows：跳过 Known Folder 历史残留目录（旧系统升级遗留的 My Music / My Pictures /
/// My Videos / My Documents 等）。资源管理器通过 shell 命名空间隐藏它们，R-Dir 直接过滤，
/// 避免文件列表出现点击后"没有权限访问"的幽灵目录。
#[cfg(target_os = "windows")]
fn is_legacy_known_folder(name: &str) -> bool {
    let n = name.to_lowercase();
    matches!(
        n.as_str(),
        "my music" | "my pictures" | "my videos" | "my documents"
    )
}

/// 读取目录并返回排序后的条目：目录优先，再按名称（不区分大小写）。
pub fn list_dir(path: &str) -> Result<Vec<FileEntry>, String> {
    let p = Path::new(path);
    let rd = std::fs::read_dir(p).map_err(|e| format!("无法读取目录 {}：{}", path, e))?;
    let mut entries: Vec<FileEntry> = rd
        .filter_map(|e| e.ok())
        .filter(|_e| {
            #[cfg(target_os = "windows")]
            {
                !is_legacy_known_folder(&_e.file_name().to_string_lossy())
            }
            #[cfg(not(target_os = "windows"))]
            {
                true
            }
        })
        .map(FileEntry::from_direntry)
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 读取单个路径的元信息（「属性」统计当前目录/单条路径用）。
pub fn stat_entry(path: &str) -> Result<FileEntry, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("无法读取 {}：{}", path, e))?;
    let is_dir = meta.is_dir();
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.trim_end_matches(['/', '\\']).to_string());
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let extension = p
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Ok(FileEntry {
        name,
        path: path.to_string(),
        is_dir,
        is_symlink: meta.file_type().is_symlink(),
        size: if is_dir { 0 } else { meta.len() },
        modified,
        created,
        permissions: perm_string(&meta),
        extension,
    })
}

/// 目录路径补全：输入前缀（支持 "~"），返回匹配的目录完整路径，最多 50 个。
/// 相对路径以 cwd 为基准。
pub fn complete_path(input: &str, cwd: &str) -> Vec<String> {
    let expanded = if input == "~" {
        dirs::home_dir().unwrap_or_default()
    } else if let Some(rest) = input.strip_prefix("~/") {
        dirs::home_dir()
            .map(|h| h.join(rest))
            .unwrap_or_else(|| PathBuf::from(input))
    } else {
        PathBuf::from(input)
    };

    let (base, prefix) = match expanded.parent() {
        Some(parent) => (
            parent.to_path_buf(),
            expanded
                .file_name()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
        ),
        None => (expanded.clone(), String::new()),
    };
    // 相对路径（如 "Doc"）parent 为空，回退到 cwd
    let base = if base.as_os_str().is_empty() || base == Path::new(".") {
        PathBuf::from(cwd)
    } else {
        base
    };

    let mut results = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&base) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if !lower.starts_with(&prefix) || lower == prefix {
                continue;
            }
            if let Ok(ft) = e.file_type() {
                if ft.is_dir() {
                    let full = base.join(&name);
                    results.push(full.to_string_lossy().to_string());
                }
            }
        }
    }
    results.sort();
    results.truncate(50);
    results
}

#[cfg(unix)]
fn perm_string(md: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    let mode = md.permissions().mode();
    let mut s = String::with_capacity(10);
    s.push(if md.is_dir() {
        'd'
    } else if md.file_type().is_symlink() {
        'l'
    } else {
        '-'
    });
    for shift in [6usize, 3, 0] {
        let bits = (mode >> shift) & 0o7;
        s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
        s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
        s.push(if bits & 0o1 != 0 { 'x' } else { '-' });
    }
    s
}

#[cfg(windows)]
fn perm_string(md: &std::fs::Metadata) -> String {
    use std::os::windows::fs::MetadataExt;
    let attrs = md.file_attributes();
    if attrs & 0x1 != 0 {
        "r--".to_string()
    } else {
        "rw-".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rdir-fsops-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn list_dir_puts_dirs_first_then_name_order() {
        let base = tmp("list-order");
        std::fs::create_dir_all(base.join("zdir")).unwrap();
        std::fs::create_dir_all(base.join("adir")).unwrap();
        std::fs::write(base.join("b.txt"), b"bb").unwrap();
        std::fs::write(base.join("a.txt"), b"a").unwrap();

        let got: Vec<String> = list_dir(&base.to_string_lossy())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(got, vec!["adir", "zdir", "a.txt", "b.txt"]);
    }

    #[test]
    fn list_dir_fills_metadata_fields() {
        let base = tmp("list-meta");
        std::fs::write(base.join("hello.TXT"), b"12345").unwrap();
        let e = list_dir(&base.to_string_lossy())
            .unwrap()
            .into_iter()
            .find(|e| e.name == "hello.TXT")
            .expect("应列出 hello.TXT");

        assert!(!e.is_dir);
        assert!(!e.is_symlink);
        assert_eq!(e.size, 5);
        assert_eq!(e.extension, "txt", "扩展名应小写且不带点");
        assert_eq!(e.path, base.join("hello.TXT").to_string_lossy());
        assert!(e.modified.is_some());
        assert!(!e.permissions.is_empty());
    }

    #[test]
    fn list_dir_missing_path_errors_without_panic() {
        let base = tmp("list-missing");
        let ghost = base.join("nope");
        assert!(list_dir(&ghost.to_string_lossy()).is_err());
    }

    #[test]
    fn complete_path_matches_dirs_only_and_respects_cwd() {
        let base = tmp("complete");
        std::fs::create_dir_all(base.join("Documents")).unwrap();
        std::fs::create_dir_all(base.join("Downloads")).unwrap();
        std::fs::write(base.join("Doc.txt"), b"x").unwrap();
        let cwd = base.to_string_lossy().to_string();

        let hits = complete_path("Do", &cwd);
        assert_eq!(hits.len(), 2, "只补全目录，Doc.txt 不应出现：{hits:?}");
        assert!(hits[0].ends_with("Documents"));
        assert!(hits[1].ends_with("Downloads"));

        assert!(complete_path("nomatch", &cwd).is_empty());
        assert_eq!(complete_path("Do", &cwd).len(), 2, "结果应稳定可重复");
    }

    #[test]
    fn complete_path_caps_at_50_results() {
        let base = tmp("complete-cap");
        for i in 0..60 {
            std::fs::create_dir_all(base.join(format!("d{i:02}"))).unwrap();
        }
        assert_eq!(complete_path("d", &base.to_string_lossy()).len(), 50);
    }

    #[test]
    fn stat_entry_reports_dir_and_file() {
        let base = tmp("stat-entry");
        std::fs::write(base.join("a.txt"), b"hello").unwrap();

        let de = stat_entry(&base.to_string_lossy()).unwrap();
        assert!(de.is_dir, "目录");
        assert_eq!(de.size, 0);
        assert!(!de.permissions.is_empty());

        let fe = stat_entry(&base.join("a.txt").to_string_lossy()).unwrap();
        assert!(!fe.is_dir);
        assert_eq!(fe.size, 5);
        assert_eq!(fe.name, "a.txt");
        assert_eq!(fe.extension, "txt");
    }
}
