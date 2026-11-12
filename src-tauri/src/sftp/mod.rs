//! SFTP 内置插件（feature = "sftp"）：路径解析、连接管理、只读浏览与文件操作。
//! 虚拟路径格式：sftp://user@host[:port]/remote/absolute/path
//! 无端口默认 22；仅 sftp://user@host 时进入默认目录（家目录）。

pub mod pool;
pub mod proto;
pub mod servers;
pub mod session;

pub use session::RELAY_WINDOW;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::fs_ops::FileEntry;
use pool::SessionPool;
use session::{AuthMethod, ServerConfig, SftpSession};

/// 解析 sftp:// 虚拟路径 → (authority, 远程绝对路径)
pub fn parse_sftp_path(path: &str) -> Result<(String, String), String> {
    let rest = path
        .strip_prefix("sftp://")
        .ok_or_else(|| format!("不是 sftp 路径：{path}"))?;
    let (authority, remote) = match rest.split_once('/') {
        Some((a, r)) => (a.to_string(), format!("/{r}")),
        None => (rest.to_string(), "/".to_string()),
    };
    if authority.is_empty() {
        return Err("sftp 路径缺少主机信息".into());
    }
    Ok((authority, remote))
}

/// 解析 authority（user@host:port）→ (user, host, port)
pub fn parse_authority(authority: &str) -> Result<(String, String, u16), String> {
    let (user, hostport) = match authority.split_once('@') {
        Some((u, hp)) => (u.to_string(), hp),
        None => return Err("sftp 路径缺少用户名（应为 sftp://user@host）".into()),
    };
    if user.is_empty() || hostport.is_empty() {
        return Err("sftp 路径格式错误：sftp://user@host".into());
    }
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) if port != 0 => (h.to_string(), port),
            _ => (hostport.to_string(), 22),
        },
        None => (hostport.to_string(), 22),
    };
    if host.is_empty() {
        return Err("sftp 主机为空".into());
    }
    Ok((user, host, port))
}

/// 会话池 key
pub fn pool_key(user: &str, host: &str, port: u16) -> String {
    format!("{user}@{host}:{port}")
}

/// sftp:// 路径 → 主机名（远程临时目录按服务器分类 `sftp/<host>/` 用）
pub fn host_of(path: &str) -> Result<String, String> {
    let (authority, _remote) = parse_sftp_path(path)?;
    parse_authority(&authority).map(|(_user, host, _port)| host)
}

/// 连接配置 → ServerConfig（供 SftpSession::connect）
pub fn to_server_config(
    user: &str,
    host: &str,
    port: u16,
    root: Option<String>,
    auth: &servers::AuthConfig,
) -> ServerConfig {
    let (auth_method, save_secret) = match auth {
        servers::AuthConfig::Password { password, save_password } => {
            (AuthMethod::Password(password.clone()), *save_password)
        }
        servers::AuthConfig::PublicKey { key_path, passphrase, save_passphrase } => (
            AuthMethod::PublicKey {
                key_path: key_path.clone(),
                passphrase: passphrase.clone(),
            },
            *save_passphrase,
        ),
    };
    ServerConfig {
        name: format!("{user}@{host}:{port}"),
        host: host.to_string(),
        port,
        user: user.to_string(),
        auth: auth_method,
        root,
        save_secret,
    }
}

/// 连接并放入池；返回服务器视图
pub async fn connect_and_store(
    pool: &mut SessionPool,
    cfg: &ServerConfig,
) -> Result<(), String> {
    let key = pool_key(&cfg.user, &cfg.host, cfg.port);
    if pool.get(&key).is_some() {
        return Ok(()); // 已连接
    }
    let session = SftpSession::connect(cfg).await?;
    pool.put(&key, session);
    Ok(())
}

/// 获取会话（未连接则报错）
pub async fn get_session(
    pool: &SessionPool,
    key: &str,
) -> Result<Arc<Mutex<SftpSession>>, String> {
    pool.get(key)
        .ok_or_else(|| "未连接到该服务器，请在地址栏输入 sftp://user@host 进行连接".to_string())
}

/// 远程条目 → 前端 FileEntry（path 为可继续导航的完整 sftp:// URL）
fn to_entry(authority: &str, name: &str, remote_dir: &str, a: &proto::SftpAttrs) -> FileEntry {
    let remote = join_remote(remote_dir, name);
    let path = format!("sftp://{authority}{remote}");
    let mtime = a.mtime.map(|s| s * 1000);
    let extension = Path::new(name)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    FileEntry {
        name: name.to_string(),
        path,
        is_dir: a.is_dir,
        is_symlink: a.is_symlink,
        size: a.size,
        modified: mtime,
        created: None,
        permissions: a.perm_string(),
        extension,
    }
}

/// 拼接远程路径（避免双斜杠）
pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 列目录（路由入口）
pub async fn list_dir(pool: &SessionPool, path: &str) -> Result<Vec<FileEntry>, String> {
    let (authority, remote) = parse_sftp_path(path)?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    let entries = g.list_dir(&remote).await?;
    let mut out: Vec<FileEntry> = entries
        .into_iter()
        .map(|(name, a)| to_entry(&authority, &name, &remote, &a))
        .collect();
    // 目录优先 + 名称排序（对齐本地）
    out.sort_by(|x, y| {
        y.is_dir
            .cmp(&x.is_dir)
            .then_with(|| x.name.to_lowercase().cmp(&y.name.to_lowercase()))
    });
    Ok(out)
}

/// stat（路由入口）→ "dir" / "file" / "symlink"
pub async fn stat_path(pool: &SessionPool, path: &str) -> Result<String, String> {
    let (_authority, remote) = parse_sftp_path(path)?;
    let (user, host, port) = parse_authority(&parse_sftp_path(path)?.0)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    let a = g.stat(&remote).await?;
    if a.is_dir {
        Ok("dir".into())
    } else if a.is_symlink {
        Ok("symlink".into())
    } else {
        Ok("file".into())
    }
}

/// 下载远程文件到临时目录，返回本地路径（供 opener 打开）
pub async fn download(
    pool: &SessionPool,
    path: &str,
    temp_dir: &Path,
    mut cb: impl FnMut(u64, u64),
) -> Result<String, String> {
    let (authority, remote) = parse_sftp_path(path)?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let name = Path::new(&remote)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    // 临时目录：<生效临时目录>/<sanitized 文件名>；目录可能尚不存在
    //（首次打开 / 刚被清理）——先建再写，否则 File::create 报 os error 3
    let mut dest: PathBuf = temp_dir.to_path_buf();
    let safe = sanitize_name(&name);
    dest.push(safe);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建临时目录失败：{e}"))?;
    }
    let mut g = sess.lock().await;
    // 单文件打开场景无取消：字节回调恒放行
    let _bytes = g.download(&remote, &dest, &mut |done, total| {
        cb(done, total);
        true
    })
    .await?;
    Ok(dest.to_string_lossy().to_string())
}

// ==================== v0.23 递归传输（文件夹上传/下载） ====================

/// 递归传输计划（两阶段进度的分母：先统计再传）
#[derive(Debug, Clone, Copy, Default)]
pub struct TransferPlan {
    /// 待传文件数（目录不计）
    pub files: usize,
    /// 待传总字节
    pub bytes: u64,
}

/// 递归传输回调事件（对齐本地复制的 ops::CbEvent）
pub enum XferEvent {
    /// 开始传输一个文件（label：自顶层条目起的相对路径，展示用）
    Start(String),
    /// 当前文件字节进度
    Bytes(u64, u64),
    /// 单个文件完成
    EntryDone,
}

/// 递归传输回调：返回 false = 取消整个传输
pub type XferCb<'a> = &'a mut (dyn FnMut(XferEvent) -> bool + Send + 'a);

/// 统计本地路径（文件或目录树）的文件数与总字节（上传进度分母）。
/// 纯本地遍历、无 IO 外依赖；不可读条目跳过（仅影响分母精度，不阻塞传输）。
pub fn upload_plan(local: &str) -> Result<TransferPlan, String> {
    let root = Path::new(local);
    let meta = std::fs::metadata(root).map_err(|e| format!("读取本地失败：{e}"))?;
    let mut plan = TransferPlan::default();
    if meta.is_dir() {
        plan_local_walk(root, &mut plan);
    } else {
        plan.files = 1;
        plan.bytes = meta.len();
    }
    Ok(plan)
}

fn plan_local_walk(dir: &Path, plan: &mut TransferPlan) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        // metadata() 跟随软链：软链目录按目录递归、软链文件按文件计数
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            plan_local_walk(&e.path(), plan);
        } else if meta.is_file() {
            plan.files += 1;
            plan.bytes += meta.len();
        }
    }
}

/// 遍历远程树统计文件数与总字节（下载进度分母）。
/// cancelled 置位时中止统计（远程大目录遍历可能耗时多个 RTT）。
pub async fn download_plan(
    pool: &SessionPool,
    path: &str,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<TransferPlan, String> {
    let (authority, remote) = parse_sftp_path(path)?;
    let (user, host, port) = parse_authority(&authority)?;
    let sess = get_session(pool, &pool_key(&user, &host, port)).await?;
    let mut g = sess.lock().await;
    let a = g.stat(&remote).await?;
    let mut plan = TransferPlan::default();
    if a.is_dir {
        plan_remote_boxed(&mut g, &remote, &mut plan, cancelled).await?;
    } else {
        plan.files = 1;
        plan.bytes = a.size;
    }
    Ok(plan)
}

fn plan_remote_boxed<'a>(
    g: &'a mut session::SftpSession,
    remote: &'a str,
    plan: &'a mut TransferPlan,
    cancelled: &'a std::sync::atomic::AtomicBool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    use std::sync::atomic::Ordering;
    Box::pin(async move {
        let entries = g.list_dir(remote).await?;
        for (name, attrs) in entries {
            if cancelled.load(Ordering::Relaxed) {
                return Err(crate::ERR_CANCELLED.into());
            }
            if attrs.is_dir {
                let child = join_remote(remote, &name);
                plan_remote_boxed(g, &child, plan, cancelled).await?;
            } else {
                plan.files += 1;
                plan.bytes += attrs.size;
            }
        }
        Ok(())
    })
}

/// 远程建目录；已存在且是目录则并入（mkdir 对已存在路径报错，属预期）
async fn ensure_remote_dir(g: &mut session::SftpSession, remote: &str) -> Result<(), String> {
    match g.mkdir(remote).await {
        Ok(()) => Ok(()),
        Err(e) => match g.stat(remote).await {
            Ok(a) if a.is_dir => Ok(()),
            _ => Err(e),
        },
    }
}

/// 上传本地路径（文件或目录）到远程目录下，返回远程完整 URL。
/// 目录递归：远程逐级 mkdir（已存在并入）、本地逐级遍历；空目录也会在远端创建。
/// 顶层名冲突语义由调用方决定（拖拽先经覆盖确认、粘贴沿用既有静默覆盖）。
pub async fn upload_path(
    pool: &SessionPool,
    local: &str,
    remote_dir: &str,
    name: &str,
    cb: XferCb<'_>,
) -> Result<String, String> {
    let (authority, rdir) = parse_sftp_path(remote_dir)?;
    let (user, host, port) = parse_authority(&authority)?;
    let sess = get_session(pool, &pool_key(&user, &host, port)).await?;
    let src = Path::new(local);
    let meta = std::fs::metadata(src).map_err(|e| format!("读取本地失败：{e}"))?;
    let mut g = sess.lock().await;
    let remote = join_remote(&rdir, name);
    if meta.is_dir() {
        ensure_remote_dir(&mut g, &remote).await?;
        upload_dir_boxed(&mut g, src, &remote, src, cb).await?;
    } else {
        if !cb(XferEvent::Start(name.to_string())) {
            return Err(crate::ERR_CANCELLED.into());
        }
        let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
        g.upload(src, &remote, &mut fcb).await?;
        if !cb(XferEvent::EntryDone) {
            return Err(crate::ERR_CANCELLED.into());
        }
    }
    Ok(format!("sftp://{authority}{remote}"))
}

/// 递归上传目录内容到已存在的远程目录（remote 必须已由调用方建好）
fn upload_dir_boxed<'a>(
    g: &'a mut session::SftpSession,
    dir: &'a Path,
    remote: &'a str,
    top: &'a Path,
    cb: XferCb<'a>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let rd = std::fs::read_dir(dir).map_err(|e| format!("读取本地失败：{e}"))?;
        for entry in rd {
            let entry = entry.map_err(|e| format!("读取本地失败：{e}"))?;
            let child = entry.path();
            // metadata() 跟随软链：软链文件按文件上传、软链目录按目录递归
            let meta = entry.metadata().map_err(|e| format!("读取本地失败：{e}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let remote_child = join_remote(remote, &name);
            if meta.is_dir() {
                ensure_remote_dir(g, &remote_child).await?;
                upload_dir_boxed(g, &child, &remote_child, top, &mut *cb).await?;
            } else if meta.is_file() {
                let rel = child
                    .strip_prefix(top)
                    .unwrap_or(&child)
                    .to_string_lossy()
                    .to_string();
                if !cb(XferEvent::Start(rel)) {
                    return Err(crate::ERR_CANCELLED.into());
                }
                let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
                g.upload(&child, &remote_child, &mut fcb).await?;
                if !cb(XferEvent::EntryDone) {
                    return Err(crate::ERR_CANCELLED.into());
                }
            }
            // 其余类型（套接字等非常规条目）跳过
        }
        Ok(())
    })
}

/// 顶层落盘文件名策略（v0.44.0）：
/// - `Sanitized`：各平台安全的保守名（空格/括号/中文标点等 → `_`），
///   粘贴/拖拽 远程→本地 的既有行为，磁盘布局历史可预期。
/// - `Preserve`：仅替换本地文件系统存不下的字符（[`crate::remote_temp::local_safe_name`]），
///   名称尽量原样落盘——SFTP↔SFTP 中转的上传回程要保持源文件名（含子文件）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NameMode {
    Sanitized,
    Preserve,
}

/// 下载远程路径（文件或目录）到指定本地目录（粘贴/拖拽 远程→本地）。
/// overwrite=false：顶层同名自动加 " (n)" 后缀（粘贴的既有行为）；
/// overwrite=true：直接覆盖同名文件/并入同名目录（拖拽经用户覆盖确认后使用，v0.22.0）。
/// 目录递归：本地逐级 create_dir_all、远程逐级 list_dir；空目录也会在本地创建。
/// 返回本地落点路径。
pub async fn download_to(
    pool: &SessionPool,
    local_dir: &str,
    path: &str,
    overwrite: bool,
    cb: XferCb<'_>,
) -> Result<String, String> {
    download_to_named(
        pool,
        local_dir,
        path,
        overwrite,
        NameMode::Sanitized,
        cb,
    )
    .await
}

/// [`download_to`] 的文件名策略版（v0.44.0 SFTP↔SFTP 中转用 Preserve 模式）
pub async fn download_to_named(
    pool: &SessionPool,
    local_dir: &str,
    path: &str,
    overwrite: bool,
    mode: NameMode,
    cb: XferCb<'_>,
) -> Result<String, String> {
    let (authority, remote) = parse_sftp_path(path)?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let name = Path::new(&remote)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let top = match mode {
        NameMode::Sanitized => sanitize_name(&name),
        NameMode::Preserve => crate::remote_temp::local_safe_name(&name),
    };
    let mut dest = PathBuf::from(local_dir).join(&top);
    // 顶层同名冲突：追加 " (1)"、" (2)"…（overwrite 时直接覆盖/并入）
    let mut n = 1;
    while dest.exists() && !overwrite {
        dest = PathBuf::from(local_dir).join(format!("{} ({})", top, n));
        n += 1;
    }
    let mut g = sess.lock().await;
    let a = g.stat(&remote).await?;
    if a.is_dir {
        std::fs::create_dir_all(&dest).map_err(|e| format!("创建本地目录失败：{e}"))?;
        download_dir_boxed(&mut g, &remote, &dest, mode, cb).await?;
    } else {
        if !cb(XferEvent::Start(name)) {
            return Err(crate::ERR_CANCELLED.into());
        }
        let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
        g.download(&remote, &dest, &mut fcb).await?;
        if !cb(XferEvent::EntryDone) {
            return Err(crate::ERR_CANCELLED.into());
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 递归下载远程目录到已存在的本地目录（dest 必须已由调用方建好）。
/// 名称按 mode：Sanitized=保守清洗（粘贴/拖拽既有行为）；Preserve=仅替换本地
/// 非法字符（中转场景，上传回程保持源文件名——远端名含 Windows 保留字符时，
/// Windows 本地暂存仍会被改写，属本地暂存的固有限制）。
fn download_dir_boxed<'a>(
    g: &'a mut session::SftpSession,
    remote: &'a str,
    dest: &'a Path,
    mode: NameMode,
    cb: XferCb<'a>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let entries = g.list_dir(remote).await?;
        for (name, attrs) in entries {
            let safe = match mode {
                NameMode::Sanitized => sanitize_name(&name),
                NameMode::Preserve => crate::remote_temp::local_safe_name(&name),
            };
            let dest_child = dest.join(&safe);
            let remote_child = join_remote(remote, &name);
            if attrs.is_dir {
                std::fs::create_dir_all(&dest_child)
                    .map_err(|e| format!("创建本地目录失败：{e}"))?;
                download_dir_boxed(g, &remote_child, &dest_child, mode, &mut *cb).await?;
            } else {
                if !cb(XferEvent::Start(name)) {
                    return Err(crate::ERR_CANCELLED.into());
                }
                let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
                g.download(&remote_child, &dest_child, &mut fcb).await?;
                if !cb(XferEvent::EntryDone) {
                    return Err(crate::ERR_CANCELLED.into());
                }
            }
        }
        Ok(())
    })
}

/// 远程新建目录。撞名产出 EXISTS 码（与本地新建同契约；前端自动顺延编号重试）
pub async fn mkdir(pool: &SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let (authority, rdir) = parse_sftp_path(remote_dir)?;
    let remote = join_remote(&rdir, name);
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    if g.stat(&remote).await.is_ok() {
        return Err(format!("EXISTS|同名条目已存在：{name}"));
    }
    g.mkdir(&remote).await?;
    Ok(format!("sftp://{authority}{remote}"))
}

/// 远程新建空文件。撞名产出 EXISTS 码（同 mkdir）
pub async fn create_file(pool: &SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let (authority, rdir) = parse_sftp_path(remote_dir)?;
    let remote = join_remote(&rdir, name);
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    if g.stat(&remote).await.is_ok() {
        return Err(format!("EXISTS|同名文件已存在：{name}"));
    }
    g.touch(&remote).await?;
    Ok(format!("sftp://{authority}{remote}"))
}

/// 远程删除：目录（rmdir，仅空）或文件（remove）
pub async fn delete_entries(pool: &SessionPool, paths: &[String]) -> Result<(), String> {
    let (authority, _) = parse_sftp_path(&paths[0])?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    for p in paths {
        let (_, r) = parse_sftp_path(p)?;
        let a = g.stat(&r).await?;
        if a.is_dir {
            g.remove_recursive(&r).await?;
        } else {
            g.remove(&r).await?;
        }
    }
    Ok(())
}

/// 远程重命名/移动
pub async fn rename_entry(pool: &SessionPool, old_path: &str, new_name: &str) -> Result<String, String> {
    let (authority, old_remote) = parse_sftp_path(old_path)?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let parent = Path::new(&old_remote)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string());
    let new_remote = join_remote(&parent, new_name);
    let mut g = sess.lock().await;
    g.rename(&old_remote, &new_remote).await?;
    Ok(format!("sftp://{authority}{new_remote}"))
}

/// 远程移动（剪切粘贴到同一台服务器）：src 移动到 dest_dir/name。同一会话内
/// 一次 `rename_over`（posix-rename@openssh.com）完成——目标存在 = 原子覆盖
/// 替换，不存在 = 纯移动；不支持该扩展的服务器在 session 层内部回退
/// 「删目标 + 普通 rename」。不经临时目录中转（中转见 sftp_relay_staged）。
/// 源与目标必须同服务器（pool_key 归一比较，端口缺省与显式 22 视为同一台）。
pub async fn move_entry(pool: &SessionPool, src: &str, dest_dir: &str, name: &str) -> Result<String, String> {
    let (src_authority, src_remote) = parse_sftp_path(src)?;
    let (src_user, src_host, src_port) = parse_authority(&src_authority)?;
    let src_key = pool_key(&src_user, &src_host, src_port);
    let (dst_authority, dst_dir_remote) = parse_sftp_path(dest_dir)?;
    let (dst_user, dst_host, dst_port) = parse_authority(&dst_authority)?;
    let dst_key = pool_key(&dst_user, &dst_host, dst_port);
    if src_key != dst_key {
        return Err("跨服务器移动不支持：请用复制粘贴走中转".into());
    }
    let sess = get_session(pool, &src_key).await?;
    let new_remote = join_remote(&dst_dir_remote, name);
    let mut g = sess.lock().await;
    g.rename_over(&src_remote, &new_remote).await?;
    Ok(format!("sftp://{dst_authority}{new_remote}"))
}

fn sanitize_name(name: &str) -> String {
    let mut s = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
            s.push(c);
        } else {
            s.push('_');
        }
    }
    if s.is_empty() {
        s = "download".into();
    }
    s
}

/// 服务器清单视图（前端展示用）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub root: Option<String>,
    /// 连接后默认进入的远程绝对路径（配置 root 优先，否则会话 home）
    pub default_remote: String,
    pub group: String,
    pub auth: String,
    /// 私钥路径（PublicKey 且非空才有值；路径非凭据，明文下发供编辑回填）
    pub key_path: Option<String>,
    /// 密码/口令已保存
    pub has_secret: bool,
    pub connected: bool,
}

/// 规范化远程目录：确保以 "/" 开头
pub fn normalize_remote(r: &str) -> String {
    if r.starts_with('/') {
        r.to_string()
    } else {
        format!("/{r}")
    }
}

/// 默认远程目录：会话 home（未连接时返回 "/"）
fn session_home(pool: &SessionPool, key: &str) -> String {
    match pool.get(key) {
        Some(s) => s
            .try_lock()
            .map(|g| if g.home.is_empty() { "/".to_string() } else { g.home.clone() })
            .unwrap_or_else(|_| "/".to_string()),
        None => "/".to_string(),
    }
}

/// 计算默认远程路径：root 非空 → root；否则 → 会话 home
pub fn default_remote_for(cfg: &servers::ServerConfigFile, pool: &SessionPool) -> String {
    let key = pool_key(&cfg.user, &cfg.host, cfg.port);
    match cfg.root.as_deref() {
        Some(r) if !r.is_empty() => normalize_remote(r),
        _ => session_home(pool, &key),
    }
}

pub fn to_view(cfg: &servers::ServerConfigFile, pool: &SessionPool) -> ServerView {
    let key = pool_key(&cfg.user, &cfg.host, cfg.port);
    let (auth, has_secret) = match &cfg.auth {
        servers::AuthConfig::Password { password, save_password } => {
            ("password".to_string(), *save_password && !password.is_empty())
        }
        servers::AuthConfig::PublicKey { passphrase, save_passphrase, .. } => (
            "key".to_string(),
            *save_passphrase && passphrase.as_deref().unwrap_or("").is_empty() == false,
        ),
    };
    let key_path = match &cfg.auth {
        servers::AuthConfig::PublicKey { key_path, .. } if !key_path.is_empty() => {
            Some(key_path.clone())
        }
        _ => None,
    };
    ServerView {
        id: cfg.id.clone(),
        name: cfg.name.clone(),
        host: cfg.host.clone(),
        port: cfg.port,
        user: cfg.user.clone(),
        root: cfg.root.clone(),
        default_remote: default_remote_for(cfg, pool),
        group: cfg.group.clone(),
        auth,
        key_path,
        has_secret,
        connected: pool.get(&key).is_some(),
    }
}

/// master-key 状态（前端启动时查询）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MasterKeyStatus {
    /// 是否已设置过 master-key（servers.json 里有校验值）
    pub configured: bool,
    /// 当前内存中是否有 master-key（本次会话已输入过）
    pub active: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_plan_single_file() {
        let dir = std::env::temp_dir().join("rdir-test-plan-single");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        std::fs::write(&f, "hello").unwrap();
        let plan = upload_plan(f.to_str().unwrap()).unwrap();
        assert_eq!(plan.files, 1);
        assert_eq!(plan.bytes, 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upload_plan_counts_nested_tree_and_skips_unreadable() {
        let root = std::env::temp_dir().join("rdir-test-plan-tree");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        std::fs::write(root.join("top.txt"), "12345").unwrap(); // 5B
        std::fs::write(root.join("sub/b.bin"), [0u8; 10]).unwrap(); // 10B
        std::fs::write(root.join("sub/deep/c.txt"), "xyz").unwrap(); // 3B
        // 空目录不计数
        std::fs::create_dir_all(root.join("empty")).unwrap();
        let plan = upload_plan(root.to_str().unwrap()).unwrap();
        assert_eq!(plan.files, 3);
        assert_eq!(plan.bytes, 18);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn upload_plan_rejects_missing_path() {
        assert!(upload_plan("/nonexistent/rdir/definitely-missing").is_err());
    }

    /// v0.44.0 临时目录按服务器分类用：从 sftp:// 路径取主机名（端口/用户/远程路径不影响）
    #[test]
    fn host_of_extracts_host() {
        assert_eq!(host_of("sftp://root@10.0.0.5:2222/var/log").unwrap(), "10.0.0.5");
        assert_eq!(host_of("sftp://me@example.com/").unwrap(), "example.com");
        assert_eq!(host_of("sftp://me@example.com").unwrap(), "example.com");
        assert!(host_of("/local/path").is_err());
        assert!(host_of("sftp://nouser/").is_err());
    }

    /// to_view 的 key_path 回填：PublicKey 非空路径明文下发（编辑回填用）、
    /// 空路径与 Password 恒为 None（凭据字段不外泄）
    #[test]
    fn to_view_backfills_key_path() {
        let pool = SessionPool::default();
        let cfg = |auth: servers::AuthConfig| servers::ServerConfigFile {
            id: "u@h:22".into(),
            name: "测试".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            root: None,
            group: String::new(),
            auth,
        };
        let with_key = cfg(servers::AuthConfig::PublicKey {
            key_path: "~/.ssh/id_ed25519".into(),
            passphrase: None,
            save_passphrase: false,
        });
        let v = to_view(&with_key, &pool);
        assert_eq!(v.auth, "key");
        assert_eq!(v.key_path.as_deref(), Some("~/.ssh/id_ed25519"));

        let empty_key = cfg(servers::AuthConfig::PublicKey {
            key_path: String::new(),
            passphrase: None,
            save_passphrase: false,
        });
        assert_eq!(to_view(&empty_key, &pool).key_path, None);

        let with_pwd = cfg(servers::AuthConfig::Password {
            password: "p".into(),
            save_password: false,
        });
        let v = to_view(&with_pwd, &pool);
        assert_eq!(v.auth, "password");
        assert_eq!(v.key_path, None);
    }

    /// ---- v0.28.1 SFTP 流水线上传：真实链路集成验证（本机 sshd；不可用时静默跳过） ----

    /// 探测本机 sshd + 免密公钥是否可用（CI / 无 sshd 环境返回 false 跳过用例）
    fn localhost_sshd_available() -> bool {
        std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=no", "localhost", "true"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn sftp_pipelined_upload_roundtrip_and_cancel() {
        if !localhost_sshd_available() {
            eprintln!("[skip] 本机 sshd 不可用，跳过 SFTP 流水线集成用例");
            return;
        }
        let user = std::env::var("USER").unwrap_or_else(|_| "root".into());
        let cfg = session::ServerConfig {
            name: "it".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: user.clone(),
            auth: session::AuthMethod::PublicKey { key_path: String::new(), passphrase: None },
            root: None,
            save_secret: false,
        };
        let rt = tokio::runtime::Runtime::new().expect("async runtime");
        rt.block_on(async {
            let mut g = match session::SftpSession::connect(&cfg).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[skip] SFTP 连接失败（{e}），跳过集成用例");
                    return;
                }
            };
            // 8MB 随机数据
            let size = 8 * 1024 * 1024usize;
            let mut data = vec![0u8; size];
            let mut seed = 0x12345678u32;
            for b in data.iter_mut() {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                *b = (seed >> 24) as u8;
            }
            let dir = std::env::temp_dir().join(format!("rdir-sftp-it-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let local = dir.join("big.bin");
            std::fs::write(&local, &data).unwrap();

            // 1) 流水线上传 + 内容回读对账 + 吞吐打印
            let remote = format!("/tmp/rdir-sftp-it-{}.bin", std::process::id());
            let t0 = std::time::Instant::now();
            let mut last: u64 = 0;
            let n = g
                .upload(&local, &remote, |done, _total| {
                    assert!(done >= last, "进度必须单调递增");
                    last = done;
                    true
                })
                .await
                .expect("上传成功");
            let elapsed = t0.elapsed().as_secs_f64();
            assert_eq!(n as usize, size);
            eprintln!(
                "[perf] 流水线上传 8MB（本机回环）：{:.1} MB/s",
                size as f64 / 1024.0 / 1024.0 / elapsed
            );
            let mut back = Vec::new();
            g.download(&remote, &dir.join("back.bin"), |_, _| true).await.expect("回读成功");
            back = std::fs::read(dir.join("back.bin")).unwrap();
            assert_eq!(back.len(), size, "回读长度一致");
            assert!(back == data, "回读内容一致");

            // 2) 取消：首个进度即中止 → 报「已取消」且远端无半成品
            let remote2 = format!("/tmp/rdir-sftp-it-{}-cancel.bin", std::process::id());
            let r = g.upload(&local, &remote2, |_done, _total| false).await;
            assert!(r.is_err(), "取消应报错");
            assert!(format!("{:?}", r.unwrap_err()).contains("CANCELLED"));
            assert!(g.stat(&remote2).await.is_err(), "远端半成品应被删除");

            // 清理
            let _ = g.remove(&remote).await;
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    /// v0.44.0 流式中转链路（本机 sshd；不可用时静默跳过）：
    /// download_pipe（读窗口）→ channel → upload_pipe（写窗口）→ rename_over 落地；
    /// 双会话（同机两条独立 SSH 连接，等价跨服务器场景）：多 chunk 内容对账、
    /// 覆盖改名（目标已存在）、取消删 B 端暂存。
    #[test]
    fn sftp_relay_stream_roundtrip_overwrite_and_cancel() {
        if !localhost_sshd_available() {
            eprintln!("[skip] 本机 sshd 不可用，跳过流式中转集成用例");
            return;
        }
        let user = std::env::var("USER").unwrap_or_else(|_| "root".into());
        let mk_cfg = |name: &str| session::ServerConfig {
            name: name.into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: user.clone(),
            auth: session::AuthMethod::PublicKey { key_path: String::new(), passphrase: None },
            root: None,
            save_secret: false,
        };
        let rt = tokio::runtime::Runtime::new().expect("async runtime");
        rt.block_on(async {
            let mut s1 = match session::SftpSession::connect(&mk_cfg("a")).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[skip] SFTP 连接失败（{e}），跳过集成用例");
                    return;
                }
            };
            let mut s2 = match session::SftpSession::connect(&mk_cfg("b")).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[skip] 第二条 SFTP 连接失败（{e}），跳过集成用例");
                    return;
                }
            };
            let base = format!("/tmp/rdir-relay-stream-{}", std::process::id());
            let src = format!("{base}/src.bin");
            let final_path = format!("{base}/dst.bin");
            let partial = format!("{final_path}.rdir-test.part");
            for d in [&base] {
                s1.mkdir(d).await.unwrap();
            }
            // 300KB 源文件 = 2 个整 chunk + 1 个短 chunk；伪随机可复现
            let size = 300 * 1024usize;
            let data: Vec<u8> = (0..size).map(|i| (i * 31 % 251) as u8).collect();
            let local = std::env::temp_dir().join(format!("rdir-relay-stream-src-{}", std::process::id()));
            std::fs::write(&local, &data).unwrap();
            s1.upload(&local, &src, |_, _| true).await.expect("备源");

            let s1 = std::sync::Arc::new(tokio::sync::Mutex::new(s1));
            let s2 = std::sync::Arc::new(tokio::sync::Mutex::new(s2));

            // 1) 流式往返：交付 = 确认 = 总长，改名落地后内容逐字节对账
            {
                let (tx, rx) = tokio::sync::mpsc::channel(session::RELAY_WINDOW);
                let r = {
                    let g = s1.clone();
                    let src = src.clone();
                    async move { g.lock().await.download_pipe(&src, size as u64, tx, |_, _| true).await }
                };
                let w = {
                    let g = s2.clone();
                    let partial = partial.clone();
                    async move { g.lock().await.upload_pipe(&partial, size as u64, rx, |_, _| true).await }
                };
                let (delivered, acked) = tokio::join!(r, w);
                assert_eq!(delivered.unwrap(), size as u64, "A 端交付字节数");
                assert_eq!(acked.unwrap(), size as u64, "B 端确认字节数");
                s2.lock().await.rename_over(&partial, &final_path).await.expect("覆盖改名落地");
                let back = std::env::temp_dir().join(format!("rdir-relay-stream-back-{}", std::process::id()));
                s2.lock().await.download(&final_path, &back, |_, _| true).await.expect("回读");
                assert_eq!(std::fs::read(&back).unwrap(), data, "流式中转内容一致");
                let _ = std::fs::remove_file(&back);
            }

            // 2) 覆盖：目标已存在时流式 + rename_over 再跑一轮（写入期旧文件仍在，
            //    改名瞬间原子替换——posix-rename 扩展；OpenSSH 不支持时回退删+改名）
            {
                let (tx, rx) = tokio::sync::mpsc::channel(session::RELAY_WINDOW);
                let r = {
                    let g = s1.clone();
                    let src = src.clone();
                    async move { g.lock().await.download_pipe(&src, size as u64, tx, |_, _| true).await }
                };
                let w = {
                    let g = s2.clone();
                    let partial = partial.clone();
                    async move { g.lock().await.upload_pipe(&partial, size as u64, rx, |_, _| true).await }
                };
                let (delivered, acked) = tokio::join!(r, w);
                assert_eq!(delivered.unwrap(), size as u64);
                assert_eq!(acked.unwrap(), size as u64);
                s2.lock().await.rename_over(&partial, &final_path).await.expect("二次覆盖改名");
                assert!(
                    s2.lock().await.stat(&partial).await.is_err(),
                    "暂存名应已消失"
                );
            }

            // 3) 取消：旗标预置 → 首个数据即中止；B 端暂存按编排层语义清理
            {
                let (tx, rx) = tokio::sync::mpsc::channel(session::RELAY_WINDOW);
                let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
                let r = {
                    let g = s1.clone();
                    let src = src.clone();
                    let f = flag.clone();
                    async move {
                        g.lock()
                            .await
                            .download_pipe(&src, size as u64, tx, |_, _| {
                                !f.load(std::sync::atomic::Ordering::Relaxed)
                            })
                            .await
                    }
                };
                let w = {
                    let g = s2.clone();
                    let partial = partial.clone();
                    async move { g.lock().await.upload_pipe(&partial, size as u64, rx, |_, _| true).await }
                };
                let (r, _w) = tokio::join!(r, w);
                let err = r.expect_err("取消应报错");
                assert!(crate::is_cancelled(&err), "取消错误：{err}");
                let partial_exists = s2.lock().await.stat(&partial).await.is_ok();
                if partial_exists {
                    let _ = s2.lock().await.remove(&partial).await;
                }
            }

            // 清理
            {
                let mut g = s2.lock().await;
                let _ = g.remove(&final_path).await;
                let _ = g.remove(&src).await;
                let _ = g.rmdir(&base).await;
            }
            s1.lock().await.close().await;
            s2.lock().await.close().await;
            let _ = std::fs::remove_file(&local);
        });
    }

    /// v0.44.0 SFTP↔SFTP 中转链路（本机 sshd；不可用时静默跳过）：
    /// Preserve 下载（含目录、空格名）→ 暂存树文件名保真 → 上传回程内容对账；
    /// 同机场景（源=目标服务器）照常工作，不依赖多台服务器。
    #[test]
    fn sftp_relay_pipeline_roundtrip() {
        if !localhost_sshd_available() {
            eprintln!("[skip] 本机 sshd 不可用，跳过 SFTP 中转集成用例");
            return;
        }
        let user = std::env::var("USER").unwrap_or_else(|_| "root".into());
        let cfg = session::ServerConfig {
            name: "it".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: user.clone(),
            auth: session::AuthMethod::PublicKey { key_path: String::new(), passphrase: None },
            root: None,
            save_secret: false,
        };
        let rt = tokio::runtime::Runtime::new().expect("async runtime");
        rt.block_on(async {
            let mut g = match session::SftpSession::connect(&cfg).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[skip] SFTP 连接失败（{e}），跳过集成用例");
                    return;
                }
            };
            let tag = std::process::id();
            // 远端源树：带空格的目录名 + 空格/括号/中文文件名 + 子目录（Preserve 不得清洗）
            let base = format!("/tmp/rdir-relay-it-{tag}");
            let src_dir = format!("{base}/src dir");
            let sub_dir = format!("{src_dir}/sub dir");
            let dest_dir = format!("{base}/dest");
            for d in [&base, &src_dir, &sub_dir, &dest_dir] {
                g.mkdir(d).await.expect("建远端目录");
            }
            let local_src = std::env::temp_dir().join(format!("rdir-relay-it-src-{tag}"));
            std::fs::create_dir_all(&local_src).unwrap();
            std::fs::write(local_src.join("top"), [7u8; 4096]).unwrap();
            std::fs::write(local_src.join("nested"), "nested").unwrap();
            g.upload(&local_src.join("top"), &format!("{src_dir}/报告 (终).bin"), |_, _| true)
                .await
                .expect("备源文件");
            g.upload(&local_src.join("nested"), &format!("{sub_dir}/n.txt"), |_, _| true)
                .await
                .expect("备源文件");

            let key = pool_key(&user, "127.0.0.1", 22);
            let mut pool = pool::SessionPool::default();
            pool.put(&key, g);
            let authority = format!("{user}@127.0.0.1");

            // 中转暂存目录：<root>/sftp/127.0.0.1/relay-<pid>-<序号>
            let root = std::env::temp_dir().join(format!("rdir-relay-it-root-{tag}"));
            let stage = crate::remote_temp::relay_stage_dir(&root, "127.0.0.1");
            std::fs::create_dir_all(&stage).unwrap();

            // 下载段：Preserve 模式，目录名与子文件名原样落盘
            let downloaded = download_to_named(
                &pool,
                stage.to_str().unwrap(),
                &format!("sftp://{authority}{src_dir}"),
                true,
                NameMode::Preserve,
                &mut |_ev: XferEvent| true,
            )
            .await
            .expect("下载段成功");
            let staged = stage.join("src dir");
            assert_eq!(std::path::PathBuf::from(&downloaded), staged);
            assert_eq!(std::fs::read(staged.join("报告 (终).bin")).unwrap(), vec![7u8; 4096]);
            assert_eq!(std::fs::read(staged.join("sub dir").join("n.txt")).unwrap(), b"nested");

            // 上传段：传回同机另一目录（同一会话先下后上，不死锁）
            let uploaded = upload_path(
                &pool,
                &downloaded,
                &format!("sftp://{authority}{dest_dir}"),
                "src dir",
                &mut |_ev: XferEvent| true,
            )
            .await
            .expect("上传段成功");
            assert_eq!(uploaded, format!("sftp://{authority}{dest_dir}/src dir"));

            let sess = get_session(&pool, &key).await.unwrap();
            let mut g = sess.lock().await;
            let names = |v: Vec<(String, proto::SftpAttrs)>| {
                let mut n: Vec<String> = v.into_iter().map(|(n, _)| n).collect();
                n.sort();
                n
            };
            assert_eq!(
                names(g.list_dir(&format!("{dest_dir}/src dir")).await.unwrap()),
                vec!["sub dir".to_string(), "报告 (终).bin".to_string()],
                "目标端文件名与源一致"
            );
            assert_eq!(
                names(g.list_dir(&format!("{dest_dir}/src dir/sub dir")).await.unwrap()),
                vec!["n.txt".to_string()]
            );

            // 清理：远端两棵树 + 本地暂存与备料
            for f in [
                format!("{dest_dir}/src dir/sub dir/n.txt"),
                format!("{dest_dir}/src dir/报告 (终).bin"),
                format!("{sub_dir}/n.txt"),
                format!("{src_dir}/报告 (终).bin"),
            ] {
                let _ = g.remove(&f).await;
            }
            for d in [
                format!("{dest_dir}/src dir/sub dir"),
                format!("{dest_dir}/src dir"),
                dest_dir.clone(),
                sub_dir.clone(),
                src_dir.clone(),
                base.clone(),
            ] {
                let _ = g.rmdir(&d).await;
            }
            drop(g);
            assert_eq!(
                crate::remote_temp::remove_tree_best_effort(&root),
                4096 + 6,
                "暂存树释放量对账"
            );
            assert!(!root.exists());
            let _ = std::fs::remove_dir_all(&local_src);
        });
    }

    /// 同服务器剪切粘贴的 move_entry（本机 sshd；不可用时静默跳过）：
    /// 文件跨目录移动（旧路径消失、内容保留）→ 撞名覆盖（rename_over 内容替换）
    /// → 目录整棵移动（旧根消失、子项可查）→ 跨服务器拒绝。
    #[test]
    fn sftp_move_entry_roundtrip() {
        if !localhost_sshd_available() {
            eprintln!("[skip] 本机 sshd 不可用，跳过 SFTP 移动集成用例");
            return;
        }
        let user = std::env::var("USER").unwrap_or_else(|_| "root".into());
        let cfg = session::ServerConfig {
            name: "it".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: user.clone(),
            auth: session::AuthMethod::PublicKey { key_path: String::new(), passphrase: None },
            root: None,
            save_secret: false,
        };
        let rt = tokio::runtime::Runtime::new().expect("async runtime");
        rt.block_on(async {
            let mut g = match session::SftpSession::connect(&cfg).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[skip] SFTP 连接失败（{e}），跳过集成用例");
                    return;
                }
            };
            let tag = std::process::id();
            let base = format!("/tmp/rdir-move-it-{tag}");
            let dir_a = format!("{base}/a");
            let dir_b = format!("{base}/b");
            let tree = format!("{dir_a}/tree");
            let tree_sub = format!("{tree}/sub");
            for d in [&base, &dir_a, &dir_b, &tree, &tree_sub] {
                g.mkdir(d).await.expect("建远端目录");
            }
            let local_src = std::env::temp_dir().join(format!("rdir-move-it-src-{tag}"));
            std::fs::create_dir_all(&local_src).unwrap();
            std::fs::write(local_src.join("f"), [7u8; 1024]).unwrap();
            g.upload(&local_src.join("f"), &format!("{dir_a}/m.txt"), |_, _| true)
                .await
                .expect("备源文件");
            std::fs::write(local_src.join("n"), "nested").unwrap();
            g.upload(&local_src.join("n"), &format!("{tree_sub}/n.txt"), |_, _| true)
                .await
                .expect("备源文件");

            let key = pool_key(&user, "127.0.0.1", 22);
            let mut pool = pool::SessionPool::default();
            pool.put(&key, g);
            let authority = format!("{user}@127.0.0.1");

            // 1) 文件跨目录移动：旧路径消失、新路径内容保留
            let moved = move_entry(
                &pool,
                &format!("sftp://{authority}{dir_a}/m.txt"),
                &format!("sftp://{authority}{dir_b}"),
                "m.txt",
            )
            .await
            .expect("文件移动成功");
            assert_eq!(moved, format!("sftp://{authority}{dir_b}/m.txt"));
            {
                let sess = get_session(&pool, &key).await.unwrap();
                let mut g = sess.lock().await;
                assert!(g.stat(&format!("{dir_a}/m.txt")).await.is_err(), "旧路径已不存在");
                assert_eq!(g.stat(&format!("{dir_b}/m.txt")).await.unwrap().size, 1024);
            }

            // 2) 撞名移动 = rename_over 原子覆盖（内容替换为新源）
            std::fs::write(local_src.join("f"), [9u8; 10]).unwrap();
            {
                let sess = get_session(&pool, &key).await.unwrap();
                let mut g = sess.lock().await;
                g.upload(&local_src.join("f"), &format!("{dir_a}/m.txt"), |_, _| true)
                    .await
                    .expect("备第二个源");
            }
            move_entry(
                &pool,
                &format!("sftp://{authority}{dir_a}/m.txt"),
                &format!("sftp://{authority}{dir_b}"),
                "m.txt",
            )
            .await
            .expect("覆盖移动成功");
            {
                let sess = get_session(&pool, &key).await.unwrap();
                let mut g = sess.lock().await;
                assert_eq!(
                    g.stat(&format!("{dir_b}/m.txt")).await.unwrap().size,
                    10,
                    "目标内容被新源替换"
                );
            }

            // 3) 目录整棵移动：旧根消失、子项可查（本优化最大收益场景）
            move_entry(
                &pool,
                &format!("sftp://{authority}{tree}"),
                &format!("sftp://{authority}{dir_b}"),
                "tree",
            )
            .await
            .expect("目录移动成功");
            {
                let sess = get_session(&pool, &key).await.unwrap();
                let mut g = sess.lock().await;
                assert!(g.stat(&format!("{dir_a}/tree")).await.is_err(), "旧根已不存在");
                let names: Vec<String> = g
                    .list_dir(&format!("{dir_b}/tree/sub"))
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|(n, _)| n)
                    .collect();
                assert_eq!(names, vec!["n.txt".to_string()], "子项随整棵树移动");
            }

            // 4) 跨服务器（不同 pool_key）防御性拒绝
            let other = move_entry(
                &pool,
                &format!("sftp://other@127.0.0.1:22{dir_b}/m.txt"),
                &format!("sftp://{authority}{dir_b}"),
                "m.txt",
            )
            .await;
            assert!(other.is_err(), "跨服务器移动必须拒绝");

            // 清理远端
            let sess = get_session(&pool, &key).await.unwrap();
            let mut g = sess.lock().await;
            for f in [
                format!("{dir_b}/m.txt"),
                format!("{dir_b}/tree/sub/n.txt"),
                format!("{dir_a}/m.txt"),
            ] {
                let _ = g.remove(&f).await;
            }
            for d in [
                format!("{dir_b}/tree/sub"),
                format!("{dir_b}/tree"),
                dir_a.clone(),
                dir_b.clone(),
                base.clone(),
            ] {
                let _ = g.rmdir(&d).await;
            }
            let _ = std::fs::remove_dir_all(&local_src);
        });
    }
}
