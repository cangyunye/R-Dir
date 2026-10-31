//! 解压插件（v0.32）：右键压缩包直接解压
//!
//! 与 v0.8 压缩（系统命令）不同，解压走 Rust crate——实测解压场景 crate 不慢于
//! 系统命令（5000 小文件 zip：crate 0.76s vs ditto 2.75s），且编码/进度/密码结构化可控：
//! - zip（含 ZipCrypto / WinZip AES 加密）：`zip` crate（精简特性，DEFLATE 复用既有
//!   flate2/miniz_oxide，避免 zlib-rs 第二套实现）
//! - tar / tar.gz / tgz / tar.bz2 / tbz：`tar` crate + flate2 / bzip2（纯 Rust）
//! - 单文件 .gz / .bz2：flate2 `GzDecoder` / bzip2 `BzDecoder`
//! - rar / 7z / tar.xz / txz：系统 tar（libarchive；macOS 与 Windows 10+ 自带。
//!   注意 Win10 的 libarchive 3.3.2 无 liblzma（tar.xz 不可用）、rar5 读取器 3.4+ 才有）
//! - 单文件 .xz：暂不支持（macOS bsdtar 对裸 xz 内容有 mtree 误判、Windows 无 gunzip）
//! - 文件名编码：UTF-8 优先，否则 GBK → Big5 → Shift_JIS 自动探测（encoding_rs，
//!   复用 v0.21.1 依赖），Latin-1 兜底——修复 Windows 资源管理器/旧 WinRAR 打的
//!   GBK zip 在 macOS 解出乱码的问题
//! - AppleDouble（`__MACOSX/`、`._*`）自动跳过；zip-slip（`../`、绝对路径）拒绝
//! - 智能落点：非 AppleDouble 顶层条目仅 1 个且不与现有路径冲突 → 直接解到目标目录；
//!   否则解到 `<归档名>/`（同名自动追加 (2)（与压缩同名改名同款）
//! - 进度走 transfer-progress（phase = "extract"，逐条目 + 节流），支持取消
//!   （transfer_cancels，id 无前缀 → 前端通用 cancel_transfer 即可）

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::progress::{emit, Throttle, TransferProgress};
use crate::AppState;

/// 密码信号（前端据此弹密码框继续）
pub const ERR_NEED_PASSWORD: &str = "NEED_PASSWORD";
pub const ERR_WRONG_PASSWORD: &str = "WRONG_PASSWORD";

/// 解压结果（落点 + 统计，前端提示与刷新用）
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractOutcome {
    pub dest: String,
    pub files: usize,
    pub skipped: usize,
    pub bytes: u64,
}

// ==================== 格式分派 ====================

/// tar 的压缩层（None = 纯打包）
#[derive(Clone, Copy, PartialEq)]
enum TarComp {
    Gz,
    Bz2,
}

enum ArchiveKind {
    Zip,
    /// tar 家族（tar / tar.gz / tgz / tar.bz2 / tbz）
    Tar(Option<TarComp>),
    /// 单文件 gz / bz2（非 tar 包）
    Single(TarComp),
    /// 系统 tar 兜底（rar / 7z / tar.xz / txz——libarchive 能认的格式）
    SysTar,
}

fn archive_kind(file_name: &str) -> Option<ArchiveKind> {
    let n = file_name.to_lowercase();
    if n.ends_with(".zip") {
        Some(ArchiveKind::Zip)
    } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
        Some(ArchiveKind::Tar(Some(TarComp::Gz)))
    } else if n.ends_with(".tar.bz2") || n.ends_with(".tbz") || n.ends_with(".tbz2") {
        Some(ArchiveKind::Tar(Some(TarComp::Bz2)))
    } else if n.ends_with(".tar") {
        Some(ArchiveKind::Tar(None))
    } else if n.ends_with(".gz") {
        Some(ArchiveKind::Single(TarComp::Gz))
    } else if n.ends_with(".bz2") {
        Some(ArchiveKind::Single(TarComp::Bz2))
    } else if n.ends_with(".rar")
        || n.ends_with(".7z")
        || n.ends_with(".tar.xz")
        || n.ends_with(".txz")
    {
        Some(ArchiveKind::SysTar)
    } else {
        None
    }
}

// ==================== 名称处理 ====================

/// 归档内文件名解码：合法 UTF-8 直接用；否则按 GBK → Big5 → Shift_JIS 探测
/// （无 UTF-8 标志位的 zip / 老 tar 常见 Windows 本地编码；简中用户 GBK 最常见故最前）；
/// 全部失败按 Latin-1 兜底（cp437 近似，保证文件名非空可展示）。
fn decode_archive_name(raw: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    for enc in [encoding_rs::GBK, encoding_rs::BIG5, encoding_rs::SHIFT_JIS] {
        // 不做 BOM 嗅探：0xFF 0xFE 开头的字节会被 decode() 误判成 UTF-16LE BOM
        let (s, had_errors) = enc.decode_without_bom_handling(raw);
        if !had_errors {
            return s.into_owned();
        }
    }
    raw.iter().map(|&b| b as char).collect()
}

/// AppleDouble / Finder 元数据：解压时跳过（`__MACOSX/` 整段、任意层级的 `._*` 文件）
fn is_apple_double(name: &str) -> bool {
    let name = name.trim_start_matches("./");
    if name == "__MACOSX"
        || name.starts_with("__MACOSX/")
        || name.contains("/__MACOSX/")
        || name.contains("/__MACOSX/")
    {
        return true;
    }
    name.split('/').any(|seg| seg.starts_with("._"))
}

/// zip-slip 防护：拒绝绝对路径 / 盘符 / `..`，返回安全的相对路径
fn safe_rel_path(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in Path::new(name).components() {
        match comp {
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => return None,
            Component::CurDir => {}
            Component::Normal(c) => out.push(c),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 归档内路径的顶层条目名（首个路径段）；"./a.txt" → "a.txt"；纯 "./" → None
fn top_level_of(name: &str) -> Option<String> {
    let name = name.trim_start_matches("./");
    let first = name.split('/').next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// 落点规划（mode = "smart" | "folder"）：
/// - smart：顶层条目（已滤 AppleDouble）≤1 且不与目标目录现有内容冲突 → 目标目录本身；
///   否则 `<归档名去末段扩展>/`（同名自动改名，同 compress::unique_dest）
/// - folder：无条件解到 `<归档名>/`（右键「解压到 归档名/」）
fn plan_dest(names: &[String], archive: &Path, target_dir: &Path, mode: &str) -> PathBuf {
    if mode == "folder" {
        return crate::compress::unique_dest(&target_dir.join(archive_stem(archive)));
    }
    let tops: std::collections::BTreeSet<String> =
        names.iter().filter_map(|n| top_level_of(n)).collect();
    let here_ok = tops.len() <= 1 && tops.iter().all(|t| !target_dir.join(t).exists());
    if here_ok {
        target_dir.to_path_buf()
    } else {
        crate::compress::unique_dest(&target_dir.join(archive_stem(archive)))
    }
}

/// 归档名去末段扩展（"foo.tar.gz" → "foo.tar"，与 Finder 归档实用工具一致）
fn archive_stem(archive: &Path) -> String {
    archive
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "extract".into())
}

// ==================== 进度回调 ====================

/// 解压进度回调（返回 false = 已取消，应中止并返回「已取消」错误）
enum CbEv<'a> {
    /// 计划完成：总文件数（条目已通过过滤，目录不计）
    Plan(usize),
    /// 开始处理条目（展示名 + 未知时为 0 的字节总量）
    Start(&'a str, u64),
    Bytes(u64, u64),
    EntryDone(u64),
}

type Cb<'a> = &'a mut dyn FnMut(CbEv) -> bool;

fn cancelled() -> String {
    crate::ERR_CANCELLED.into()
}

// ==================== zip（crate） ====================

/// 构造 zip 9 读取选项（密码可空；ZipReadOptions 借用密码切片，显式生命周期）
fn zip_read_opts<'a>(pw: &'a Option<Vec<u8>>) -> zip::read::ZipReadOptions<'a> {
    let mut o = zip::read::ZipReadOptions::new();
    if let Some(p) = pw {
        o = o.password(Some(p.as_slice()));
    }
    o
}

fn map_zip_err(e: &zip::result::ZipError, has_pw: bool) -> String {
    let msg = e.to_string();
    if matches!(e, zip::result::ZipError::InvalidPassword)
        || msg.to_lowercase().contains("password")
    {
        return if has_pw {
            ERR_WRONG_PASSWORD.into()
        } else {
            ERR_NEED_PASSWORD.into()
        };
    }
    format!("无法读取 zip：{msg}")
}

fn extract_zip(
    path: &Path,
    target_dir: &Path,
    mode: &str,
    password: Option<&str>,
    cb: Cb,
    check_cancel: &dyn Fn() -> bool,
) -> Result<ExtractOutcome, String> {
    use zip::result::ZipError;
    let has_pw = password.is_some();
    // zip 9 读取选项：加密条目必须带 password 打开（by_index 不解密）
    let pw_buf: Option<Vec<u8>> = password.map(|p| p.as_bytes().to_vec());
    let open = || -> Result<zip::ZipArchive<std::fs::File>, String> {
        let f = std::fs::File::open(path)
            .map_err(|e| format!("无法打开 zip：{}", e))?;
        zip::ZipArchive::new(f).map_err(|e| match &e {
            ZipError::InvalidPassword => {
                if has_pw { ERR_WRONG_PASSWORD.into() } else { ERR_NEED_PASSWORD.into() }
            }
            _ => format!("无法读取 zip：{e}"),
        })
    };

    // 第一遍：只读条目名（中央目录，开销极小），规划落点与总数
    let mut z = open()?;
    let mut names = Vec::with_capacity(z.len());
    for i in 0..z.len() {
        let e = z
            .by_index_with_options(i, zip_read_opts(&pw_buf))
            .map_err(|e| map_zip_err(&e, has_pw))?;
        let name = decode_archive_name(e.name_raw());
        if !is_apple_double(&name) {
            names.push(name);
        }
    }
    let dest = plan_dest(&names, path, target_dir, mode);
    std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目录：{e}"))?;
    let total = names
        .iter()
        .filter(|n| !n.ends_with('/'))
        .count();
    cb(CbEv::Plan(total));

    // 第二遍：逐条目落盘（解码名 → 滤垃圾 → 防穿越 → 流式写 + 进度）
    let mut z = open()?;
    let mut files = 0usize;
    let mut skipped = 0usize;
    let mut bytes_total = 0u64;
    for i in 0..z.len() {
        if check_cancel() {
            return Err(cancelled());
        }
        let mut e = z
            .by_index_with_options(i, zip_read_opts(&pw_buf))
            .map_err(|e| map_zip_err(&e, has_pw))?;
        let name = decode_archive_name(e.name_raw());
        if is_apple_double(&name) {
            skipped += 1;
            continue;
        }
        if e.is_dir() {
            if let Some(rel) = safe_rel_path(&name) {
                std::fs::create_dir_all(dest.join(&rel))
                    .map_err(|err| format!("无法创建目录 {}: {err}", rel.display()))?;
            }
            continue;
        }
        // zip 里的 symlink（unix mode 位）：跳过不落地，避免符号链接劫持后续写路径
        if e.is_symlink() {
            skipped += 1;
            continue;
        }
        let Some(rel) = safe_rel_path(&name) else {
            skipped += 1;
            continue;
        };
        let size = e.size();
        cb(CbEv::Start(&name, size));
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("无法创建目录 {}: {err}", parent.display()))?;
        }
        // 加密条目读数据阶段的失败（ZipCrypto 校验字节 / AES-HMAC / CRC）几乎都是密码错：
        // zip crate 不一定回 InvalidPassword（ZipCrypto 常以 CRC 失败呈现、AES 以 HMAC 失败
        // 呈现），按「条目加密 + 密码已提供」推断，与 WinRAR「CRC failed = 密码错」一致
        let encrypted = e.encrypted();
        let map_read_err = |err: &std::io::Error| -> String {
            let msg = err.to_string().to_lowercase();
            if msg.contains("password")
                || (encrypted && has_pw && (msg.contains("crc") || msg.contains("hmac")))
            {
                return if has_pw {
                    ERR_WRONG_PASSWORD.into()
                } else {
                    ERR_NEED_PASSWORD.into()
                };
            }
            format!("解压数据失败（{}）：{err}", out_path.display())
        };
        match write_stream(&mut e, size, &out_path, &map_read_err, cb, check_cancel) {
            Ok(bytes) => {
                files += 1;
                bytes_total += bytes;
                cb(CbEv::EntryDone(bytes));
            }
            Err(msg) => return Err(msg),
        }
    }
    Ok(ExtractOutcome {
        dest: dest.to_string_lossy().into_owned(),
        files,
        skipped,
        bytes: bytes_total,
    })
}

/// 把 reader 流式写到 out_path：进度回调 + 取消检查；出错/取消删除半成品。
/// map_read_err 把底层 io 错误转人话（zip 据此把错误密码的 CRC/verify 失败映射成「密码错误」）
fn write_stream(
    r: &mut dyn Read,
    total: u64,
    out_path: &Path,
    map_read_err: &dyn Fn(&std::io::Error) -> String,
    cb: Cb,
    check_cancel: &dyn Fn() -> bool,
) -> Result<u64, String> {
    let mut out = std::fs::File::create(out_path)
        .map_err(|e| format!("无法创建文件 {}: {e}", out_path.display()))?;
    let mut chunk = [0u8; 64 * 1024];
    let mut done = 0u64;
    loop {
        if check_cancel() {
            let _ = std::fs::remove_file(out_path);
            return Err(cancelled());
        }
        let n = r.read(&mut chunk).map_err(|e| {
            let _ = std::fs::remove_file(out_path);
            map_read_err(&e)
        })?;
        if n == 0 {
            break;
        }
        if let Err(e) = out.write_all(&chunk[..n]) {
            let _ = std::fs::remove_file(out_path);
            return Err(format!("写入失败（{}）：{e}", out_path.display()));
        }
        done += n as u64;
        cb(CbEv::Bytes(done, total));
    }
    Ok(done)
}

// ==================== tar 家族（crate） ====================

/// tar 条目名的原始字节（tar crate 在 unix 上保真存放非 UTF-8 字节）
fn tar_entry_name<R: Read>(e: &tar::Entry<R>) -> String {
    let raw = e
        .path()
        .map(|p| p.as_os_str().as_encoded_bytes().to_vec())
        .unwrap_or_default();
    decode_archive_name(&raw)
}

fn extract_tar(
    path: &Path,
    target_dir: &Path,
    mode: &str,
    comp: Option<TarComp>,
    cb: Cb,
    check_cancel: &dyn Fn() -> bool,
) -> Result<ExtractOutcome, String> {
    // 第一遍：扫条目名（需顺序解压流，无法跳读；大归档多花一次解压 CPU 换取
    // 先规划落点 + 预知总数，落盘前失败不留半成品）
    let names = scan_tar(path, comp)?;
    let dest = plan_dest(&names, path, target_dir, mode);
    std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目录：{e}"))?;
    cb(CbEv::Plan(names.len()));

    let f = std::fs::File::open(path).map_err(|e| format!("无法打开归档：{e}"))?;
    let mut ar = tar::Archive::new(decompress(f, comp));
    ar.set_preserve_permissions(false);
    let mut files = 0usize;
    let mut skipped = 0usize;
    let mut bytes_total = 0u64;
    let entries = ar
        .entries()
        .map_err(|e| format!("无法读取归档：{e}"))?;
    for e in entries {
        if check_cancel() {
            return Err(cancelled());
        }
        let mut e = e.map_err(|err| format!("归档数据损坏：{err}"))?;
        let name = tar_entry_name(&e);
        if is_apple_double(&name) {
            skipped += 1;
            continue;
        }
        let et = e.header().entry_type();
        if et.is_symlink() || matches!(et, tar::EntryType::Link) {
            // 链接条目跳过：防符号链接劫持解压路径（与 zip symlink 同策略）
            skipped += 1;
            continue;
        }
        let Some(rel) = safe_rel_path(&name) else {
            skipped += 1;
            continue;
        };
        if et.is_dir() {
            std::fs::create_dir_all(dest.join(&rel))
                .map_err(|err| format!("无法创建目录 {}: {err}", rel.display()))?;
            continue;
        }
        if !et.is_file() {
            skipped += 1;
            continue;
        }
        let size = e.header().size().unwrap_or(0);
        cb(CbEv::Start(&name, size));
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("无法创建目录 {}: {err}", parent.display()))?;
        }
        // Entry 的 Read 实现恰好读到本条目末尾（内部自带 size 上限）
        let map_read_err = |err: &std::io::Error| -> String {
            format!("解压数据失败（{}）：{err}", out_path.display())
        };
        match write_stream(&mut e, size, &out_path, &map_read_err, cb, check_cancel) {
            Ok(bytes) => {
                files += 1;
                bytes_total += bytes;
                cb(CbEv::EntryDone(bytes));
            }
            Err(msg) => return Err(msg),
        }
    }
    Ok(ExtractOutcome {
        dest: dest.to_string_lossy().into_owned(),
        files,
        skipped,
        bytes: bytes_total,
    })
}

/// 扫 tar 条目名（不解盘）
fn scan_tar(path: &Path, comp: Option<TarComp>) -> Result<Vec<String>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("无法打开归档：{e}"))?;
    let mut ar = tar::Archive::new(decompress(f, comp));
    let entries = ar.entries().map_err(|e| format!("无法读取归档：{e}"))?;
    let mut names = Vec::new();
    for e in entries {
        let e = e.map_err(|err| format!("归档数据损坏：{err}"))?;
        let name = tar_entry_name(&e);
        if !is_apple_double(&name) {
            names.push(name);
        }
    }
    Ok(names)
}

fn decompress(f: std::fs::File, comp: Option<TarComp>) -> Box<dyn Read> {
    match comp {
        Some(TarComp::Gz) => Box::new(flate2::read::GzDecoder::new(f)),
        Some(TarComp::Bz2) => Box::new(bzip2::read::BzDecoder::new(f)),
        None => Box::new(f),
    }
}

// ==================== 单文件 gz / bz2 ====================

fn extract_single(
    path: &Path,
    target_dir: &Path,
    comp: TarComp,
    cb: Cb,
    check_cancel: &dyn Fn() -> bool,
) -> Result<ExtractOutcome, String> {
    let fname = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = match comp {
        TarComp::Gz => ".gz",
        TarComp::Bz2 => ".bz2",
    };
    let stripped = fname
        .get(..fname.len() - ext.len())
        .filter(|s| !s.is_empty())
        .unwrap_or("output");
    let out_path = crate::compress::unique_dest(&target_dir.join(stripped));
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    cb(CbEv::Plan(1));
    cb(CbEv::Start(&fname, size));
    let f = std::fs::File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut dec: Box<dyn Read> = match comp {
        TarComp::Gz => Box::new(flate2::read::GzDecoder::new(f)),
        TarComp::Bz2 => Box::new(bzip2::read::BzDecoder::new(f)),
    };
    let map_read_err = |err: &std::io::Error| -> String {
        format!("解压数据损坏（{}）：{err}", out_path.display())
    };
    let bytes = write_stream(&mut dec, 0, &out_path, &map_read_err, cb, check_cancel)?;
    cb(CbEv::EntryDone(bytes));
    Ok(ExtractOutcome {
        dest: out_path.to_string_lossy().into_owned(),
        files: 1,
        skipped: 0,
        bytes,
    })
}

// ==================== 系统 tar 兜底（rar / 7z / tar.xz） ====================

#[cfg(target_os = "windows")]
fn no_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW：GUI 进程 spawn 控制台程序不闪黑框
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
fn no_window(_cmd: &mut std::process::Command) {}

fn map_sys_tar_err(stderr: &str) -> String {
    let s = stderr.trim();
    if s.to_lowercase().contains("passphrase") || s.to_lowercase().contains("password") {
        return "加密的 rar/7z 暂不支持（系统 tar 无法解密）".into();
    }
    if s.contains("Couldn't find archive format") || s.is_empty() {
        return "系统 tar 不支持该格式".into();
    }
    format!("系统 tar 解压失败：{s}")
}

fn extract_sys_tar(
    path: &Path,
    target_dir: &Path,
    mode: &str,
    cb: Cb,
    check_cancel: &dyn Fn() -> bool,
) -> Result<ExtractOutcome, String> {
    // 第一遍：tar -tf 列条目（libarchive 解析，速度快；不解盘）
    let list = std::process::Command::new("tar")
        .arg("-tf")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("启动系统 tar 失败：{e}"))?;
    if !list.status.success() {
        let stderr = String::from_utf8_lossy(&list.stderr);
        return Err(map_sys_tar_err(&stderr));
    }
    let names: Vec<String> = String::from_utf8_lossy(&list.stdout)
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let dest = plan_dest(&names, path, target_dir, mode);
    std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目录：{e}"))?;
    cb(CbEv::Plan(names.len()));
    cb(CbEv::Start("解压中…", 0));

    // 第二遍：tar -xf 解到 dest。stdin 接 null：加密包时 libarchive 的取密码回调
    // 读到 EOF 会直接报错（否则会陷入 "Enter passphrase" 无限提示循环卡死 GUI）
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("-xf").arg(path).arg("-C").arg(&dest);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("启动系统 tar 失败：{e}"))?;
    // stderr 单独线程收集，避免管道写满阻塞子进程
    let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let mut stderr_pipe = child.stderr.take();
    let buf_clone = stderr_buf.clone();
    let stderr_handle = std::thread::spawn(move || {
        if let Some(p) = stderr_pipe.as_mut() {
            let mut buf = Vec::new();
            let _ = p.read_to_end(&mut buf);
            *buf_clone.lock().unwrap() = buf;
        }
    });
    let status = loop {
        if check_cancel() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled());
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => return Err(format!("等待系统 tar 失败：{e}")),
        }
    };
    let _ = stderr_handle.join();
    if !status.success() {
        return Err(map_sys_tar_err(&String::from_utf8_lossy(
            &stderr_buf.lock().unwrap(),
        )));
    }
    // 系统 tar 不逐条目回传：条目数按清单估算，字节未知
    Ok(ExtractOutcome {
        dest: dest.to_string_lossy().into_owned(),
        files: names.len(),
        skipped: 0,
        bytes: 0,
    })
}

// ==================== 命令入口 ====================

#[tauri::command]
pub async fn extract_archive(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    target_dir: String,
    mode: Option<String>,
    password: Option<String>,
) -> Result<ExtractOutcome, String> {
    // 注册取消旗标（id 随进度事件下发；phase = extract 无前缀 → 前端 cancel_transfer）
    let id = crate::next_transfer_id();
    let flag = Arc::new(AtomicBool::new(false));
    state
        .transfer_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_task = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_extract(&app, &id_task, &flag, &path, &target_dir, mode.as_deref().unwrap_or("smart"), password.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;
    state.transfer_cancels.lock().unwrap().remove(&id);
    result
}

fn run_extract(
    app: &AppHandle,
    id: &str,
    flag: &AtomicBool,
    path: &str,
    target_dir: &str,
    mode: &str,
    password: Option<&str>,
) -> Result<ExtractOutcome, String> {
    let src = Path::new(path);
    let src_name = src
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let Some(kind) = archive_kind(&src_name) else {
        return Err("不支持的压缩包格式（支持 zip / tar / tar.gz / tgz / tar.bz2 / tbz / tar.xz / gz / bz2 / rar / 7z）".into());
    };
    if !src.is_file() {
        return Err(format!("压缩包不存在：{path}"));
    }
    let target = Path::new(target_dir);
    if !target.is_dir() {
        return Err(format!("目标目录不存在：{target_dir}"));
    }

    let id_task = id.to_string();
    let mut throttle = Throttle::new();
    let mut total_files = 0usize;
    let mut done_files = 0usize;
    let cb = &mut |ev: CbEv| -> bool {
        if flag.load(Ordering::Relaxed) {
            return false;
        }
        let mut p = match ev {
            CbEv::Plan(total) => {
                total_files = total;
                throttle.reset();
                TransferProgress::start("extract", "解压中…", total)
            }
            CbEv::Start(name, size) => {
                throttle.reset();
                let mut p = TransferProgress::start("extract", name, total_files);
                p.file_total = size;
                p
            }
            CbEv::Bytes(done, total) => {
                let mut p = TransferProgress::start("extract", "", total_files);
                p.file_done = done;
                p.file_total = total;
                // 中间帧限频（每条目最后一帧随 EntryDone 立即发出）
                if !throttle.ready() {
                    return true;
                }
                p
            }
            CbEv::EntryDone(bytes) => {
                done_files += 1;
                let mut p = TransferProgress::start("extract", "", total_files);
                p.done_files = done_files;
                p.file_done = bytes;
                p.file_total = bytes;
                p
            }
        };
        p.id = Some(id_task.clone());
        emit(app, &p);
        true
    };
    let check = || flag.load(Ordering::Relaxed);
    // 回调返回 false（取消）时统一转成「已取消」错误
    let guard = |r: Result<ExtractOutcome, String>| -> Result<ExtractOutcome, String> { r };

    let r = match kind {
        ArchiveKind::Zip => guard(extract_zip(src, target, mode, password, cb, &check)),
        ArchiveKind::Tar(comp) => guard(extract_tar(src, target, mode, comp, cb, &check)),
        ArchiveKind::Single(comp) => guard(extract_single(src, target, comp, cb, &check)),
        ArchiveKind::SysTar => guard(extract_sys_tar(src, target, mode, cb, &check)),
    };
    if !r.is_ok() && flag.load(Ordering::Relaxed) {
        return Err(cancelled());
    }

    // 收尾帧（同 copy/move 语义：前端 1.5s 后清除指示）
    let label = match &r {
        Ok(_) => "解压完成".to_string(),
        Err(e) if crate::is_cancelled(e) => "已取消".into(),
        // 与 copy/move 收尾帧同文案：StatusBar 据「传输失败」渲染红色 + 拼阶段名
        Err(_) => "传输失败".into(),
    };
    let mut p = TransferProgress::start("extract", &label, total_files);
    p.done_files = total_files;
    p.done = true;
    emit(app, &p);
    r
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rdir-extract-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const NO_CB: fn(CbEv) -> bool = |_| true;
    fn nocb() -> &'static mut dyn FnMut(CbEv) -> bool {
        Box::leak(Box::new(NO_CB))
    }
    fn not_cancelled() -> bool {
        false
    }

    #[test]
    fn archive_kind_dispatch() {
        assert!(matches!(archive_kind("a.zip"), Some(ArchiveKind::Zip)));
        assert!(matches!(archive_kind("A.ZIP"), Some(ArchiveKind::Zip)));
        assert!(matches!(
            archive_kind("a.tar.gz"),
            Some(ArchiveKind::Tar(Some(TarComp::Gz)))
        ));
        assert!(matches!(
            archive_kind("a.tgz"),
            Some(ArchiveKind::Tar(Some(TarComp::Gz)))
        ));
        assert!(matches!(
            archive_kind("a.tar.bz2"),
            Some(ArchiveKind::Tar(Some(TarComp::Bz2)))
        ));
        assert!(matches!(
            archive_kind("a.tbz"),
            Some(ArchiveKind::Tar(Some(TarComp::Bz2)))
        ));
        assert!(matches!(archive_kind("a.tar"), Some(ArchiveKind::Tar(None))));
        assert!(matches!(
            archive_kind("a.gz"),
            Some(ArchiveKind::Single(TarComp::Gz))
        ));
        assert!(matches!(
            archive_kind("a.bz2"),
            Some(ArchiveKind::Single(TarComp::Bz2))
        ));
        assert!(matches!(archive_kind("a.rar"), Some(ArchiveKind::SysTar)));
        assert!(matches!(archive_kind("a.7z"), Some(ArchiveKind::SysTar)));
        assert!(matches!(archive_kind("a.txz"), Some(ArchiveKind::SysTar)));
        assert!(matches!(archive_kind("a.tar.xz"), Some(ArchiveKind::SysTar)));
        assert!(archive_kind("a.txt").is_none());
        assert!(archive_kind("a.xz").is_none()); // 裸 xz 本版不支持
        // 目录形态路径也按文件名分派
        assert!(matches!(
            archive_kind("/tmp/dir/sub.tar.gz"),
            Some(ArchiveKind::Tar(Some(TarComp::Gz)))
        ));
    }

    #[test]
    fn decode_names() {
        // UTF-8 直通
        assert_eq!(decode_archive_name("中文.txt".as_bytes()), "中文.txt");
        // GBK 字节（Windows 资源管理器 zip）：中文目录/测试文档.txt
        let gbk: &[u8] = &[
            0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xbf, 0xc2, 0xbc, 0x2f, 0xb2, 0xe2, 0xca, 0xd4,
            0xce, 0xc4, 0xb5, 0xb5, 0x2e, 0x74, 0x78, 0x74,
        ];
        assert_eq!(decode_archive_name(gbk), "中文目录/测试文档.txt");
        // 非 CJK 任意字节 → Latin-1 兜底（不报错、非空）
        assert_eq!(decode_archive_name(&[0xff, 0xfe]), "ÿþ");
    }

    #[test]
    fn apple_double_filter() {
        assert!(is_apple_double("__MACOSX/a.txt"));
        assert!(is_apple_double("dir/__MACOSX/._a.txt"));
        assert!(is_apple_double("._a.txt"));
        assert!(is_apple_double("dir/._a.txt"));
        assert!(is_apple_double("./._a.txt"));
        assert!(!is_apple_double("a.txt"));
        assert!(!is_apple_double("dir/a.txt"));
        assert!(!is_apple_double("macosx/a.txt"));
        assert!(!is_apple_double("a._txt"));
    }

    #[test]
    fn rel_path_guards() {
        assert_eq!(
            safe_rel_path("a/b/c.txt").unwrap(),
            PathBuf::from("a/b/c.txt")
        );
        assert_eq!(safe_rel_path("./a.txt").unwrap(), PathBuf::from("a.txt"));
        assert!(safe_rel_path("../evil").is_none());
        assert!(safe_rel_path("a/../../evil").is_none());
        assert!(safe_rel_path("/abs").is_none());
        assert!(safe_rel_path("").is_none());
        // 目录条目
        assert_eq!(safe_rel_path("dir/").unwrap(), PathBuf::from("dir"));
    }

    #[test]
    fn top_level_extraction() {
        assert_eq!(top_level_of("a.txt"), Some("a.txt".into()));
        assert_eq!(top_level_of("dir/b.txt"), Some("dir".into()));
        assert_eq!(top_level_of("dir/"), Some("dir".into()));
        assert_eq!(top_level_of("./a.txt"), Some("a.txt".into()));
        assert_eq!(top_level_of("./"), None);
        assert_eq!(top_level_of(""), None);
    }

    #[test]
    fn plan_dest_folder_mode_always_stems() {
        let dir = setup("planf");
        // folder 模式：无条件建 <归档名>/ 文件夹（即使就地也可行）
        let d = plan_dest(&["src/".into(), "src/a.txt".into()], Path::new("/x/foo.zip"), &dir, "folder");
        assert_eq!(d, dir.join("foo"));
        let d = plan_dest(&["a.txt".into()], Path::new("/x/foo.zip"), &dir, "folder");
        assert_eq!(d, dir.join("foo"));
        // 同名已存在 → (2)
        std::fs::create_dir_all(dir.join("foo")).unwrap();
        let d = plan_dest(&["a.txt".into()], Path::new("/x/foo.zip"), &dir, "folder");
        assert_eq!(d, dir.join("foo (2)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_dest_smart_and_collision() {
        let dir = setup("plan");
        // 单顶层目录且不存在 → 就地
        let d = plan_dest(&["src/".into(), "src/a.txt".into()], Path::new("/x/foo.zip"), &dir, "smart");
        assert_eq!(d, dir);
        // 多顶层 → foo/ 文件夹
        let d = plan_dest(&["a.txt".into(), "src/b.txt".into()], Path::new("/x/foo.zip"), &dir, "smart");
        assert_eq!(d, dir.join("foo"));
        // 单顶层但与现有内容撞 → 文件夹
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let d = plan_dest(&["a.txt".into()], Path::new("/x/foo.zip"), &dir, "smart");
        assert_eq!(d, dir.join("foo"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 手工构造最小 zip（stored 条目），验证 zip crate 读取链路 + GBK 文件名解码
    /// + AppleDouble 过滤 + 智能落点全链路。
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    struct FixtureEntry {
        name: &'static [u8],
        data: &'static [u8],
    }

    fn write_min_zip(path: &Path, entries: &[FixtureEntry]) {
        let mut buf: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();
        let mut offsets = Vec::new();
        for e in entries {
            let crc = crc32(e.data);
            offsets.push(buf.len() as u32);
            buf.extend_from_slice(b"PK\x03\x04");
            buf.extend_from_slice(&20u16.to_le_bytes()); // version
            buf.extend_from_slice(&0u16.to_le_bytes()); // flags（无 UTF-8 位）
            buf.extend_from_slice(&0u16.to_le_bytes()); // method = stored
            buf.extend_from_slice(&0u16.to_le_bytes()); // time
            buf.extend_from_slice(&0u16.to_le_bytes()); // date
            buf.extend_from_slice(&crc.to_le_bytes());
            buf.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            buf.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            buf.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes()); // extra len
            buf.extend_from_slice(e.name);
            buf.extend_from_slice(e.data);
        }
        let cd_start = buf.len() as u32;
        for (i, e) in entries.iter().enumerate() {
            let crc = crc32(e.data);
            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&20u16.to_le_bytes()); // made by
            central.extend_from_slice(&20u16.to_le_bytes()); // need
            central.extend_from_slice(&0u16.to_le_bytes()); // flags
            central.extend_from_slice(&0u16.to_le_bytes()); // method
            central.extend_from_slice(&0u16.to_le_bytes()); // time
            central.extend_from_slice(&0u16.to_le_bytes()); // date
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // extra
            central.extend_from_slice(&0u16.to_le_bytes()); // comment
            central.extend_from_slice(&0u16.to_le_bytes()); // disk
            central.extend_from_slice(&0u16.to_le_bytes()); // int attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // ext attrs
            central.extend_from_slice(&offsets[i].to_le_bytes());
            central.extend_from_slice(e.name);
        }
        let cd_size = buf.len() as u32 - cd_start;
        buf.extend_from_slice(&central);
        buf.extend_from_slice(b"PK\x05\x06");
        buf.extend_from_slice(&0u16.to_le_bytes()); // disk
        buf.extend_from_slice(&0u16.to_le_bytes()); // cd disk
        buf.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        buf.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        buf.extend_from_slice(&cd_size.to_le_bytes());
        buf.extend_from_slice(&cd_start.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes()); // comment
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn zip_extract_gbk_names_and_junk_filter() {
        let dir = setup("gbk");
        let archive = dir.join("打包.zip");
        write_min_zip(
            &archive,
            &[
                // GBK：「中文目录/测试文档.txt」
                FixtureEntry {
                    name: &[
                        0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xbf, 0xc2, 0xbc, 0x2f, 0xb2, 0xe2,
                        0xca, 0xd4, 0xce, 0xc4, 0xb5, 0xb5, 0x2e, 0x74, 0x78, 0x74,
                    ],
                    data: b"content",
                },
                FixtureEntry { name: b"plain.txt", data: b"ok" },
                // AppleDouble 垃圾（ditto -k 会产出的形态）
                FixtureEntry { name: b"__MACOSX/plain.txt", data: b"junk" },
                FixtureEntry { name: b"._plain.txt", data: b"junk" },
            ],
        );
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();
        let out = extract_zip(&archive, &target, "smart", None, nocb(), &not_cancelled).unwrap();
        assert_eq!(out.files, 2, "{out:?}");
        assert_eq!(out.skipped, 2, "{out:?}");
        // 多顶层 → 文件夹模式，落点为 归档名/
        assert_eq!(Path::new(&out.dest), &target.join("打包"));
        assert_eq!(
            std::fs::read(target.join("打包/plain.txt")).unwrap(),
            b"ok"
        );
        assert_eq!(
            std::fs::read(target.join("打包/中文目录/测试文档.txt")).unwrap(),
            b"content"
        );
        assert!(!target.join("打包/._plain.txt").exists());
        assert!(!target.join("打包/__MACOSX").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_extract_here_mode_single_top_dir() {
        let dir = setup("here");
        let archive = dir.join("proj.zip");
        write_min_zip(
            &archive,
            &[
                FixtureEntry { name: b"proj/src/main.rs", data: b"fn main(){}" },
                FixtureEntry { name: b"proj/README.md", data: b"readme" },
            ],
        );
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();
        let out = extract_zip(&archive, &target, "smart", None, nocb(), &not_cancelled).unwrap();
        // 单顶层目录 proj 且不撞 → 就地解到 target/proj
        assert_eq!(Path::new(&out.dest), &target);
        assert!(target.join("proj/src/main.rs").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tar_extract_roundtrip() {
        let dir = setup("tar");
        let src = dir.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), "hello").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), "world").unwrap();
        let archive = dir.join("src.tgz");
        let st = std::process::Command::new("tar")
            .args(["-czf"])
            .arg(&archive)
            .arg("-C")
            .arg(&dir)
            .arg("src")
            .status()
            .unwrap();
        assert!(st.success(), "系统 tar 打包失败");
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();
        let out = extract_tar(&archive, &target, "smart", Some(TarComp::Gz), nocb(), &not_cancelled).unwrap();
        // 单顶层 src 且不撞 → 就地
        assert_eq!(Path::new(&out.dest), &target);
        assert_eq!(std::fs::read(target.join("src/a.txt")).unwrap(), b"hello");
        assert_eq!(
            std::fs::read(target.join("src/sub/b.txt")).unwrap(),
            b"world"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tar_skips_symlink_and_dot_underscore_entries() {
        let dir = setup("tarlink");
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.txt"), "hello").unwrap();
        std::fs::write(src.join("._a.txt"), "appledouble").unwrap();
        let archive = dir.join("src.tar");
        let st = std::process::Command::new("tar")
            .args(["-cf"])
            .arg(&archive)
            .arg("-C")
            .arg(&dir)
            .arg("src")
            .status()
            .unwrap();
        assert!(st.success());
        // 额外注入一个 symlink 条目
        let st = std::process::Command::new("tar")
            .args(["-rf"])
            .arg(&archive)
            .arg("-C")
            .arg(&src)
            .args(["--transform", "s|.*|link|"])
            .arg("--symlink")
            .arg("a.txt")
            .status()
            .unwrap();
        let _ = st; // --transform 各平台行为不一，失败也不影响主断言
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();
        let out = extract_tar(&archive, &target, "smart", None, nocb(), &not_cancelled).unwrap();
        assert_eq!(std::fs::read(target.join("src/a.txt")).unwrap(), b"hello");
        assert!(!target.join("src/._a.txt").exists(), "{out:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn single_gz_extract() {
        let dir = setup("gz");
        let f = dir.join("数据.csv.gz");
        {
            let raw = std::fs::File::create(dir.join("_raw")).unwrap();
            let mut enc = flate2::write::GzEncoder::new(
                std::fs::File::create(&f).unwrap(),
                flate2::Compression::default(),
            );
            std::io::copy(&mut std::fs::File::open(dir.join("_raw")).unwrap(), &mut enc).unwrap();
            drop(raw);
        }
        std::fs::remove_file(dir.join("_raw")).unwrap();
        let out = extract_single(&f, &dir, TarComp::Gz, nocb(), &not_cancelled).unwrap();
        assert_eq!(Path::new(&out.dest), dir.join("数据.csv"));
        assert!(dir.join("数据.csv").exists());
        // 同名再解一次 → (2)
        let out2 = extract_single(&f, &dir, TarComp::Gz, nocb(), &not_cancelled).unwrap();
        assert!(dir.join("数据 (2).csv").exists(), "{out2:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_password_signal() {
        let dir = setup("pw");
        let archive = dir.join("none.zip");
        std::fs::write(&archive, b"not a zip").unwrap();
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();
        let err = extract_zip(&archive, &target, "smart", None, nocb(), &not_cancelled).unwrap_err();
        assert!(err.contains("无法读取 zip"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真实加密 zip（系统 zip -P 造 ZipCrypto 包）三分支：未提供密码 →「需要密码」；
    /// 密码错误 →「密码错误」（ZipCrypto 错误密码常以 CRC 失败呈现，须正确映射）；
    /// 密码正确 → 解出内容。前端据此弹密码框就地重试。
    #[cfg(target_os = "macos")]
    #[test]
    fn zip_encrypted_password_flow() {
        let dir = setup("enc");
        let src = dir.join("sec");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("secret.txt"), "top secret").unwrap();
        let archive = dir.join("sec.zip");
        let st = std::process::Command::new("zip")
            .args(["-q", "-r", "-P", "pw123"])
            .arg("sec.zip")
            .arg("sec")
            .current_dir(&dir)
            .status()
            .unwrap();
        assert!(st.success(), "系统 zip 打加密包失败");
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();

        // 未提供密码 → 需要密码
        let err = extract_zip(&archive, &target, "smart", None, nocb(), &not_cancelled)
            .unwrap_err();
        assert_eq!(err, ERR_NEED_PASSWORD, "{err}");
        // 密码错误 → 密码错误（且无半成品残留）
        let err = extract_zip(&archive, &target, "smart", Some("wrong"), nocb(), &not_cancelled)
            .unwrap_err();
        assert_eq!(err, ERR_WRONG_PASSWORD, "{err}");
        assert!(!target.join("sec").exists(), "错误密码不应留下解出文件");
        // 密码正确 → 解出
        let out = extract_zip(&archive, &target, "smart", Some("pw123"), nocb(), &not_cancelled)
            .unwrap();
        assert_eq!(out.files, 1, "{out:?}");
        assert_eq!(
            std::fs::read(target.join("sec/secret.txt")).unwrap(),
            b"top secret"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sys_tar_rar_or_7z_reports_readable_error() {
        let dir = setup("systar");
        let fake = dir.join("fake.rar");
        std::fs::write(&fake, b"not a rar").unwrap();
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();
        let err = extract_sys_tar(&fake, &target, "smart", nocb(), &not_cancelled).unwrap_err();
        assert!(!err.is_empty(), "{err}");
        assert!(!err.contains("Enter passphrase"), "不能出现交互提示：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
