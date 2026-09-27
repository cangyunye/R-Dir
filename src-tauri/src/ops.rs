use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// 传输进度回调事件（本地复制/移动）。
pub enum CbEvent<'a> {
    /// 开始复制一个文件（携带源文件名，展示用）
    Start(&'a str),
    /// 当前文件字节进度：(已复制字节, 总字节)
    Bytes(u64, u64),
    /// 一个顶层条目完成（含被跳过的），用于递增 done_files
    EntryDone,
}

/// 进度回调。返回 false 表示用户取消，引擎应尽快中止（就地清理半成品）。
pub type ProgressCb<'a> = &'a mut dyn FnMut(CbEvent) -> bool;

/// 回调报取消时统一走这个错误，命令层据此把提示收敛为「已取消」。
fn cancelled() -> std::io::Error {
    std::io::Error::other("传输已取消")
}

/// 一条待用户裁决的同名冲突。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub src: String,
    pub dest: String,
    /// 源类型："file" | "dir"
    pub src_kind: String,
    /// 目标已存在类型："file" | "dir"
    pub dest_kind: String,
    /// 默认改名（`name_1.ext`），保证当前不冲突
    pub suggest: String,
}

/// 用户对某条冲突的裁决。序列化为 `{ "action": "overwrite" | "skip" | "rename", "name": "..." }`
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum Resolution {
    Overwrite,
    Rename { name: String },
    Skip,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Copy,
    Move,
}

fn kind(is_dir: bool) -> &'static str {
    if is_dir {
        "dir"
    } else {
        "file"
    }
}

/// 扫描复制/移动前需要用户裁决的同名冲突。
///
/// 规则：目录 vs 目录视为可合并，不产生冲突（递归下钻）；其余（文件 vs 文件、
/// 文件 vs 目录、目录 vs 文件）均为冲突，逐条返回。
pub fn scan_conflicts(paths: &[String], dest: &str) -> Result<Vec<Conflict>, String> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("目标不是目录：{}", dest.display()));
    }
    let mut out = Vec::new();
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| format!("非法路径：{}", p))?;
        scan_into(src, &dest.join(name), &mut out);
    }
    Ok(out)
}

fn scan_into(src: &Path, dst: &Path, out: &mut Vec<Conflict>) {
    if !dst.exists() {
        return;
    }
    let src_is_dir = src.is_dir();
    let dst_is_dir = dst.is_dir();
    if src_is_dir && dst_is_dir {
        // 同名目录 → 合并，继续下钻找文件级冲突
        if let Ok(rd) = fs::read_dir(src) {
            for e in rd.flatten() {
                scan_into(&e.path(), &dst.join(e.file_name()), out);
            }
        }
        return;
    }
    out.push(Conflict {
        src: src.to_string_lossy().to_string(),
        dest: dst.to_string_lossy().to_string(),
        src_kind: kind(src_is_dir).into(),
        dest_kind: kind(dst_is_dir).into(),
        suggest: suggest_name(dst),
    });
}

/// 复制条目（按裁决表处理冲突），返回实际创建路径（供撤销记录）。
/// 无裁决记录的冲突按覆盖处理。
pub fn copy_entries_plan(
    paths: &[String],
    dest: &str,
    plan: &HashMap<String, Resolution>,
    mut cb: ProgressCb,
) -> Result<Vec<String>, String> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("目标不是目录：{}", dest.display()));
    }
    let mut created = Vec::with_capacity(paths.len());
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| format!("非法路径：{}", p))?;
        if let Some(t) = apply_transfer(src, &dest.join(name), plan, Mode::Copy, &mut cb)? {
            created.push(t.to_string_lossy().to_string());
        }
        if !cb(CbEvent::EntryDone) {
            return Err(cancelled().to_string());
        }
    }
    Ok(created)
}

/// 移动条目（按裁决表处理冲突），返回 (源, 目标) 路径对（供撤销反向移动）。
pub fn move_entries_plan(
    paths: &[String],
    dest: &str,
    plan: &HashMap<String, Resolution>,
    mut cb: ProgressCb,
) -> Result<Vec<(String, String)>, String> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("目标不是目录：{}", dest.display()));
    }
    let mut moved = Vec::with_capacity(paths.len());
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| format!("非法路径：{}", p))?;
        if let Some(t) = apply_transfer(src, &dest.join(name), plan, Mode::Move, &mut cb)? {
            moved.push((p.clone(), t.to_string_lossy().to_string()));
        }
        if !cb(CbEvent::EntryDone) {
            return Err(cancelled().to_string());
        }
    }
    Ok(moved)
}

/// 应用单个条目。返回最终落点；被跳过时返回 None。
fn apply_transfer(
    src: &Path,
    dst: &Path,
    plan: &HashMap<String, Resolution>,
    mode: Mode,
    cb: &mut dyn FnMut(CbEvent) -> bool,
) -> Result<Option<PathBuf>, String> {
    let mut target = dst.to_path_buf();
    if dst.exists() {
        match plan.get(&dst.to_string_lossy().to_string()) {
            Some(Resolution::Skip) => return Ok(None),
            Some(Resolution::Rename { name }) => {
                if name.trim().is_empty() {
                    return Err("改名不能为空".into());
                }
                target = dst.parent().unwrap_or_else(|| Path::new(".")).join(name);
                if target.exists() {
                    return Err(format!("改名目标已存在：{}", name));
                }
            }
            // 无裁决记录 → 覆盖（兼容旧调用方）
            Some(Resolution::Overwrite) | None => {}
        }
    }
    if src.is_dir() {
        apply_dir(src, &target, plan, mode, cb)?;
    } else {
        apply_file(src, &target, mode, cb)?;
    }
    Ok(Some(target))
}

fn apply_dir(
    src: &Path,
    target: &Path,
    plan: &HashMap<String, Resolution>,
    mode: Mode,
    cb: &mut dyn FnMut(CbEvent) -> bool,
) -> Result<(), String> {
    if target.exists() {
        if target.is_dir() {
            // 合并：保留目标已有内容
        } else {
            fs::remove_file(target).map_err(|e| format!("覆盖 {} 失败：{}", target.display(), e))?;
        }
    }
    fs::create_dir_all(target).map_err(|e| format!("创建目录 {} 失败：{}", target.display(), e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取 {} 失败：{}", src.display(), e))? {
        let e = entry.map_err(|e| e.to_string())?;
        apply_transfer(&e.path(), &target.join(e.file_name()), plan, mode, cb)?;
    }
    if mode == Mode::Move {
        // 跳过项会留在源目录，非空则删除失败，保留即可
        let _ = fs::remove_dir(src);
    }
    Ok(())
}

fn apply_file(
    src: &Path,
    target: &Path,
    mode: Mode,
    cb: &mut dyn FnMut(CbEvent) -> bool,
) -> Result<(), String> {
    if target.exists() && target.is_dir() {
        fs::remove_dir_all(target).map_err(|e| format!("覆盖目录 {} 失败：{}", target.display(), e))?;
    }
    if mode == Mode::Move {
        // Windows 上 rename 到已存在文件会失败，先删目标
        if target.exists() {
            fs::remove_file(target).map_err(|e| format!("覆盖 {} 失败：{}", target.display(), e))?;
        }
        if fs::rename(src, target).is_err() {
            copy_file_progress(src, target, cb)
                .map_err(|e| format!("移动 {} 失败：{}", src.display(), e))?;
            fs::remove_file(src).map_err(|e| format!("移动 {} 清理失败：{}", src.display(), e))?;
        }
    } else {
        copy_file_progress(src, target, cb)
            .map_err(|e| format!("复制 {} 失败：{}", src.display(), e))?;
    }
    Ok(())
}

/// 目标已存在时生成 `name_1.ext` 式默认改名（下划线 + 递增序号，插在扩展名前）。
fn suggest_name(dest: &Path) -> String {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let fname = dest
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (stem, ext) = split_ext(&fname);
    for i in 1..10000u32 {
        let cand = format!("{}_{}{}", stem, i, ext);
        if !parent.join(&cand).exists() {
            return cand;
        }
    }
    fname
}

/// 拆分扩展名（最后一个 `.`，且不在开头，兼容 `.bashrc`）。
fn split_ext(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// 复制条目（目录递归）到目标目录，同名**覆盖**（目录整体替换、类型冲突亦覆盖）。
/// 返回每个条目的实际创建路径（供撤销栈记录）。
pub fn copy_entries(paths: &[String], dest: &str, mut cb: ProgressCb) -> Result<Vec<String>, String> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("目标不是目录：{}", dest.display()));
    }
    let mut created = Vec::with_capacity(paths.len());
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| format!("非法路径：{}", p))?;
        let target = dest.join(name);
        copy_recursive(src, &target, &mut cb).map_err(|e| format!("复制 {} 失败：{}", p, e))?;
        created.push(target.to_string_lossy().to_string());
        if !cb(CbEvent::EntryDone) {
            return Err(cancelled().to_string());
        }
    }
    Ok(created)
}

/// 移动条目：同卷 rename，跨卷回退为复制 + 删除。
/// 返回每对 (源路径, 目标路径)，供撤销栈反向移动。
pub fn move_entries(paths: &[String], dest: &str, mut cb: ProgressCb) -> Result<Vec<(String, String)>, String> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("目标不是目录：{}", dest.display()));
    }
    let mut moved = Vec::with_capacity(paths.len());
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| format!("非法路径：{}", p))?;
        let target = dest.join(name);
        // 跨卷 rename 会失败，回退 copy+delete；同卷直接覆盖
        if fs::rename(src, &target).is_err() {
            copy_recursive(src, &target, &mut cb).map_err(|e| format!("移动 {} 失败：{}", p, e))?;
            remove_recursive(src).map_err(|e| format!("移动 {} 清理失败：{}", p, e))?;
        }
        moved.push((p.clone(), target.to_string_lossy().to_string()));
        if !cb(CbEvent::EntryDone) {
            return Err(cancelled().to_string());
        }
    }
    Ok(moved)
}

/// 校验用户输入的名称是单一路径片段。
/// 前端已过滤，这里是 IPC 边界的兜底：`Path::join` 遇到绝对路径会**替换**基路径，
/// 遇到 `..` 会跳出目标目录，两者都必须挡住。
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if name == "." || name == ".." {
        return Err(format!("名称不合法：{}", name));
    }
    if name.contains('/') || (cfg!(windows) && name.contains('\\')) {
        return Err("名称不能包含路径分隔符".into());
    }
    Ok(())
}

/// 重命名条目，返回新路径。
pub fn rename_entry(path: &str, new_name: &str) -> Result<String, String> {
    let p = Path::new(path);
    check_name(new_name)?;
    let parent = p.parent().ok_or("无父目录")?;
    let target = parent.join(new_name);
    if target.exists() {
        return Err(format!("{} 已存在", new_name));
    }
    fs::rename(p, &target).map_err(|e| format!("重命名失败：{}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// 删除条目（进回收站）。
/// IFileOperation 偶发瞬时中止（目录句柄被占用、回收站忙等），重试一次再报错。
pub fn delete_entries(paths: &[String]) -> Result<(), String> {
    let paths: Vec<&Path> = paths.iter().map(|s| Path::new(s)).collect();
    let attempt = || {
        trash::delete_all(&paths).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("拒绝访问") || msg.contains("Permission denied") || msg.contains("access") {
                format!("删除失败：权限不足，请以管理员身份运行 R-Dir，或将文件拖到回收站后手动清空。
详情：{}", msg)
            } else if msg.contains("being used") || msg.contains("占用") {
                format!("删除失败：文件正在被其他程序占用，请关闭后重试。
详情：{}", msg)
            } else if msg.contains("aborted") || msg.contains("Aborted") {
                // IFileOperation 的 "Some operations were aborted"：多为句柄占用或回收站瞬时不可用
                "删除失败：无法移入回收站（目录可能正被其他程序占用，或该磁盘回收站暂不可用）".to_string()
            } else {
                format!("删除失败：{}", msg)
            }
        })
    };
    match attempt() {
        Ok(()) => Ok(()),
        Err(_) => {
            std::thread::sleep(std::time::Duration::from_millis(250));
            attempt()
        }
    }
}

/// 永久删除条目（绕过回收站，不可恢复）。
pub fn permanent_delete_entries(paths: &[String]) -> Result<(), String> {
    for p in paths {
        let path = Path::new(p);
        remove_recursive(path).map_err(|e| format!("永久删除 {} 失败：{}", p, e))?;
    }
    Ok(())
}

/// 从回收站还原条目（撤销删除用）。按原始路径匹配，同路径多条取删除时间最新的一条。
/// 返回实际还原的路径。
/// 注：`trash::os_limited` 仅在 Windows 与非 macOS 的 Unix 提供（macOS 走 Finder 回收站），
/// 故 macOS 分支单独实现。
#[cfg(not(target_os = "macos"))]
pub fn restore_from_trash(paths: &[String]) -> Result<Vec<String>, String> {
    use std::collections::{HashMap, HashSet};
    use trash::os_limited;
    let want: HashSet<&str> = paths.iter().map(|s| s.as_str()).collect();
    let items = os_limited::list().map_err(|e| format!("读取回收站失败：{}", e))?;
    let mut latest: HashMap<String, trash::TrashItem> = HashMap::new();
    for item in items {
        let orig = item.original_path().to_string_lossy().to_string();
        if !want.contains(orig.as_str()) {
            continue;
        }
        match latest.get(&orig) {
            Some(prev) if prev.time_deleted >= item.time_deleted => continue,
            _ => {
                latest.insert(orig, item);
            }
        }
    }
    if latest.is_empty() {
        return Err("回收站中找不到这些条目，可能已被清空或移走".into());
    }
    let restore: Vec<trash::TrashItem> = latest.into_values().collect();
    let restored: Vec<String> = restore
        .iter()
        .map(|i| i.original_path().to_string_lossy().to_string())
        .collect();
    os_limited::restore_all(restore).map_err(|e| format!("从回收站还原失败：{}", e))?;
    Ok(restored)
}

/// macOS：trash crate 不提供 os_limited（Finder 回收站），按同名条目从 `~/.Trash` 移回原路径。
/// 覆盖常见场景（主卷、未重名冲突）；外置卷（/Volumes/X/.Trashes）与重名冲突条目会报「找不到」。
#[cfg(target_os = "macos")]
pub fn restore_from_trash(paths: &[String]) -> Result<Vec<String>, String> {
    let trash_dir = dirs::home_dir()
        .ok_or("无法定位用户目录")?
        .join(".Trash");
    let mut restored = Vec::new();
    for p in paths {
        let orig = Path::new(p);
        let name = orig
            .file_name()
            .ok_or_else(|| format!("非法路径：{p}"))?
            .to_string_lossy()
            .to_string();
        let cand = trash_dir.join(&name);
        if !cand.exists() {
            return Err(format!(
                "回收站中找不到 {name}（可能已被清空、重名冲突或位于外置卷）"
            ));
        }
        if orig.exists() {
            return Err(format!("原位置已有同名项目，无法还原：{p}"));
        }
        if let Some(parent) = orig.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        if fs::rename(&cand, orig).is_err() {
            // 跨卷回退：复制 + 删除
            copy_recursive(&cand, orig, &mut |_| true).map_err(|e| format!("还原失败：{e}"))?;
            remove_recursive(&cand).map_err(|e| format!("还原清理失败：{e}"))?;
        }
        restored.push(p.clone());
    }
    Ok(restored)
}

/// 新建文件夹，返回新路径。
pub fn create_dir(parent: &str, name: &str) -> Result<String, String> {
    check_name(name)?;
    let target = Path::new(parent).join(name);
    fs::create_dir(&target).map_err(|e| format!("新建文件夹失败：{}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// 新建空文件，返回新路径。
pub fn create_file(parent: &str, name: &str) -> Result<String, String> {
    check_name(name)?;
    let target = Path::new(parent).join(name);
    fs::write(&target, b"").map_err(|e| format!("新建文件失败：{}", e))?;
    Ok(target.to_string_lossy().to_string())
}

fn copy_recursive(src: &Path, dst: &Path, cb: &mut dyn FnMut(CbEvent) -> bool) -> std::io::Result<()> {
    if src.is_dir() {
        // 覆盖语义：目标已存在时先删除再复制；目标若是文件也一并清除（类型冲突同步用）
        if dst.exists() {
            if dst.is_dir() {
                std::fs::remove_dir_all(dst)?;
            } else {
                std::fs::remove_file(dst)?;
            }
        }
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let e = entry?;
            copy_recursive(&e.path(), &dst.join(e.file_name()), cb)?;
        }
    } else {
        // 文件覆盖目录（类型冲突同步用）
        if dst.exists() && dst.is_dir() {
            std::fs::remove_dir_all(dst)?;
        }
        copy_file_progress(src, dst, cb)?;
    }
    Ok(())
}

/// 平台快速路径：能 reflink/克隆就不搬数据，能交给系统复制引擎就不过应用内存。
/// Ok(true) = 已由快速路径完成；Ok(false) = 平台/文件系统不支持，走回退循环；
/// Err = 快速路径中途失败（半成品已就地清理）。
#[allow(unused_variables)]
fn copy_file_fast(src: &Path, dst: &Path, cb: &mut dyn FnMut(CbEvent) -> bool) -> std::io::Result<bool> {
    #[cfg(windows)]
    return copy_file_fast_windows(src, dst, cb);
    #[cfg(target_os = "macos")]
    return copy_file_fast_macos(src, dst, cb);
    #[cfg(target_os = "linux")]
    return copy_file_fast_linux(src, dst, cb);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (src, dst, cb);
        Ok(false)
    }
}

/// Windows：CopyFileExW（系统复制引擎，块级进度回调，回调内可取消；
/// 返回 PROGRESS_CANCEL 时系统自行删除目标半成品）。
#[cfg(windows)]
fn copy_file_fast_windows(
    src: &Path,
    dst: &Path,
    cb: &mut dyn FnMut(CbEvent) -> bool,
) -> std::io::Result<bool> {
    use std::os::raw::c_void;
    use std::os::windows::ffi::OsStrExt;

    type DWORD = u32;
    type LPVOID = *mut c_void;
    const PROGRESS_CONTINUE: DWORD = 0;
    const PROGRESS_CANCEL: DWORD = 1;
    const ERROR_REQUEST_ABORTED: i32 = 1235;
    const ERROR_OPERATION_ABORTED: i32 = 995;

    extern "system" {
        fn CopyFileExW(
            lpExistingFileName: *const u16,
            lpNewFileName: *const u16,
            lpProgressRoutine: Option<
                unsafe extern "system" fn(i64, i64, i64, i64, DWORD, DWORD, *mut c_void, *mut c_void, LPVOID) -> DWORD,
            >,
            lpData: LPVOID,
            lpCancel: *mut i32,
            dwCopyFlags: DWORD,
        ) -> i32;
    }

    struct Ctx<'a>(&'a mut dyn FnMut(CbEvent) -> bool);

    extern "system" fn routine(
        total: i64,
        transferred: i64,
        _stream_size: i64,
        _stream_transferred: i64,
        _stream_number: DWORD,
        _reason: DWORD,
        _hsrc: *mut c_void,
        _hdst: *mut c_void,
        data: LPVOID,
    ) -> DWORD {
        let ctx = unsafe { &mut *(data as *mut Ctx) };
        if (ctx.0)(CbEvent::Bytes(transferred.max(0) as u64, total.max(0) as u64)) {
            PROGRESS_CONTINUE
        } else {
            PROGRESS_CANCEL
        }
    }

    let to_wide = |p: &Path| -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    };
    let srcw = to_wide(src);
    let dstw = to_wide(dst);
    let mut ctx = Ctx(cb);
    let mut cancel: i32 = 0;
    let ok = unsafe {
        CopyFileExW(
            srcw.as_ptr(),
            dstw.as_ptr(),
            Some(routine),
            &mut ctx as *mut Ctx as LPVOID,
            &mut cancel,
            0,
        )
    };
    if ok != 0 {
        Ok(true)
    } else {
        let e = std::io::Error::last_os_error();
        let _ = fs::remove_file(dst); // 清理半成品（取消时系统通常已删，兜底）
        if e.raw_os_error() == Some(ERROR_REQUEST_ABORTED) || e.raw_os_error() == Some(ERROR_OPERATION_ABORTED) {
            Err(cancelled())
        } else {
            Err(e)
        }
    }
}

/// macOS：clonefile（APFS 同卷 O(1) 克隆，不搬数据）；跨卷/不支持时回退。
#[cfg(target_os = "macos")]
fn copy_file_fast_macos(
    src: &Path,
    dst: &Path,
    cb: &mut dyn FnMut(CbEvent) -> bool,
) -> std::io::Result<bool> {
    use std::os::unix::ffi::OsStrExt;
    let csrc = std::ffi::CString::new(src.as_os_str().as_bytes())?;
    let cdst = std::ffi::CString::new(dst.as_os_str().as_bytes())?;
    let _ = fs::remove_file(dst); // clonefile 要求目标不存在；此处语义为覆盖
    let rc = unsafe { libc::clonefile(csrc.as_ptr(), cdst.as_ptr(), 0) };
    if rc == 0 {
        let total = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        if !cb(CbEvent::Bytes(total, total)) {
            let _ = fs::remove_file(dst);
            return Err(cancelled());
        }
        Ok(true)
    } else {
        let e = std::io::Error::last_os_error();
        match e.raw_os_error() {
            // EXDEV 跨卷 / ENOTSUP·ENOSYS 文件系统不支持 / EPERM / EINVAL → 回退
            Some(libc::EXDEV)
            | Some(libc::ENOTSUP)
            | Some(libc::ENOSYS)
            | Some(libc::EPERM)
            | Some(libc::EINVAL) => Ok(false),
            _ => Err(e),
        }
    }
}

/// Linux：FICLONE ioctl（btrfs/XFS/ZFS/NFSv4.2 等 reflink，不搬数据）；不支持时回退。
/// （不再走 copy_file_range：本地常规文件上它只是内核态循环，收益可忽略，徒增部分拷贝的回退复杂度。）
#[cfg(target_os = "linux")]
fn copy_file_fast_linux(
    src: &Path,
    dst: &Path,
    cb: &mut dyn FnMut(CbEvent) -> bool,
) -> std::io::Result<bool> {
    use std::os::unix::io::AsRawFd;
    let srcf = fs::File::open(src)?;
    let _ = fs::remove_file(dst);
    let dstf = fs::File::create(dst)?;
    let rc = unsafe { libc::ioctl(dstf.as_raw_fd(), libc::FICLONE, srcf.as_raw_fd()) };
    if rc == 0 {
        let total = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        if !cb(CbEvent::Bytes(total, total)) {
            let _ = fs::remove_file(dst);
            return Err(cancelled());
        }
        Ok(true)
    } else {
        // 文件系统不支持 reflink：删掉空目标，走用户态回退循环
        drop(dstf);
        let _ = fs::remove_file(dst);
        Ok(false)
    }
}

/// 流式复制文件并回报进度。优先平台快速路径（reflink/系统复制引擎，
/// FastCopy 思路：避开用户态逐块搬运），不支持时回退 1MB 缓冲循环。
fn copy_file_progress(src: &Path, dst: &Path, cb: &mut dyn FnMut(CbEvent) -> bool) -> std::io::Result<()> {
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if !cb(CbEvent::Start(&name)) {
        return Err(cancelled());
    }
    match copy_file_fast(src, dst, cb) {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => return Err(e),
    }
    let total = src.metadata().map(|m| m.len()).unwrap_or(0);
    let mut r = fs::File::open(src)?;
    let mut w = fs::File::create(dst)?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n])?;
        done += n as u64;
        if !cb(CbEvent::Bytes(done, total)) {
            let _ = fs::remove_file(dst);
            return Err(cancelled());
        }
    }
    w.flush()?;
    Ok(())
}

fn remove_recursive(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rdir-ops-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn plan(items: &[(&str, Resolution)]) -> HashMap<String, Resolution> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn noop() -> impl FnMut(CbEvent) -> bool {
        |_| true
    }

    #[test]
    fn scan_merges_same_name_dir_and_reports_nested_file() {
        let base = tmp("scan-merge");
        let src = base.join("src/A");
        let dst = base.join("dst/A");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("x.txt"), "new").unwrap();
        fs::write(src.join("only_src.txt"), "s").unwrap();
        fs::write(dst.join("x.txt"), "old").unwrap();
        fs::write(dst.join("extra.txt"), "keep").unwrap();

        let conflicts = scan_conflicts(
            &[base.join("src/A").to_string_lossy().to_string()],
            &base.join("dst").to_string_lossy().to_string(),
        )
        .unwrap();
        // 目录本身不冲突；只报内部同名文件
        assert_eq!(conflicts.len(), 1, "应只报 1 条冲突: {conflicts:?}");
        // 用 PathBuf 比较：scan_conflicts 以 "/" 拼接，Windows 下与 join 的 "\\" 不同
        assert_eq!(std::path::PathBuf::from(&conflicts[0].dest), dst.join("x.txt"));
        assert_eq!(conflicts[0].dest_kind, "file");
        assert_eq!(conflicts[0].suggest, "x_1.txt");
    }

    #[test]
    fn scan_type_mismatch_is_conflict() {
        let base = tmp("scan-type");
        let src = base.join("src/a");
        let dst = base.join("dst/a");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("f.txt"), "x").unwrap();
        // 目标 a 是文件，源 a 是目录 → 类型不匹配冲突
        let dst2 = base.join("dst2");
        fs::create_dir_all(&dst2).unwrap();
        fs::write(dst2.join("a"), "iamfile").unwrap();
        let conflicts = scan_conflicts(
            &[base.join("src/a").to_string_lossy().to_string()],
            &dst2.to_string_lossy().to_string(),
        )
        .unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].src_kind, "dir");
        assert_eq!(conflicts[0].dest_kind, "file");
        assert_eq!(conflicts[0].suggest, "a_1");
    }

    #[test]
    fn suggest_name_underscore_increment_skips_taken() {
        let base = tmp("suggest");
        fs::write(base.join("name.txt"), "1").unwrap();
        fs::write(base.join("name_1.txt"), "2").unwrap();
        assert_eq!(suggest_name(&base.join("name.txt")), "name_2.txt");
        fs::write(base.join("dir"), "").unwrap();
        fs::write(base.join("dir_1"), "").unwrap();
        assert_eq!(suggest_name(&base.join("dir")), "dir_2");
        // 点开头文件无扩展名
        fs::write(base.join(".bashrc"), "").unwrap();
        assert_eq!(suggest_name(&base.join(".bashrc")), ".bashrc_1");
    }

    #[test]
    fn copy_plan_overwrite_replaces_file() {
        let base = tmp("copy-overwrite");
        let src = base.join("src.txt");
        let dest = base.join("dst");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest.join("src.txt"), "old").unwrap();
        let d = dest.join("src.txt").to_string_lossy().to_string();
        let created = copy_entries_plan(
            &[src.to_string_lossy().to_string()],
            &dest.to_string_lossy().to_string(),
            &plan(&[(&d, Resolution::Overwrite)]),
            &mut noop(),
        )
        .unwrap();
        assert_eq!(created, vec![d.clone()]);
        assert_eq!(fs::read_to_string(&d).unwrap(), "new");
    }

    #[test]
    fn copy_plan_rename_keeps_original() {
        let base = tmp("copy-rename");
        let src = base.join("a.txt");
        let dest = base.join("dst");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let conflict = dest.join("a.txt").to_string_lossy().to_string();
        let renamed = dest.join("a_1.txt").to_string_lossy().to_string();
        let created = copy_entries_plan(
            &[src.to_string_lossy().to_string()],
            &dest.to_string_lossy().to_string(),
            &plan(&[(&conflict, Resolution::Rename { name: "a_1.txt".into() })]),
            &mut noop(),
        )
        .unwrap();
        assert_eq!(created, vec![renamed.clone()]);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "new");
    }

    #[test]
    fn copy_plan_skip_leaves_dest_untouched() {
        let base = tmp("copy-skip");
        let src = base.join("a.txt");
        let dest = base.join("dst");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let d = dest.join("a.txt").to_string_lossy().to_string();
        let created = copy_entries_plan(
            &[src.to_string_lossy().to_string()],
            &dest.to_string_lossy().to_string(),
            &plan(&[(&d, Resolution::Skip)]),
            &mut noop(),
        )
        .unwrap();
        assert!(created.is_empty(), "跳过不应产生创建记录");
        assert_eq!(fs::read_to_string(&d).unwrap(), "old");
    }

    #[test]
    fn dir_merge_preserves_extra_and_updates_same_name() {
        let base = tmp("dir-merge");
        let src = base.join("src/A");
        let dst = base.join("dst/A");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("x.txt"), "new").unwrap();
        fs::write(src.join("only_src.txt"), "s").unwrap();
        fs::write(dst.join("x.txt"), "old").unwrap();
        fs::write(dst.join("extra.txt"), "keep").unwrap();
        let conflict = dst.join("x.txt").to_string_lossy().to_string();
        copy_entries_plan(
            &[base.join("src/A").to_string_lossy().to_string()],
            &base.join("dst").to_string_lossy().to_string(),
            &plan(&[(&conflict, Resolution::Overwrite)]),
            &mut noop(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(dst.join("x.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dst.join("extra.txt")).unwrap(), "keep");
        assert_eq!(fs::read_to_string(dst.join("only_src.txt")).unwrap(), "s");
    }

    #[test]
    fn file_overwrites_existing_dir_of_same_name() {
        let base = tmp("file-vs-dir");
        let src = base.join("a");
        let dest = base.join("dst");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, "iamfile").unwrap();
        fs::create_dir_all(dest.join("a")).unwrap();
        fs::write(dest.join("a/inside.txt"), "x").unwrap();
        let d = dest.join("a").to_string_lossy().to_string();
        copy_entries_plan(
            &[src.to_string_lossy().to_string()],
            &dest.to_string_lossy().to_string(),
            &plan(&[(&d, Resolution::Overwrite)]),
            &mut noop(),
        )
        .unwrap();
        assert!(dest.join("a").is_file(), "同名目录应被文件覆盖");
        assert_eq!(fs::read_to_string(dest.join("a")).unwrap(), "iamfile");
    }

    #[test]
    fn move_plan_renames_and_removes_source() {
        let base = tmp("move-rename");
        let src = base.join("a.txt");
        let dest = base.join("dst");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, "data").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let conflict = dest.join("a.txt").to_string_lossy().to_string();
        let renamed = dest.join("a_1.txt").to_string_lossy().to_string();
        let moved = move_entries_plan(
            &[src.to_string_lossy().to_string()],
            &dest.to_string_lossy().to_string(),
            &plan(&[(&conflict, Resolution::Rename { name: "a_1.txt".into() })]),
            &mut noop(),
        )
        .unwrap();
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].1, renamed);
        assert!(!src.exists(), "移动后源应消失");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "data");
    }

    #[test]
    fn rename_to_taken_name_errors() {
        let base = tmp("rename-taken");
        let src = base.join("a.txt");
        let dest = base.join("dst");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, "x").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        fs::write(dest.join("taken.txt"), "t").unwrap();
        let conflict = dest.join("a.txt").to_string_lossy().to_string();
        let r = copy_entries_plan(
            &[src.to_string_lossy().to_string()],
            &dest.to_string_lossy().to_string(),
            &plan(&[(&conflict, Resolution::Rename { name: "taken.txt".into() })]),
            &mut noop(),
        );
        assert!(r.is_err(), "改名撞已有文件应报错");
    }

    // ---- 单条目的新建 / 重命名 / 永久删除（此前完全无覆盖） ----

    #[test]
    fn create_dir_and_file_then_rename() {
        let base = tmp("create-rename");
        let p = base.to_string_lossy().to_string();

        let dir = create_dir(&p, "新文件夹").unwrap();
        assert!(Path::new(&dir).is_dir());
        assert_eq!(Path::new(&dir).file_name().unwrap(), "新文件夹");

        let file = create_file(&p, "空.txt").unwrap();
        assert!(Path::new(&file).is_file());
        assert_eq!(fs::metadata(&file).unwrap().len(), 0);

        let renamed = rename_entry(&file, "改名后.txt").unwrap();
        assert!(Path::new(&renamed).is_file());
        assert!(!Path::new(&file).exists(), "旧路径应已不存在");
    }

    #[test]
    fn rename_rejects_empty_and_taken_name() {
        let base = tmp("rename-err");
        let a = base.join("a.txt");
        fs::write(&a, "x").unwrap();
        fs::write(base.join("b.txt"), "y").unwrap();
        let a = a.to_string_lossy().to_string();

        assert!(rename_entry(&a, "").is_err(), "空名应报错");
        assert!(rename_entry(&a, "b.txt").is_err(), "撞已有文件应报错");
        assert!(Path::new(&a).exists(), "失败时不应动原文件");
    }

    /// IPC 边界兜底：绝对路径会被 Path::join 当成替换，`..` 会跳出目标目录
    #[test]
    fn name_cannot_escape_parent() {
        let base = tmp("escape");
        let p = base.to_string_lossy().to_string();

        for bad in ["..", ".", "../evil", "/tmp/evil", "a/b"] {
            assert!(create_dir(&p, bad).is_err(), "create_dir 应拒绝 {bad}");
            assert!(create_file(&p, bad).is_err(), "create_file 应拒绝 {bad}");
        }
        let victim = base.join("victim.txt");
        fs::write(&victim, "x").unwrap();
        let victim = victim.to_string_lossy().to_string();
        assert!(rename_entry(&victim, "../escaped.txt").is_err());
        assert!(rename_entry(&victim, "/tmp/escaped.txt").is_err());
        assert!(Path::new(&victim).exists(), "被拒后原文件应还在");
        assert!(!base.parent().unwrap().join("escaped.txt").exists());
    }

    #[test]
    fn permanent_delete_removes_dir_recursively() {
        let base = tmp("perm-del");
        let victim = base.join("victim");
        fs::create_dir_all(victim.join("nested")).unwrap();
        fs::write(victim.join("nested/x.txt"), "x").unwrap();

        permanent_delete_entries(&[victim.to_string_lossy().to_string()]).unwrap();
        assert!(!victim.exists(), "目录及其内容应被递归删除");
        assert!(base.exists(), "父目录不应受影响");
    }

    #[test]
    fn permanent_delete_missing_path_errors_without_panic() {
        let base = tmp("perm-del-missing");
        let ghost = base.join("nope").to_string_lossy().to_string();
        assert!(permanent_delete_entries(&[ghost]).is_err());
    }

    // ---- 进度事件协议（Start/Bytes/EntryDone）与取消 ----

    /// 统计进度事件：Start 次数、EntryDone 次数、最大 (done,total)
    #[derive(Debug, Default)]
    struct Events {
        starts: usize,
        entry_dones: usize,
        max_done: u64,
        max_total: u64,
        last_name: String,
    }

    fn track(ev: &mut Events, e: CbEvent) -> bool {
        match e {
            CbEvent::Start(name) => {
                ev.starts += 1;
                ev.last_name = name.to_string();
            }
            CbEvent::Bytes(done, total) => {
                ev.max_done = ev.max_done.max(done);
                ev.max_total = ev.max_total.max(total);
            }
            CbEvent::EntryDone => ev.entry_dones += 1,
        }
        true
    }

    #[test]
    fn copy_reports_start_bytes_entrydone() {
        let base = tmp("events");
        let dir = base.join("d");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.bin"), vec![0u8; 100]).unwrap();
        fs::write(dir.join("b.bin"), b"small").unwrap();
        fs::write(base.join("top.bin"), vec![0u8; 10]).unwrap();
        fs::create_dir_all(base.join("out")).unwrap();

        let mut ev = Events::default();
        copy_entries(
            &[dir.to_string_lossy().to_string(), base.join("top.bin").to_string_lossy().to_string()],
            &base.join("out").to_string_lossy().to_string(),
            &mut |e| track(&mut ev, e),
        )
        .unwrap();
        // 目录内 2 个文件 + 顶层 1 个文件 = 3 次 Start
        assert_eq!(ev.starts, 3, "每个文件一次 Start: {ev:?}");
        // 顶层条目 2 个 = 2 次 EntryDone（目录整体算一条）
        assert_eq!(ev.entry_dones, 2, "每个顶层条目一次 EntryDone: {ev:?}");
        assert_eq!(ev.max_done, 100);
        assert!(ev.max_total >= 100);
    }

    #[test]
    fn copy_cancel_aborts_with_error() {
        let base = tmp("cancel-cb");
        fs::write(base.join("f.txt"), b"data").unwrap();
        fs::create_dir_all(base.join("out")).unwrap();
        let r = copy_entries(
            &[base.join("f.txt").to_string_lossy().to_string()],
            &base.join("out").to_string_lossy().to_string(),
            &mut |_| false,
        );
        assert!(r.is_err(), "回调返回 false 应中止");
        // 空文件也能走完 Start → EntryDone 协议（0 字节不产生 Bytes）
        fs::write(base.join("empty.txt"), b"").unwrap();
        let mut ev = Events::default();
        copy_entries(
            &[base.join("empty.txt").to_string_lossy().to_string()],
            &base.join("out").to_string_lossy().to_string(),
            &mut |e| track(&mut ev, e),
        )
        .unwrap();
        assert_eq!(ev.starts, 1);
        assert_eq!(ev.entry_dones, 1);
    }
}

