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
    let _bytes = g.download(&remote, &dest, &mut cb).await?;
    Ok(dest.to_string_lossy().to_string())
}

/// 下载远程文件到指定本地目录（粘贴/拖拽 远程→本地）；同名自动加 " (n)" 后缀
pub async fn download_to(
    pool: &SessionPool,
    local_dir: &str,
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
    let safe = sanitize_name(&name);
    let mut dest = PathBuf::from(local_dir).join(&safe);
    // 同名冲突：追加 " (1)"、" (2)"…
    let mut n = 1;
    while dest.exists() {
        dest = PathBuf::from(local_dir).join(format!("{} ({})", safe, n));
        n += 1;
    }
    let mut g = sess.lock().await;
    g.download(&remote, &dest, &mut cb).await?;
    Ok(dest.to_string_lossy().to_string())
}

/// 上传本地文件到远程目录
pub async fn upload(
    pool: &SessionPool,
    local: &str,
    remote_dir: &str,
    name: &str,
    mut cb: impl FnMut(u64, u64),
) -> Result<String, String> {
    let remote = join_remote(remote_dir, name);
    let (authority, _) = parse_sftp_path(remote_dir)?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    g.upload(Path::new(local), &remote, &mut cb).await?;
    Ok(format!("sftp://{authority}{remote}"))
}

/// 远程新建目录
pub async fn mkdir(pool: &SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let remote = join_remote(remote_dir, name);
    let (authority, _) = parse_sftp_path(remote_dir)?;
    let (user, host, port) = parse_authority(&authority)?;
    let key = pool_key(&user, &host, port);
    let sess = get_session(pool, &key).await?;
    let mut g = sess.lock().await;
    g.mkdir(&remote).await?;
    Ok(format!("sftp://{authority}{remote}"))
}

/// 远程新建空文件
pub async fn create_file(pool: &SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let remote = join_remote(remote_dir, name);
    let (authority, _) = parse_sftp_path(remote_dir)?;
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
            g.rmdir(&r).await?;
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
