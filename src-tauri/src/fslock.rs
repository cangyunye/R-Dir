//! 文件占用探测（feat/file-lock）：判定目标是否被其他进程占用，并列出占用者。
//!
//! 三平台机制差异：
//! - Windows：强制锁模型。独占试探（read + share_mode(0)）命中 ERROR_SHARING_VIOLATION(32)
//!   /ERROR_LOCK_VIOLATION(33) 即占用；占用者清单走 Restart Manager（资源管理器
//!   「文件正在使用」对话框同源）。目录仅探测——RM 不收目录路径，占用的进程列不出。
//! - macOS：无强制锁（打开句柄不阻断 unlink/rename），占用是信息性提示。libproc 枚举
//!   全部进程的 fd（proc_pidinfo PROC_PIDLISTFDS），逐 fd 经 proc_pidfdinfo
//!   PROC_PIDFDVNODEPATHINFO 取 vnode 真实路径对比目标（符号链接已解析，与
//!   canonicalize 语义一致）。
//! - Linux：同 macOS（咨询锁，强制锁自内核 5.15 移除）。扫 /proc/[pid]/fd/*，stat 链接
//!   目标对比 (st_dev, st_ino)（bind mount / 别名路径也命中）；其他用户的进程无权限
//!   读取 fd，静默跳过。
//!
//! 自身 PID 一律过滤：R-Dir 自己的缩略图/预览句柄不算「被占用」。
//! Win32 API 用裸 extern 声明（同 ops.rs CopyFileExW 的既有做法）：类型化 windows
//! crate 的签名跨版本漂移，裸声明零依赖、不随版本变化，Cargo.toml 无需加 feature。

use serde::Serialize;
use std::fs;
use std::path::Path;

/// 单个占用进程。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockHolder {
    pub pid: u32,
    /// 进程/应用名（Windows=RM strAppName，mac=kinfo_proc p_comm，Linux=comm）
    pub name: String,
    /// 完整命令行（仅 Linux /proc 提供；其余平台 None）
    pub command: Option<String>,
}

/// 单个路径的占用探测结果。探测返回数据而非错误——占用是查询结果，不是故障。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLockStatus {
    pub path: String,
    /// Windows=探测到共享冲突；mac/Linux=有其他进程持有打开句柄（不阻断操作，仅提示）
    pub locked: bool,
    pub is_dir: bool,
    /// 占用进程清单（已过滤自身；Windows 目录占用 / RM 查不到清单时为空）
    pub holders: Vec<LockHolder>,
}

/// 探测一组本地路径的占用状态。阻塞 syscall，进 spawn_blocking。
#[tauri::command]
pub async fn probe_file_lock(paths: Vec<String>) -> Result<Vec<FileLockStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths.iter().map(|p| probe_one(p)).collect::<Vec<FileLockStatus>>()
    })
    .await
    .map_err(|e| e.to_string())
}

/// 结束占用进程（Unix=SIGTERM，Windows=TerminateProcess）。危险操作，前端需二次确认。
#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || kill_pid(pid))
        .await
        .map_err(|e| e.to_string())?
}

/// 单路径探测入口：远程/虚拟路径与不存在的路径直接返回未占用（前端也会挡住入口）。
fn probe_one(path: &str) -> FileLockStatus {
    let p = Path::new(path);
    let (is_dir, exists) = match fs::metadata(p) {
        Ok(md) => (md.is_dir(), true),
        Err(_) => (false, false),
    };
    if !p.is_absolute() || !exists {
        return FileLockStatus {
            path: path.to_owned(),
            locked: false,
            is_dir,
            holders: Vec::new(),
        };
    }
    let self_pid = std::process::id();
    let mut status = probe_os(p, is_dir, self_pid);
    status.path = path.to_owned();
    status
}

// ───────────────────────────── Windows ─────────────────────────────

#[cfg(windows)]
mod winapi {
    // rstrtmgr = Restart Manager；kernel32 随 MSVC 工具链的 Windows SDK 自动可链
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const core::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: *const core::ffi::c_void,
        ) -> *mut core::ffi::c_void;
        pub fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
        pub fn GetLastError() -> u32;
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        pub fn TerminateProcess(h: *mut core::ffi::c_void, code: u32) -> i32;
    }
    #[link(name = "rstrtmgr")]
    extern "system" {
        pub fn RmStartSession(session: *mut u32, flags: u32, key: *const u16) -> u32;
        pub fn RmRegisterResources(
            session: u32,
            nfiles: u32,
            files: *const *const u16,
            napps: u32,
            apps: *const RmUniqueProcess,
            nsvc: u32,
            svc: *const *const u16,
        ) -> u32;
        pub fn RmGetList(
            session: u32,
            needed: *mut u32,
            count: *mut u32,
            infos: *mut RmProcessInfo,
            reasons: *mut u32,
        ) -> u32;
        pub fn RmEndSession(session: u32) -> u32;
    }
    /// RM_UNIQUE_PROCESS：DWORD pid + FILETIME（低/高 32 位，按 [u32;2] 保 4 字节对齐）
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct RmUniqueProcess {
        pub pid: u32,
        pub start_time: [u32; 2],
    }
    /// RM_PROCESS_INFO（repr(C) 与 SDK 定义逐字段对齐：12B + 512B + 126B + 4×DWORD）
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct RmProcessInfo {
        pub process: RmUniqueProcess,
        pub app_name: [u16; 256],
        pub svc_name: [u16; 63],
        pub app_type: u32,
        pub app_status: u32,
        pub ts_session_id: u32,
        pub restartable: i32,
    }
}

#[cfg(windows)]
const GENERIC_READ: u32 = 0x8000_0000;
#[cfg(windows)]
const OPEN_EXISTING: u32 = 3;
/// 打开目录必需（目录不能用 std::fs 打开）
#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
#[cfg(windows)]
const ERROR_SHARING_VIOLATION: u32 = 32;
#[cfg(windows)]
const ERROR_LOCK_VIOLATION: u32 = 33;
#[cfg(windows)]
const ERROR_MORE_DATA: u32 = 234;
#[cfg(windows)]
const PROCESS_TERMINATE: u32 = 0x0001;

#[cfg(windows)]
fn probe_os(p: &Path, is_dir: bool, self_pid: u32) -> FileLockStatus {
    let locked = if is_dir {
        win_probe_exclusive_dir(p)
    } else {
        win_probe_exclusive_file(p)
    };
    // RM 只收文件路径：目录占用（多半是某进程的 CWD）列不出进程
    let holders = if locked && !is_dir {
        win_rm_lockers(p, self_pid)
    } else {
        Vec::new()
    };
    FileLockStatus {
        path: p.to_string_lossy().into_owned(),
        locked,
        is_dir,
        holders,
    }
}

/// 文件独占试探：read + share_mode(0)。任何持真实读写句柄的进程都会挡住本次打开
/// （返回共享冲突）；而纯元数据句柄（AV 扫描、属性查询，desiredAccess=0）不误报。
#[cfg(windows)]
fn win_probe_exclusive_file(p: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    match fs::OpenOptions::new().read(true).share_mode(0).open(p) {
        Ok(_) => false,
        // 32=ERROR_SHARING_VIOLATION 33=ERROR_LOCK_VIOLATION；其余（如拒绝访问）是权限问题而非占用
        Err(e) => matches!(e.raw_os_error(), Some(32) | Some(33)),
    }
}

#[cfg(windows)]
fn win_probe_exclusive_dir(p: &Path) -> bool {
    let wide = to_wide(&p.to_string_lossy());
    let h = unsafe {
        winapi::CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            0, // share=0：独占试探
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null(),
        )
    };
    if (h as isize) == -1 {
        let err = unsafe { winapi::GetLastError() };
        return err == ERROR_SHARING_VIOLATION || err == ERROR_LOCK_VIOLATION;
    }
    unsafe { winapi::CloseHandle(h) };
    false
}

/// Restart Manager 查占用者清单（会话即开即用，资源管理器「文件正在使用」同源）。
/// 查不到（RM 异常/仅系统句柄）返回空清单，UI 回退「无法确定进程」文案。
#[cfg(windows)]
fn win_rm_lockers(p: &Path, self_pid: u32) -> Vec<LockHolder> {
    use std::sync::atomic::{AtomicU32, Ordering};
    use winapi::*;
    static SEQ: AtomicU32 = AtomicU32::new(0);
    // 会话 key 要求每次唯一，pid + 序号足够
    let key = to_wide(&format!(
        "RDIR-FSLOCK-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut session = 0u32;
    if unsafe { RmStartSession(&mut session, 0, key.as_ptr()) } != 0 {
        return Vec::new();
    }
    let holders = (|| {
        let wide = to_wide(&p.to_string_lossy());
        let files = [wide.as_ptr()];
        if unsafe { RmRegisterResources(session, 1, files.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null()) } != 0 {
            return Vec::new();
        }
        let mut needed = 0u32;
        let mut count = 0u32;
        let mut reasons = 0u32;
        // 首调用以空缓冲探得需要的条数（预期 ERROR_MORE_DATA=234）
        let rc = unsafe { RmGetList(session, &mut needed, &mut count, std::ptr::null_mut(), &mut reasons) };
        if rc != ERROR_MORE_DATA || needed == 0 || needed > 8192 {
            return Vec::new();
        }
        let mut infos: Vec<RmProcessInfo> = vec![unsafe { std::mem::zeroed() }; needed as usize];
        count = needed;
        if unsafe { RmGetList(session, &mut needed, &mut count, infos.as_mut_ptr(), &mut reasons) } != 0 {
            return Vec::new();
        }
        infos.truncate(count as usize);
        infos
            .into_iter()
            .filter(|i| i.process.pid != self_pid && i.process.pid != 0)
            .map(|i| LockHolder {
                pid: i.process.pid,
                name: utf16_until_nul(&i.app_name),
                command: None,
            })
            .collect()
    })();
    unsafe { RmEndSession(session) };
    holders
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> Result<(), String> {
    if pid == std::process::id() {
        return Err("不能结束 R-Dir 自身进程".into());
    }
    let h = unsafe { winapi::OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if (h as isize) == -1 || h.is_null() {
        return Err(format!("无法结束进程 {pid}：可能权限不足，或进程已退出"));
    }
    let ok = unsafe { winapi::TerminateProcess(h, 1) };
    unsafe { winapi::CloseHandle(h) };
    if ok == 0 {
        Err(format!("无法结束进程 {pid}（可能权限不足）"))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn utf16_until_nul(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

// ───────────────────────────── macOS ─────────────────────────────

#[cfg(target_os = "macos")]
mod mac {
    // libproc 不在 libc crate 里，由 libSystem 直接导出，裸 extern 声明零依赖
    extern "C" {
        /// 全部 PID 数量；pids 为 null 时返回当前进程总数
        pub fn proc_listallpids(pids: *mut i32, count: i32) -> i32;
        pub fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut core::ffi::c_void,
            size: i32,
        ) -> i32;
        /// 每 fd 查询走 proc_pidfdinfo
        pub fn proc_pidfdinfo(
            pid: i32,
            fd: i32,
            flavor: i32,
            buffer: *mut core::ffi::c_void,
            size: i32,
        ) -> i32;
    }
    pub const PROC_PIDLISTFDS: i32 = 1;
    /// PROX_FDTYPE_VNODE：普通文件/目录（socket/pipe/kqueue 等跳过）
    pub const PROX_FDTYPE_VNODE: u32 = 1;
    /// proc_pidfdinfo 的 flavor（注意：与 proc_pidinfo 的编号是两套体系，勿混用）
    pub const PROC_PIDFDVNODEPATHINFO: i32 = 2;

    /// struct proc_fdinfo { proc_fd: i32, proc_fdtype: u32 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct ProcFdInfo {
        pub fd: i32,
        pub fdtype: u32,
    }

    /// struct vnode_fdinfowithpath 缓冲布局（xnu UAPI 结构，跨版本 ABI 稳定）：
    /// pfi(proc_fileinfo) + vnode_info(vinfo_stat + fsid) + vip_path[MAXPATHLEN=1024]。
    /// 尺寸/偏移用 SDK 头 cc offsetof 实测锁定（勿按字段手算——vinfo_stat 里
    /// atime/mtime/ctime/birthtime 各带一个 nsec 字段，手算极易错位）。
    pub const PATH_OFFSET: usize = 176;
    pub const BUF_SIZE: usize = PATH_OFFSET + 1024; // = 1200 = sizeof(vnode_fdinfowithpath)
}

#[cfg(target_os = "macos")]
fn probe_os(p: &Path, is_dir: bool, self_pid: u32) -> FileLockStatus {
    let holders = mac_scan_lockers(p, self_pid);
    FileLockStatus {
        path: p.to_string_lossy().into_owned(),
        locked: !holders.is_empty(),
        is_dir,
        holders,
    }
}

/// libproc fd 扫描：全进程枚举 → vnode 真实路径对比目标。诊断用路径字符串比对，
/// 硬链接别名可能漏报（可接受；mac 上占用本就不阻断操作）。
#[cfg(target_os = "macos")]
fn mac_scan_lockers(p: &Path, self_pid: u32) -> Vec<LockHolder> {
    use mac::*;
    let Ok(target) = fs::canonicalize(p) else {
        return Vec::new();
    };
    let target = target.to_string_lossy().into_owned();
    let n = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 {
        return Vec::new();
    }
    // 枚举期间新进程的余量
    let mut pids: Vec<i32> = vec![0; n as usize + 32];
    let cnt = unsafe { proc_listallpids(pids.as_mut_ptr(), pids.len() as i32) };
    if cnt <= 0 {
        return Vec::new();
    }
    let mut holders = Vec::new();
    for &pid in &pids[..cnt as usize] {
        if pid <= 0 || pid as u32 == self_pid {
            continue; // 自身过滤：测试传 u32::MAX 哨兵值时可观察本进程
        }
        let mut fds: Vec<ProcFdInfo> = vec![ProcFdInfo { fd: 0, fdtype: 0 }; 4096];
        let sz = unsafe {
            proc_pidinfo(
                pid,
                PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                (std::mem::size_of::<ProcFdInfo>() * fds.len()) as i32,
            )
        };
        if sz <= 0 {
            continue; // 其他用户进程 EPERM → 静默跳过
        }
        let n_fds = sz as usize / std::mem::size_of::<ProcFdInfo>();
        for fi in &fds[..n_fds] {
            if fi.fdtype != PROX_FDTYPE_VNODE {
                continue;
            }
            let mut buf = [0u8; BUF_SIZE];
            let r = unsafe {
                proc_pidfdinfo(pid, fi.fd, PROC_PIDFDVNODEPATHINFO, buf.as_mut_ptr().cast(), BUF_SIZE as i32)
            };
            if r <= PATH_OFFSET as i32 {
                continue;
            }
            let Ok(cpath) = std::ffi::CStr::from_bytes_until_nul(&buf[PATH_OFFSET..]) else {
                continue;
            };
            if cpath.to_bytes() != target.as_bytes() {
                continue;
            }
            holders.push(LockHolder {
                pid: pid as u32,
                name: mac_pid_name(pid).unwrap_or_else(|| format!("pid {pid}")),
                command: None,
            });
            break; // 一个进程命中一次即可
        }
    }
    holders
}

/// 进程名走 libproc proc_name（libc crate apple 模块已声明；comm 截断 16 字节）。
#[cfg(target_os = "macos")]
fn mac_pid_name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 17];
    let r = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if r <= 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_owned();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

// ───────────────────────────── Linux ─────────────────────────────

#[cfg(target_os = "linux")]
fn probe_os(p: &Path, is_dir: bool, self_pid: u32) -> FileLockStatus {
    let holders = linux_scan_lockers(p, self_pid);
    FileLockStatus {
        path: p.to_string_lossy().into_owned(),
        locked: !holders.is_empty(),
        is_dir,
        holders,
    }
}

/// /proc fd 扫描：stat /proc/[pid]/fd/[n] 跟随链接直达目标 inode，对比 (dev, ino)。
#[cfg(target_os = "linux")]
fn linux_scan_lockers(p: &Path, self_pid: u32) -> Vec<LockHolder> {
    use std::os::unix::fs::MetadataExt;
    let Ok(md) = fs::metadata(p) else {
        return Vec::new();
    };
    let (dev, ino) = (md.dev(), md.ino());
    let mut holders = Vec::new();
    let Ok(pids) = fs::read_dir("/proc") else {
        return holders;
    };
    for entry in pids.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        // 无权限读他人 fd 目录（EPERM）→ 静默跳过
        let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(fmd) = fs::metadata(fd.path()) else {
                continue; // 已删除/socket 等 stat 不出 → 跳过
            };
            if fmd.dev() == dev && fmd.ino() == ino {
                holders.push(LockHolder {
                    pid,
                    name: linux_comm(pid),
                    command: linux_cmdline(pid),
                });
                break; // 一个进程命中一次即可
            }
        }
    }
    holders
}

#[cfg(target_os = "linux")]
fn linux_comm(pid: u32) -> String {
    fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("pid {pid}"))
}

/// 命令行 NUL 分隔转空格拼接（隐藏参数的场景不可靠，仅诊断展示用）。
#[cfg(target_os = "linux")]
fn linux_cmdline(pid: u32) -> Option<String> {
    let raw = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let parts: Vec<&[u8]> = raw.split(|&b| b == 0).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    Some(
        parts
            .iter()
            .map(|s| String::from_utf8_lossy(s))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

// ───────────────────────────── 结束进程 ─────────────────────────────

#[cfg(unix)]
fn kill_pid(pid: u32) -> Result<(), String> {
    if pid == std::process::id() {
        return Err("不能结束 R-Dir 自身进程".into());
    }
    if pid <= 1 {
        return Err("拒绝结束系统关键进程".into());
    }
    let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if rc != 0 {
        return Err(match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => format!("进程 {pid} 不存在（可能已退出）"),
            Some(libc::EPERM) => format!("无权限结束进程 {pid}（属主为其他用户）"),
            _ => format!("无法结束进程 {pid}"),
        });
    }
    Ok(())
}

#[cfg(not(any(windows, unix)))]
fn kill_pid(_pid: u32) -> Result<(), String> {
    Err("当前平台不支持结束进程".into())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn probe_os(p: &Path, is_dir: bool, _self_pid: u32) -> FileLockStatus {
    FileLockStatus {
        path: p.to_string_lossy().into_owned(),
        locked: false,
        is_dir,
        holders: Vec::new(),
    }
}

// ───────────────────────────── 测试 ─────────────────────────────

#[cfg(all(test, target_os = "macos"))]
mod mac_tests {
    use super::*;

    /// 缓冲布局自校验：打开已知文件后 fd 扫描应命中本进程且路径逐字节一致；
    /// PATH_OFFSET / BUF_SIZE 常量若有错，内核返回字节数不足或路径错位，本用例必炸。
    #[test]
    fn fd_scan_finds_open_file_and_path_offset_is_correct() {
        let dir = std::env::temp_dir().join(format!("rdir-fslock-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("held.txt");
        fs::write(&f, b"x").unwrap();
        let held = fs::File::open(&f).unwrap();

        // 打开中：scan 不过滤自身，本进程应命中
        let holders = mac_scan_lockers(&f, u32::MAX);
        assert!(
            holders.iter().any(|h| h.pid == std::process::id()),
            "应发现本进程持有的句柄: {:?}",
            holders
        );

        // 关闭后不再命中（只断言自身，其他进程偶发持有不构成失败）
        drop(held);
        std::thread::sleep(std::time::Duration::from_millis(50));
        let holders = mac_scan_lockers(&f, u32::MAX);
        assert!(
            !holders.iter().any(|h| h.pid == std::process::id()),
            "关闭后不应命中: {:?}",
            holders
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// probe_one 过滤自身：本进程打开的文件对外呈现「未被占用」
    /// （R-Dir 自己的预览/缩略图句柄不算占用）。
    #[test]
    fn probe_one_filters_self_pid() {
        let dir = std::env::temp_dir().join(format!("rdir-fslock-self-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("self-held.txt");
        fs::write(&f, b"x").unwrap();
        let held = fs::File::open(&f).unwrap();
        let st = probe_one(f.to_string_lossy().as_ref());
        assert!(
            !st.locked,
            "自身句柄应被过滤: {:?}",
            st.holders
        );
        drop(held);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn cmdline_nul_split_joins_with_space() {
        let dir = std::env::temp_dir().join(format!("rdir-fslock-cmd-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // 不落盘真实 /proc，直接测解析路径：借本进程 cmdline 的已知格式
        let mine = linux_cmdline(std::process::id());
        assert!(mine.is_some(), "本进程 cmdline 应可读");
        assert!(!mine.unwrap().contains('\0'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fd_scan_finds_open_file() {
        let dir = std::env::temp_dir().join(format!("rdir-fslock-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("held.txt");
        fs::write(&f, b"x").unwrap();
        let held = fs::File::open(&f).unwrap();
        let holders = linux_scan_lockers(&f, u32::MAX);
        assert!(
            holders.iter().any(|h| h.pid == std::process::id()),
            "应发现本进程持有的句柄: {:?}",
            holders
        );
        drop(held);
        let _ = fs::remove_dir_all(&dir);
    }
}
