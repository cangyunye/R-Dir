//! 远程文件「打开」临时目录（后端无关：SFTP / HTTP 及未来远程存储共用）。
//! 双击/右键打开远程文件都先下载到这里再交给系统应用；默认 <temp>/r-dir-remote，
//! 可在设置中改为自定义目录；路径确定，程序可整体统计与清空。
//! 独立于 sftp feature（只碰文件系统），服务所有远程后端。
//!
//! v0.44.0 SFTP 按服务器分类：SFTP 打开下载与 SFTP↔SFTP 中转暂存都落在
//! `<root>/sftp/<host>/`（中转每次一个 `relay-<pid>-<序号>/` 子目录，用完即删），
//! 程序退出时整体清理本次会话用过的各根目录下的 `sftp/` 子树（[`TempRoots`]）；
//! HTTP / NFS 打开文件仍平铺在根目录，不受退出清理影响。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// SFTP 分类子目录名（`<root>/sftp/<host>/…`）
pub const SFTP_SUBDIR: &str = "sftp";

/// 默认临时目录：<temp>/r-dir-remote
pub fn open_temp_dir() -> PathBuf {
    std::env::temp_dir().join("r-dir-remote")
}

/// 解析生效的打开临时目录：未配置（None / 空串 / 纯空白）回退默认，否则原样使用自定义路径
pub fn resolve_temp_dir(custom: Option<&str>) -> PathBuf {
    match custom.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => open_temp_dir(),
    }
}

/// Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含 `NUL.txt` 这类带扩展名形式，
/// 大小写不敏感）：这类名字在 Windows 上无法作为普通文件/目录名
pub fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        s if s.len() == 4 && (s.starts_with("COM") || s.starts_with("LPT")) => {
            matches!(s.as_bytes()[3], b'1'..=b'9')
        }
        _ => false,
    }
}

/// 主机名 → 单段目录名（`<root>/sftp/<host>/` 的 host 段）：
/// - 仅保留字母/数字与 `. - _`，其余（IPv6 的 `[]:`、zone 的 `%`、空白、路径分隔符等）换 `_`
/// - 去掉首尾 `.`（首点会成隐藏目录、Windows 不允许尾点）
/// - 空串 / `.` / `..` 归一为 `_`（杜绝目录穿越）
/// - Windows 保留设备名前缀 `_`（各平台一致，目录布局不随平台变化）
pub fn sanitize_host(host: &str) -> String {
    let mapped: String = host
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut s = mapped.trim_matches('.').to_string();
    if s.is_empty() {
        return "_".into();
    }
    if is_windows_reserved(&s) {
        s.insert(0, '_');
    }
    s
}

/// 本地暂存文件名（v0.44.0 SFTP↔SFTP 中转用）：只替换本地文件系统存不下的字符，
/// 空格/括号/中文等一律原样保留——中转上传回远端时名称与源一致。
/// - 所有平台：`/` 与 NUL → `_`
/// - Windows：另含 `< > : " \ | ? *` 与控制字符 → `_`，去掉结尾的 `.` 与空格，保留设备名前缀 `_`
/// - 结果为空 / `.` / `..` → `_`
///
/// 固有限制：Windows 上本身不合法的远端名会被改写（本地暂存无法原样落盘）。
pub fn local_safe_name(name: &str) -> String {
    let win = cfg!(windows);
    let mapped: String = name
        .chars()
        .map(|c| {
            let bad = c == '/'
                || c == '\0'
                || (win
                    && (c.is_control()
                        || matches!(c, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*')));
            if bad {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut s = if win {
        mapped.trim_end_matches(['.', ' ']).to_string()
    } else {
        mapped
    };
    if s.is_empty() || s == "." || s == ".." {
        return "_".into();
    }
    if win && is_windows_reserved(&s) {
        s.insert(0, '_');
    }
    s
}

/// SFTP 分类目录：`<root>/sftp/<sanitize_host(host)>`（仅计算路径，不创建）
pub fn sftp_host_dir(root: &Path, host: &str) -> PathBuf {
    root.join(SFTP_SUBDIR).join(sanitize_host(host))
}

/// 中转暂存序号（进程内单调）：与 pid 组合成目录名，同进程并发中转、
/// GUI 与 rdir-web 双实例共用根目录时都不撞名
static RELAY_SEQ: AtomicU64 = AtomicU64::new(1);

/// 中转序号后缀：`<pid>-<进程内单调序号>`。暂存目录名（relay-<后缀>）与 B 端
/// 流式暂存文件名（.rdir-<后缀>.part）共用，防并发同名中转互踩、区分双实例
pub fn relay_suffix() -> String {
    let seq = RELAY_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}", std::process::id(), seq)
}

/// SFTP↔SFTP 中转暂存目录：`<root>/sftp/<host>/relay-<pid>-<序号>`（仅计算路径，不创建）
pub fn relay_stage_dir(root: &Path, host: &str) -> PathBuf {
    sftp_host_dir(root, host).join(format!("relay-{}", relay_suffix()))
}

/// 统计临时目录占用（文件数与总字节；目录不存在按空计）。
/// v0.44.0 递归统计：SFTP 文件分类进 `sftp/<host>/` 子目录后仍计入占用
/// （此前只数顶层文件，设置页会显示 0、「清理远程临时文件」误判已空而跳过）。
/// 不跟随符号链接（DirEntry 元数据为 lstat 语义），链接目标不计入、不成环。
pub fn temp_usage(dir: &Path) -> (u64, u32) {
    let mut bytes = 0u64;
    let mut files = 0u32;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else if m.is_file() {
                bytes += m.len();
                files = files.saturating_add(1);
            }
        }
    }
    (bytes, files)
}

/// 清空临时目录，返回释放的字节数（目录不存在视为已空）
pub fn clear_temp(dir: &Path) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let (bytes, _) = temp_usage(dir);
    std::fs::remove_dir_all(dir).map_err(|e| format!("清理临时目录失败：{e}"))?;
    Ok(bytes)
}

/// 尽力删除整棵目录树（v0.44.0 退出清理 / 中转收尾）：自底向上逐项删除，
/// 单项失败（Windows 上被外部程序占用的文件等）跳过继续、不中断整体，
/// 删不掉的项及其上级目录原样保留（下次清理再试）；返回实际释放的字节数。
/// 路径不存在按 0 计；不跟随符号链接（删除链接本身，目标不受影响）。
pub fn remove_tree_best_effort(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        let len = if meta.is_file() { meta.len() } else { 0 };
        // Windows 的目录符号链接须按目录删除（remove_file 报错）
        let removed = std::fs::remove_file(path).is_ok()
            || (meta.file_type().is_symlink() && std::fs::remove_dir(path).is_ok());
        return if removed { len } else { 0 };
    }
    let mut freed = 0u64;
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten() {
            freed += remove_tree_best_effort(&e.path());
        }
    }
    // 仍有删不掉的子项时目录非空，删除失败属预期
    let _ = std::fs::remove_dir(path);
    freed
}

/// 清理一个临时根目录下的 SFTP 分类子树（`<root>/sftp`），不碰根目录里的其他文件
/// （HTTP / NFS 打开文件等）；返回释放的字节数
pub fn cleanup_sftp_temp(root: &Path) -> u64 {
    remove_tree_best_effort(&root.join(SFTP_SUBDIR))
}

/// 本次会话用过的临时根目录（v0.44.0）：SFTP 打开下载 / 中转时登记，
/// 程序退出（Tauri `RunEvent::Exit` / rdir-web 停机）时逐个清理其 `sftp/` 子树。
/// 自定义临时目录只存在前端（每次调用随参传入），后端据此记住会话内实际用过的根目录，
/// 退出时无需前端参与（⌘Q 无窗口退出也能清理）。
#[derive(Default)]
pub struct TempRoots(Mutex<HashSet<PathBuf>>);

impl TempRoots {
    /// 登记根目录（重复登记无副作用）
    pub fn register(&self, root: &Path) {
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        g.insert(root.to_path_buf());
    }

    /// 退出清理：逐个根目录尽力删除 `sftp/` 子树，返回释放的字节总数。
    /// 已知限制：GUI 与 rdir-web 共用同一根目录时，一方退出会删掉另一方
    /// 进行中的中转暂存（该次中转失败，重传即可）。
    pub fn cleanup_all(&self) -> u64 {
        let roots: Vec<PathBuf> = {
            let g = self.0.lock().unwrap_or_else(|p| p.into_inner());
            g.iter().cloned().collect()
        };
        roots.iter().map(|r| cleanup_sftp_temp(r)).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未配置（None / 空串 / 纯空白）回退默认目录，配置了原样使用
    #[test]
    fn resolve_temp_dir_fallback_and_custom() {
        assert_eq!(resolve_temp_dir(None), open_temp_dir());
        assert_eq!(resolve_temp_dir(Some("")), open_temp_dir());
        assert_eq!(resolve_temp_dir(Some("   ")), open_temp_dir());
        let custom = std::env::temp_dir().join("rdir-test-custom-temp");
        assert_eq!(
            resolve_temp_dir(Some(custom.to_str().unwrap())),
            custom,
            "自定义目录原样使用（不自动补建）"
        );
    }

    /// 打开临时目录：占用统计与整体清理（目录不存在按空计，清理后自动消失）
    #[test]
    fn open_temp_dir_usage_and_clear() {
        let dir = std::env::temp_dir().join("rdir-test-open-temp");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(temp_usage(&dir), (0, 0), "目录不存在按空计");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.bin"), [0u8; 12]).unwrap();
        std::fs::write(dir.join("b.bin"), [0u8; 8]).unwrap();
        assert_eq!(temp_usage(&dir), (20, 2));
        assert_eq!(clear_temp(&dir).unwrap(), 20);
        assert!(!dir.exists(), "清理后目录整个移除（下次打开自动重建）");
        assert_eq!(clear_temp(&dir).unwrap(), 0, "重复清理安全无副作用");
    }

    /// 每个用例独立的临时根目录（并行测试互不干扰）
    fn fresh_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rdir-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// v0.44.0 主机名清洗：常规主机名原样，危险/非法字符换 _，杜绝目录穿越与保留名
    #[test]
    fn sanitize_host_cases() {
        assert_eq!(sanitize_host("example.com"), "example.com");
        assert_eq!(sanitize_host("192.168.1.10"), "192.168.1.10");
        assert_eq!(sanitize_host("my-host_01"), "my-host_01");
        assert_eq!(sanitize_host("服务器.内网"), "服务器.内网", "Unicode 字母数字保留");
        assert_eq!(sanitize_host("[::1]"), "___1_", "IPv6 方括号与冒号");
        assert_eq!(sanitize_host("fe80::1%eth0"), "fe80__1_eth0", "zone 的 %");
        assert_eq!(sanitize_host("host name"), "host_name");
        assert_eq!(sanitize_host("a/b\\c"), "a_b_c", "路径分隔符");
        assert_eq!(sanitize_host(".hidden."), "hidden", "首尾点去掉");
        for bad in ["", ".", "..", "..."] {
            assert_eq!(sanitize_host(bad), "_", "{bad:?} 归一为 _");
        }
        assert_eq!(sanitize_host("../etc"), "_etc", "穿越尝试变为普通单段");
        assert_eq!(sanitize_host("con"), "_con");
        assert_eq!(sanitize_host("COM1"), "_COM1");
        assert_eq!(sanitize_host("nul.local"), "_nul.local", "带扩展名的保留名");
        assert_eq!(sanitize_host("com10"), "com10", "COM10 不是保留名");
        assert_eq!(sanitize_host("console"), "console");
    }

    /// v0.44.0 中转暂存名：空格/括号/中文原样保留，只替换本地存不下的字符
    #[test]
    fn local_safe_name_preserves_common_names() {
        assert_eq!(local_safe_name("报告 (终).docx"), "报告 (终).docx");
        assert_eq!(local_safe_name("a b [1] #2 @x + y.txt"), "a b [1] #2 @x + y.txt");
        assert_eq!(local_safe_name("a/b"), "a_b");
        assert_eq!(local_safe_name("a\0b"), "a_b");
        for bad in ["", ".", ".."] {
            assert_eq!(local_safe_name(bad), "_", "{bad:?} 归一为 _");
        }
        if cfg!(windows) {
            assert_eq!(local_safe_name("a:b?.txt"), "a_b_.txt");
            assert_eq!(local_safe_name("trail. "), "trail");
            assert_eq!(local_safe_name("CON.txt"), "_CON.txt");
        } else {
            assert_eq!(local_safe_name("a:b?.txt"), "a:b?.txt", "Unix 上合法字符不改");
            assert_eq!(local_safe_name("trail. "), "trail. ");
            assert_eq!(local_safe_name("CON.txt"), "CON.txt");
        }
    }

    /// v0.44.0 分类目录与中转暂存目录的布局：<root>/sftp/<host>/relay-<pid>-<序号>
    #[test]
    fn sftp_dirs_layout() {
        let root = Path::new("/tmp/rdir-root");
        assert_eq!(
            sftp_host_dir(root, "a.example.com"),
            root.join("sftp").join("a.example.com")
        );
        assert_eq!(sftp_host_dir(root, ".."), root.join("sftp").join("_"));
        let s1 = relay_stage_dir(root, "h");
        let s2 = relay_stage_dir(root, "h");
        assert_ne!(s1, s2, "每次中转独立子目录");
        assert_eq!(s1.parent(), Some(sftp_host_dir(root, "h").as_path()));
        let name = s1.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            name.starts_with(&format!("relay-{}-", std::process::id())),
            "带 pid 前缀：{name}"
        );
    }

    /// v0.44.0 占用统计递归：sftp/<host>/ 下的文件也计入
    #[test]
    fn temp_usage_is_recursive() {
        let dir = fresh_dir("usage-rec");
        std::fs::write(dir.join("top.bin"), [0u8; 5]).unwrap();
        let host = dir.join("sftp").join("h");
        std::fs::create_dir_all(host.join("relay-1-1")).unwrap();
        std::fs::write(host.join("open.txt"), [0u8; 7]).unwrap();
        std::fs::write(host.join("relay-1-1").join("x.bin"), [0u8; 11]).unwrap();
        assert_eq!(temp_usage(&dir), (23, 3));
        assert_eq!(clear_temp(&dir).unwrap(), 23, "清空释放量含子目录");
        assert!(!dir.exists());
    }

    /// v0.44.0 退出清理只删 sftp/ 子树，根目录下的其他文件（HTTP/NFS 打开）不动
    #[test]
    fn cleanup_sftp_temp_keeps_other_files() {
        let dir = fresh_dir("cleanup-sftp");
        std::fs::write(dir.join("http-open.html"), [0u8; 4]).unwrap();
        let host = dir.join("sftp").join("h");
        std::fs::create_dir_all(host.join("relay-9-9").join("nested")).unwrap();
        std::fs::write(host.join("open.txt"), [0u8; 6]).unwrap();
        std::fs::write(host.join("relay-9-9").join("nested").join("y"), [0u8; 10]).unwrap();
        assert_eq!(cleanup_sftp_temp(&dir), 16);
        assert!(!dir.join("sftp").exists(), "sftp 子树整体移除");
        assert!(dir.join("http-open.html").exists(), "其他文件保留");
        assert_eq!(cleanup_sftp_temp(&dir), 0, "重复清理安全");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 尽力删除：不存在按 0；单文件；目录树整体
    #[test]
    fn remove_tree_best_effort_basics() {
        let dir = fresh_dir("best-effort");
        assert_eq!(remove_tree_best_effort(&dir.join("missing")), 0);
        let f = dir.join("single.bin");
        std::fs::write(&f, [0u8; 3]).unwrap();
        assert_eq!(remove_tree_best_effort(&f), 3);
        assert!(!f.exists());
        std::fs::create_dir_all(dir.join("t").join("u")).unwrap();
        std::fs::write(dir.join("t").join("a"), [0u8; 2]).unwrap();
        std::fs::write(dir.join("t").join("u").join("b"), [0u8; 5]).unwrap();
        assert_eq!(remove_tree_best_effort(&dir.join("t")), 7);
        assert!(!dir.join("t").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 尽力删除遇到删不掉的项（无写权限的目录）跳过继续：兄弟项照删，删不掉的保留
    #[cfg(unix)]
    #[test]
    fn remove_tree_best_effort_skips_failures() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh_dir("best-effort-fail");
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("stuck"), [0u8; 4]).unwrap();
        std::fs::write(dir.join("free"), [0u8; 9]).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        // root 无视权限位：此时无法构造失败场景，跳过断言
        let is_root = std::fs::write(locked.join("probe"), b"x").is_ok();
        let freed = remove_tree_best_effort(&dir);
        if !is_root {
            assert_eq!(freed, 9, "只释放删得掉的兄弟项");
            assert!(locked.join("stuck").exists(), "删不掉的项保留");
            assert!(!dir.join("free").exists());
        }
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 会话根目录登记：重复登记去重，退出时逐个清理 sftp/ 子树
    #[test]
    fn temp_roots_cleanup_all() {
        let a = fresh_dir("roots-a");
        let b = fresh_dir("roots-b");
        for (root, n) in [(&a, 3usize), (&b, 5usize)] {
            let host = sftp_host_dir(root, "h");
            std::fs::create_dir_all(&host).unwrap();
            std::fs::write(host.join("f"), vec![0u8; n]).unwrap();
        }
        std::fs::write(a.join("keep"), [0u8; 1]).unwrap();
        let roots = TempRoots::default();
        roots.register(&a);
        roots.register(&a);
        roots.register(&b);
        assert_eq!(roots.cleanup_all(), 8);
        assert!(!a.join("sftp").exists() && !b.join("sftp").exists());
        assert!(a.join("keep").exists(), "根目录其他文件不动");
        assert_eq!(roots.cleanup_all(), 0, "重复清理安全");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
