//! SFTP 内置插件（feature = "sftp"）：路径解析、连接管理、只读浏览与文件操作。
//! 虚拟路径格式：sftp://user@host[:port]/remote/absolute/path
//! 无端口默认 22；仅 sftp://user@host 时进入默认目录（家目录）。

pub mod pool;
pub mod proto;
pub mod servers;
pub mod session;

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
    // 临时目录：<temp>/r-dir-sftp/<sanitized 文件名>
    let mut dest: PathBuf = std::env::temp_dir().join("r-dir-sftp");
    let safe = sanitize_name(&name);
    dest.push(safe);
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
                return Err("已取消".into());
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
            return Err("已取消".into());
        }
        let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
        g.upload(src, &remote, &mut fcb).await?;
        if !cb(XferEvent::EntryDone) {
            return Err("已取消".into());
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
                    return Err("已取消".into());
                }
                let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
                g.upload(&child, &remote_child, &mut fcb).await?;
                if !cb(XferEvent::EntryDone) {
                    return Err("已取消".into());
                }
            }
            // 其余类型（套接字等非常规条目）跳过
        }
        Ok(())
    })
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
    let (authority, remote) = parse_sftp_path(path)?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let name = Path::new(&remote)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let safe = sanitize_name(&name);
    let mut dest = PathBuf::from(local_dir).join(&safe);
    // 顶层同名冲突：追加 " (1)"、" (2)"…（overwrite 时直接覆盖/并入）
    let mut n = 1;
    while dest.exists() && !overwrite {
        dest = PathBuf::from(local_dir).join(format!("{} ({})", safe, n));
        n += 1;
    }
    let mut g = sess.lock().await;
    let a = g.stat(&remote).await?;
    if a.is_dir {
        std::fs::create_dir_all(&dest).map_err(|e| format!("创建本地目录失败：{e}"))?;
        download_dir_boxed(&mut g, &remote, &dest, cb).await?;
    } else {
        if !cb(XferEvent::Start(name)) {
            return Err("已取消".into());
        }
        let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
        g.download(&remote, &dest, &mut fcb).await?;
        if !cb(XferEvent::EntryDone) {
            return Err("已取消".into());
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 递归下载远程目录到已存在的本地目录（dest 必须已由调用方建好）。
/// 每段名称经 sanitize_name 保证各平台合法（远端名可能含 Windows 保留字符）。
fn download_dir_boxed<'a>(
    g: &'a mut session::SftpSession,
    remote: &'a str,
    dest: &'a Path,
    cb: XferCb<'a>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let entries = g.list_dir(remote).await?;
        for (name, attrs) in entries {
            let safe = sanitize_name(&name);
            let dest_child = dest.join(&safe);
            let remote_child = join_remote(remote, &name);
            if attrs.is_dir {
                std::fs::create_dir_all(&dest_child)
                    .map_err(|e| format!("创建本地目录失败：{e}"))?;
                download_dir_boxed(g, &remote_child, &dest_child, &mut *cb).await?;
            } else {
                if !cb(XferEvent::Start(name)) {
                    return Err("已取消".into());
                }
                let mut fcb = |done, total| cb(XferEvent::Bytes(done, total));
                g.download(&remote_child, &dest_child, &mut fcb).await?;
                if !cb(XferEvent::EntryDone) {
                    return Err("已取消".into());
                }
            }
        }
        Ok(())
    })
}

/// 远程新建目录
pub async fn mkdir(pool: &SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let (authority, rdir) = parse_sftp_path(remote_dir)?;
    let remote = join_remote(&rdir, name);
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    g.mkdir(&remote).await?;
    Ok(format!("sftp://{authority}{remote}"))
}

/// 远程新建空文件
pub async fn create_file(pool: &SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let (authority, rdir) = parse_sftp_path(remote_dir)?;
    let remote = join_remote(&rdir, name);
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
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
}
