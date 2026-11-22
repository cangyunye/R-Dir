use serde::Serialize;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

#[derive(Serialize, Clone)]
pub struct VolumeInfo {
    pub name: String,
    pub path: String,
    /// 简化分类：root / fixed / removable / network / optical / unknown / volume
    /// （network = 映射网络驱动器；索引默认只收 fixed，见 indexer::default_roots）
    pub kind: String,
    /// 已用 / 总容量（字节）。侧边栏用量条数据源；网络卷（GetDiskFreeSpaceExW
    /// 对断连映射盘会阻塞数秒，正是卷枚举改用 GetDriveTypeW 规避的场景）或
    /// 查询失败时为 None，前端不画条。注意 volumes_signature 刻意不含这两个
    /// 字段——用量随写入时刻变化，纳入签名会让 2s 轮询 watcher 不停推事件。
    pub used_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct QuickAccessItem {
    /// 语义键：home / desktop / documents / downloads / pictures / music / movies
    pub key: String,
    pub path: String,
}

/// 枚举磁盘/卷：macOS 读 /Volumes + 根卷；Windows 探测 A: - Z:。
pub fn list_volumes() -> Vec<VolumeInfo> {
    #[cfg(target_os = "macos")]
    {
        let mut vols = Vec::new();
        let root_usage = query_usage("/");
        vols.push(VolumeInfo {
            name: volume_display_name("/").unwrap_or_else(|| "Macintosh HD".into()),
            path: "/".into(),
            kind: "root".into(),
            used_bytes: root_usage.map(|u| u.0),
            total_bytes: root_usage.map(|u| u.1),
        });
        if let Ok(rd) = std::fs::read_dir("/Volumes") {
            for e in rd.flatten() {
                let p = e.path();
                // 跳过指向根卷的条目（macOS 的 /Volumes/Macintosh HD 是指向 "/" 的符号链接）
                if let Ok(canon) = std::fs::canonicalize(&p) {
                    if canon == std::path::Path::new("/") {
                        continue;
                    }
                }
                let usage = query_usage(&p.to_string_lossy());
                vols.push(VolumeInfo {
                    name: e.file_name().to_string_lossy().to_string(),
                    path: p.to_string_lossy().to_string(),
                    kind: "volume".into(),
                    used_bytes: usage.map(|u| u.0),
                    total_bytes: usage.map(|u| u.1),
                });
            }
        }
        vols
    }
    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDriveTypeW;
        // DRIVE_* 类型常量归 System::WindowsProgramming（windows 0.62 划分）
        use windows::Win32::System::WindowsProgramming::{
            DRIVE_CDROM, DRIVE_FIXED, DRIVE_NO_ROOT_DIR, DRIVE_RAMDISK, DRIVE_REMOTE,
            DRIVE_REMOVABLE,
        };

        let mut vols = Vec::new();
        for c in b'A'..=b'Z' {
            let drive = format!("{}:\\", c as char);
            let mut wide: Vec<u16> = drive.encode_utf16().collect();
            wide.push(0);
            // GetDriveTypeW 只读驱动器映射表、不探测文件系统：已断连的映射网络盘
            // 也立即返回（此前 metadata() 会阻塞数秒至数十秒，且 2s 轮询的
            // spawn_watcher 每轮都要挨一次）。
            let dt = unsafe { GetDriveTypeW(PCWSTR::from_raw(wide.as_ptr())) };
            if dt == DRIVE_NO_ROOT_DIR {
                continue; // 盘符不存在
            }
            let kind = drive_kind(dt);
            // 存在性门控只对本地盘保留（metadata 快速且防幽灵盘符：A: 无软盘 /
            // 读卡器无卡时 metadata 失败，与旧行为一致不显示）；映射网络盘改为
            // 只看 GetDriveTypeW——断连的 Z: 会显示在侧边栏（点击报错，属可
            // 接受的显式状态），换取不再阻塞。
            let exists = kind == "network" || std::fs::metadata(&drive).is_ok();
            if exists {
                // 用量只对本地卷查询（fixed/removable/optical/unknown）；network 卷
                // 连元数据都刻意跳过（断连映射盘阻塞问题），此处同样跳过。
                let usage = if kind == "network" {
                    None
                } else {
                    query_usage(&drive)
                };
                vols.push(VolumeInfo {
                    name: format!("{} ({})", c as char, drive),
                    path: drive,
                    kind: kind.into(),
                    used_bytes: usage.map(|u| u.0),
                    total_bytes: usage.map(|u| u.1),
                });
            }
        }
        vols
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

/// 卷用量查询 → (已用, 总容量)。调用方已按卷类别过滤，本函数只管系统调用。
/// 失败（无介质的光驱 / BitLocker 未解锁 / 权限等）返回 None，前端不画条。
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn query_usage(path: &str) -> Option<(u64, u64)> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut total = 0u64;
        let mut free = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR::from_raw(wide.as_ptr()),
                None,
                Some(std::ptr::addr_of_mut!(total)),
                Some(std::ptr::addr_of_mut!(free)),
            )
        };
        ok.ok()?;
        // free > total 理论上不该发生，clamp 防止减法下溢
        Some((total.saturating_sub(free.min(total)), total))
    }
    #[cfg(target_os = "macos")]
    {
        let c = std::ffi::CString::new(path).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
        if rc != 0 {
            return None;
        }
        let frsize = st.f_frsize.max(1) as u64;
        let total = st.f_blocks as u64 * frsize;
        // 用 f_bfree（真实空闲，含 root 保留）而非 f_bavail（普通用户可用），
        // 使 used + free == total，与资源管理器/Finder 的已用口径一致
        let free = st.f_bfree as u64 * frsize;
        Some((total.saturating_sub(free.min(total)), total))
    }
}

/// Win32 驱动器类型 → 卷分类。字母序启发（C 以下=removable 其余=fixed）会
/// 把 D: 上的 USB/光盘、Z: 等映射网络驱动器全归为 fixed——被 indexer 默认
/// 全盘索引（SMB 目录 mtime 不可靠，剪枝失效），故必须走真实类型查询。
#[cfg(target_os = "windows")]
fn drive_kind(dt: u32) -> &'static str {
    use windows::Win32::System::WindowsProgramming::{
        DRIVE_CDROM, DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE,
    };
    match dt {
        DRIVE_FIXED | DRIVE_RAMDISK => "fixed", // RAM 盘 = 本地固定卷，可索引
        DRIVE_REMOVABLE => "removable",
        DRIVE_REMOTE => "network",
        DRIVE_CDROM => "optical",
        _ => "unknown",
    }
}

/// 卷集合签名：把名称/路径/类别按固定分隔符拼接，用于判断集合是否变化。
/// 分隔符选用控制字符，避免与文件名/路径中可能出现的可见字符冲突。
/// 刻意不含用量字段——用量随写入时刻变化，纳入会让 2s 轮询不停推事件
/// （用量保鲜由前端定期拉 get_volumes 承担，见 App.tsx）。
fn volumes_signature(vols: &[VolumeInfo]) -> String {
    let mut s = String::new();
    for v in vols {
        s.push_str(&v.name);
        s.push('\u{1}');
        s.push_str(&v.path);
        s.push('\u{1}');
        s.push_str(&v.kind);
        s.push('\u{2}');
    }
    s
}

/// 后台监视磁盘/卷变化（挂载、卸载、推出、热插拔）：每 2 秒轮询一次列表，
/// 仅在集合真正变化时经 `volumes://changed` 事件推送最新列表，前端据此即时刷新
/// 侧边栏（无需重启）。`read_dir` 开销极小，跨平台且不引入新依赖。
/// 线程随进程退出而结束（detach 型，无 join）。事件经 EventSink 发射
/// （桌面 tauri emit / web 广播），模块不再依赖 AppHandle。
pub fn spawn_watcher(sink: crate::events::EventSink) {
    thread::spawn(move || {
        let mut last = volumes_signature(&list_volumes());
        loop {
            thread::sleep(Duration::from_secs(2));
            let vols = list_volumes();
            let sig = volumes_signature(&vols);
            if sig != last {
                last = sig;
                sink.emit("volumes://changed", &vols);
            }
        }
    });
}

/// macOS 根卷显示名（MVP 固定返回，后续可读卷标）。
#[cfg(target_os = "macos")]
fn volume_display_name(_path: &str) -> Option<String> {
    Some("Macintosh HD".into())
}

/// 快速访问目录（跨平台，缺失的目录跳过）。
pub fn quick_access() -> Vec<QuickAccessItem> {
    let mut items = Vec::new();
    let candidates: [(&str, fn() -> Option<PathBuf>); 7] = [
        ("home", dirs::home_dir),
        ("desktop", dirs::desktop_dir),
        ("documents", dirs::document_dir),
        ("downloads", dirs::download_dir),
        ("pictures", dirs::picture_dir),
        ("music", dirs::audio_dir),
        ("movies", dirs::video_dir),
    ];
    for (key, f) in candidates {
        if let Some(p) = f() {
            // 仅收录实际可访问的目录：dirs 在 Windows 用 KF_FLAG_DONT_VERIFY 返回已知文件夹
            // 默认路径（不验证存在），OneDrive 重定向 / 已删除的库目录（如 My Music）可能
            // 存在但无权限。read_dir 可枚举才算可用，避免侧边栏出现点击后"没有权限访问"的项。
            if p.is_dir() && p.read_dir().is_ok() {
                items.push(QuickAccessItem {
                    key: key.to_string(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vol(name: &str, path: &str, kind: &str) -> VolumeInfo {
        VolumeInfo {
            name: name.into(),
            path: path.into(),
            kind: kind.into(),
            used_bytes: None,
            total_bytes: None,
        }
    }

    #[test]
    fn signature_is_stable_for_same_set_and_changes_on_add_remove() {
        let a = vec![vol("Macintosh HD", "/", "root"), vol("U盘", "/Volumes/U盘", "volume")];
        assert_eq!(volumes_signature(&a), volumes_signature(&a.clone()));

        // 新增卷 → 签名变化（触发刷新）
        let mut b = a.clone();
        b.push(vol("dmg.x", "/Volumes/dmg.x", "volume"));
        assert_ne!(volumes_signature(&a), volumes_signature(&b));

        // 移除卷（推出）→ 签名变化
        let c = vec![vol("Macintosh HD", "/", "root")];
        assert_ne!(volumes_signature(&a), volumes_signature(&c));
    }

    #[test]
    fn signature_distinguishes_name_from_path_fields() {
        // 防止字段间无分隔导致的歧义拼接（"a"+"b" 与 "ab"+"" 不应相等）
        let x = vec![vol("a", "b", "volume")];
        let y = vec![vol("ab", "", "volume")];
        assert_ne!(volumes_signature(&x), volumes_signature(&y));
    }

    /// 用量字段绝不能参与签名：写入文件 → 用量变化是常态，纳入签名会让
    /// spawn_watcher 的 2s 轮询经 volumes://changed 不停推全量列表。
    #[test]
    fn signature_ignores_usage_fields() {
        let mut a = vec![vol("C (C:\\)", "C:\\", "fixed")];
        let mut b = a.clone();
        a[0].used_bytes = Some(100);
        a[0].total_bytes = Some(1000);
        b[0].used_bytes = Some(900);
        b[0].total_bytes = Some(1000);
        assert_eq!(volumes_signature(&a), volumes_signature(&b));
    }

    /// 系统盘用量查询冒烟：总量 > 0 且已用 ≤ 总量（与 system_drive_classified_fixed
    /// 同款前置：无系统盘时跳过，避免依赖具体机器）。
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn query_usage_reports_system_drive() {
        let path = if cfg!(target_os = "windows") {
            let tmp = std::env::temp_dir();
            let prefix = tmp.to_string_lossy().chars().next().unwrap().to_string();
            format!("{prefix}:\\")
        } else {
            "/".to_string()
        };
        let Some((used, total)) = query_usage(&path) else {
            panic!("系统盘 {path} 的用量查询不应失败");
        };
        assert!(total > 0, "总容量必须 > 0，实际 {total}");
        assert!(used <= total, "已用 {used} 不得超过总量 {total}");
    }

    /// Win32 驱动器类型常量 → 分类的映射（纯函数，无需真实硬件）
    #[cfg(target_os = "windows")]
    #[test]
    fn drive_kind_maps_win32_constants() {
        use windows::Win32::System::WindowsProgramming::{
            DRIVE_CDROM, DRIVE_FIXED, DRIVE_NO_ROOT_DIR, DRIVE_RAMDISK, DRIVE_REMOTE,
            DRIVE_REMOVABLE,
        };
        assert_eq!(drive_kind(DRIVE_FIXED), "fixed");
        assert_eq!(drive_kind(DRIVE_RAMDISK), "fixed");
        assert_eq!(drive_kind(DRIVE_REMOVABLE), "removable");
        assert_eq!(drive_kind(DRIVE_REMOTE), "network");
        assert_eq!(drive_kind(DRIVE_CDROM), "optical");
        assert_eq!(drive_kind(DRIVE_NO_ROOT_DIR), "unknown");
    }

    /// 系统盘必须分类为 fixed（GetDriveTypeW 真实调用冒烟）
    #[cfg(target_os = "windows")]
    #[test]
    fn system_drive_classified_fixed() {
        let tmp = std::env::temp_dir();
        let prefix = tmp.to_string_lossy().chars().next().unwrap().to_string();
        let vols = list_volumes();
        let v = vols
            .iter()
            .find(|v| v.path.starts_with(&prefix))
            .unwrap_or_else(|| panic!("系统盘 {prefix}: 应在卷列表内"));
        assert_eq!(v.kind, "fixed", "系统盘 {prefix}: 必须分类为 fixed");
        // 映射网络驱动器（若本机有）绝不能被分类成 fixed——否则会被默认索引
        assert!(
            vols.iter().all(|v| v.kind != "fixed" || !v.path.to_uppercase().starts_with("Z")),
            "Z: 网络盘不得分类为 fixed（如本机确有 fixed 类 Z: 可放宽此断言）"
        );
    }
}
