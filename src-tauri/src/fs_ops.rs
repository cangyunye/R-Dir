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
    fn from_path(path: PathBuf) -> Self {
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        let symlink_meta = std::fs::symlink_metadata(&path);
        let meta = std::fs::metadata(&path); // 跟随符号链接
        let is_symlink = symlink_meta
            .as_ref()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
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
        .filter(|e| {
            #[cfg(target_os = "windows")]
            {
                !is_legacy_known_folder(&e.file_name().to_string_lossy())
            }
            #[cfg(not(target_os = "windows"))]
            {
                true
            }
        })
        .map(|e| FileEntry::from_path(e.path()))
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
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
