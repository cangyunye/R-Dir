//! NFS 客户端本体：路径解析、会话池、只读浏览与文件操作。
//! 虚拟路径格式：nfs://host[:port]/export/sub/path
//! 无端口默认走 rpcbind 发现；`nfs://host`（无路径）= 列出服务器全部导出。
//! 导出根自动探测：从最短前缀到完整路径逐个尝试挂载，第一个成功者即导出。
//!
//! 两种宿主形态共用本模块：主程序内嵌（NfsClient）与伴生进程插件（server 层调用自由函数）。

pub mod pool;
pub mod session;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

pub use crate::protocol::{NfsEntry, TransferPlan, XferEvent};
use pool::SessionPool;
use session::NfsSession;

/// 取消错误码：与主程序 ERR_CANCELLED 契约一致（纯码或 "CANCELLED|详情"），
/// 经线协议透传后主程序 is_cancelled 按码判定。
pub const ERR_CANCELLED: &str = "CANCELLED";

/// 判定错误串是否为取消
pub fn is_cancelled(err: &str) -> bool {
    err == ERR_CANCELLED || err.starts_with("CANCELLED|")
}

/// 解析 nfs:// 虚拟路径 → (authority, 导出+子路径)。
/// authority = host 或 host:port；导出+子路径 = 以 / 开头的完整路径。
pub fn parse_nfs_path(path: &str) -> Result<(String, String), String> {
    let rest = path
        .strip_prefix("nfs://")
        .ok_or_else(|| format!("不是 nfs 路径：{path}"))?;
    let (authority, full) = match rest.split_once('/') {
        Some((a, r)) => (a.to_string(), format!("/{r}")),
        None => (rest.to_string(), String::new()),
    };
    if authority.is_empty() {
        return Err("nfs 路径缺少主机信息".into());
    }
    Ok((authority, full))
}

/// 解析 authority（host[:port]）→ (host, port)。无端口走 rpcbind 发现。
pub fn parse_authority(authority: &str) -> Result<(String, Option<u16>), String> {
    match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p
                .parse()
                .map_err(|_| format!("nfs 端口无效：{authority}"))?;
            if h.is_empty() || port == 0 {
                return Err(format!("nfs 路径格式错误：{authority}"));
            }
            Ok((h.to_string(), Some(port)))
        }
        None => Ok((authority.to_string(), None)),
    }
}

/// 会话池 key：host[:port]|export
pub fn pool_key(host: &str, port: Option<u16>, export: &str) -> String {
    let auth = match port {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    format!("{auth}|{}", session::normalize_sub(export))
}

/// 已解析的虚拟路径定位：会话（匹配到的导出）+ 相对挂载根的子路径
struct Located {
    sess: Arc<Mutex<NfsSession>>,
    /// 导出之外的子路径（挂载根内相对路径；挂载根本身为 ""）
    sub: String,
}

/// 在池中按最长导出前缀匹配会话（已连接才会命中）
fn locate_session(
    pool: &mut SessionPool,
    host: &str,
    port: Option<u16>,
    full: &str,
) -> Option<Located> {
    let segs: Vec<&str> = full.split('/').filter(|s| !s.is_empty()).collect();
    for k in (1..=segs.len()).rev() {
        let export = format!("/{}", segs[..k].join("/"));
        if let Some(s) = pool.get(&pool_key(host, port, &export)) {
            let sub = session::normalize_sub(&segs[k..].join("/"));
            return Some(Located { sess: s, sub });
        }
    }
    None
}

/// 定位或连接：先查池（最长前缀），未命中则渐进挂载接入池。
/// 子路径必须落在已命中会话的导出之下；全新路径整体走 connect 的渐进探测。
async fn locate_or_connect(
    pool: &mut SessionPool,
    host: &str,
    port: Option<u16>,
    full: &str,
) -> Result<Located, String> {
    if let Some(loc) = locate_session(pool, host, port, full) {
        return Ok(loc);
    }
    let sess = session::connect(host, port, full).await?;
    let key = pool_key(host, port, &sess.export);
    let arc = pool.put(&key, sess);
    let sub = {
        let g = arc.lock().await;
        session::normalize_sub(&full[g.export.len()..])
    };
    Ok(Located { sess: arc, sub })
}

/// 远程条目 → 前端 NfsEntry（path 为可继续导航的完整 nfs:// URL）
fn to_entry(authority: &str, dir_full: &str, name: &str, a: &session::NfsAttrs) -> NfsEntry {
    let full = session::join_sub(dir_full, name);
    let path = format!("nfs://{authority}{full}");
    let extension = Path::new(name)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    NfsEntry {
        name: name.to_string(),
        path,
        is_dir: a.is_dir,
        is_symlink: a.is_symlink,
        size: a.size,
        modified: a.mtime,
        created: None,
        permissions: a.perm_string(),
        extension,
    }
}

/// 列目录（路由入口）。`nfs://host`（无路径）= 列导出（等价 showmount -e）。
pub async fn list_dir(pool: &mut SessionPool, path: &str) -> Result<Vec<NfsEntry>, String> {
    let (authority, full) = parse_nfs_path(path)?;
    let (host, port) = parse_authority(&authority)?;
    let entries: Vec<(String, session::NfsAttrs)> = if full.is_empty() {
        let exports = session::list_exports(&host, port).await?;
        exports
            .into_iter()
            .map(|e| {
                (
                    e.trim_start_matches('/').to_string(),
                    session::NfsAttrs {
                        is_dir: true,
                        ..Default::default()
                    },
                )
            })
            .collect()
    } else {
        let loc = locate_or_connect(pool, &host, port, &full).await?;
        let mut g = loc.sess.lock().await;
        g.list_dir(&loc.sub).await?
    };
    let mut out: Vec<NfsEntry> = entries
        .into_iter()
        .map(|(name, a)| to_entry(&authority, &full, &name, &a))
        .collect();
    // 目录优先 + 名称排序（对齐本地 / SFTP）
    out.sort_by(|x, y| {
        y.is_dir
            .cmp(&x.is_dir)
            .then_with(|| x.name.to_lowercase().cmp(&y.name.to_lowercase()))
    });
    Ok(out)
}

/// stat（路由入口）→ "dir" / "file" / "symlink"
pub async fn stat_path(pool: &mut SessionPool, path: &str) -> Result<String, String> {
    let (authority, full) = parse_nfs_path(path)?;
    let (host, port) = parse_authority(&authority)?;
    if full.is_empty() {
        return Ok("dir".into()); // 导出列表视图恒为目录
    }
    let loc = locate_or_connect(pool, &host, port, &full).await?;
    let mut g = loc.sess.lock().await;
    let a = g.stat(&loc.sub).await?;
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
    pool: &mut SessionPool,
    path: &str,
    temp_dir: &Path,
    mut cb: impl FnMut(u64, u64),
) -> Result<String, String> {
    let (authority, full) = parse_nfs_path(path)?;
    let (host, port) = parse_authority(&authority)?;
    let name = Path::new(&full)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    // 临时目录可能尚不存在（首次打开 / 刚被清理）——先建再写
    let mut dest: PathBuf = temp_dir.to_path_buf();
    dest.push(sanitize_name(&name));
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建临时目录失败：{e}"))?;
    }
    let loc = locate_or_connect(pool, &host, port, &full).await?;
    let mut g = loc.sess.lock().await;
    // 单文件打开场景无取消：字节回调恒放行
    let _bytes = g
        .download(&loc.sub, &dest, &mut |done, total| {
            cb(done, total);
            true
        })
        .await?;
    Ok(dest.to_string_lossy().to_string())
}

// ==================== v0.39 递归传输（文件夹上传/下载，对齐 SFTP 结构） ====================
// TransferPlan / XferEvent / NfsEntry 定义在 protocol（线协议契约，host 与插件共用）

/// 递归传输回调：返回 false = 取消整个传输
pub type XferCb<'a> = &'a mut (dyn FnMut(XferEvent) -> bool + Send + 'a);

/// 统计本地路径（文件或目录树）的文件数与总字节（上传进度分母）
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
    pool: &mut SessionPool,
    path: &str,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<TransferPlan, String> {
    let (authority, full) = parse_nfs_path(path)?;
    let (host, port) = parse_authority(&authority)?;
    let loc = locate_or_connect(pool, &host, port, &full).await?;
    let mut g = loc.sess.lock().await;
    let a = g.stat(&loc.sub).await?;
    let mut plan = TransferPlan::default();
    if a.is_dir {
        plan_remote_boxed(&mut g, &loc.sub, &mut plan, cancelled).await?;
    } else {
        plan.files = 1;
        plan.bytes = a.size;
    }
    Ok(plan)
}

fn plan_remote_boxed<'a>(
    g: &'a mut NfsSession,
    sub: &'a str,
    plan: &'a mut TransferPlan,
    cancelled: &'a std::sync::atomic::AtomicBool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        use std::sync::atomic::Ordering;
        let entries = g.list_dir(sub).await?;
        for (name, attrs) in entries {
            if cancelled.load(Ordering::Relaxed) {
                return Err(ERR_CANCELLED.into());
            }
            if attrs.is_dir {
                let child = session::join_sub(sub, &name);
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
async fn ensure_remote_dir(g: &mut NfsSession, sub: &str) -> Result<(), String> {
    match g.mkdir(sub).await {
        Ok(()) => Ok(()),
        Err(e) => match g.stat(sub).await {
            Ok(a) if a.is_dir => Ok(()),
            _ => Err(e),
        },
    }
}

/// 上传本地路径（文件或目录）到远程目录下，返回远程完整 URL。
/// 目录递归：远程逐级 mkdir（已存在并入）、本地逐级遍历；空目录也会在远端创建。
pub async fn upload_path(
    pool: &mut SessionPool,
    local: &str,
    remote_dir: &str,
    name: &str,
    cb: XferCb<'_>,
) -> Result<String, String> {
    let (authority, rdir) = parse_nfs_path(remote_dir)?;
    let (host, port) = parse_authority(&authority)?;
    let src = Path::new(local);
    let meta = std::fs::metadata(src).map_err(|e| format!("读取本地失败：{e}"))?;
    let loc = locate_or_connect(pool, &host, port, &rdir).await?;
    // 会话内操作用挂载根相对路径；对外 URL 必须带上导出前缀（完整虚拟路径）
    let remote_in_mount = session::join_sub(&loc.sub, name);
    let remote_full = session::join_sub(&rdir, name);
    let mut g = loc.sess.lock().await;
    if meta.is_dir() {
        ensure_remote_dir(&mut g, &remote_in_mount).await?;
        upload_dir_boxed(&mut g, src, &remote_in_mount, src, cb).await?;
    } else {
        if !cb(XferEvent::Start { label: name.to_string() }) {
            return Err(ERR_CANCELLED.into());
        }
        let mut fcb = |done, total| cb(XferEvent::Bytes { done, total });
        g.upload(src, &remote_in_mount, &mut fcb).await?;
        if !cb(XferEvent::EntryDone) {
            return Err(ERR_CANCELLED.into());
        }
    }
    Ok(format!("nfs://{authority}{remote_full}"))
}

/// 递归上传目录内容到已存在的远程目录（remote 必须已由调用方建好）
fn upload_dir_boxed<'a>(
    g: &'a mut NfsSession,
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
            let remote_child = session::join_sub(remote, &name);
            if meta.is_dir() {
                ensure_remote_dir(g, &remote_child).await?;
                upload_dir_boxed(g, &child, &remote_child, top, &mut *cb).await?;
            } else if meta.is_file() {
                let rel = child
                    .strip_prefix(top)
                    .unwrap_or(&child)
                    .to_string_lossy()
                    .to_string();
                if !cb(XferEvent::Start { label: rel }) {
                    return Err(ERR_CANCELLED.into());
                }
                let mut fcb = |done, total| cb(XferEvent::Bytes { done, total });
                g.upload(&child, &remote_child, &mut fcb).await?;
                if !cb(XferEvent::EntryDone) {
                    return Err(ERR_CANCELLED.into());
                }
            }
            // 其余类型（套接字等非常规条目）跳过
        }
        Ok(())
    })
}

/// 下载远程路径（文件或目录）到指定本地目录（粘贴/拖拽 远程→本地）。
/// overwrite=false：顶层同名自动加 " (n)" 后缀（粘贴的既有行为）；
/// overwrite=true：直接覆盖同名文件/并入同名目录（拖拽经用户覆盖确认后使用）。
/// 目录递归：本地逐级 create_dir_all、远程逐级 list_dir；空目录也会在本地创建。
/// 返回本地落点路径。
pub async fn download_to(
    pool: &mut SessionPool,
    local_dir: &str,
    path: &str,
    overwrite: bool,
    cb: XferCb<'_>,
) -> Result<String, String> {
    let (authority, full) = parse_nfs_path(path)?;
    let (host, port) = parse_authority(&authority)?;
    let name = Path::new(&full)
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
    let loc = locate_or_connect(pool, &host, port, &full).await?;
    let mut g = loc.sess.lock().await;
    let a = g.stat(&loc.sub).await?;
    if a.is_dir {
        std::fs::create_dir_all(&dest).map_err(|e| format!("创建本地目录失败：{e}"))?;
        download_dir_boxed(&mut g, &loc.sub, &dest, cb).await?;
    } else {
        if !cb(XferEvent::Start { label: name }) {
            return Err(ERR_CANCELLED.into());
        }
        let mut fcb = |done, total| cb(XferEvent::Bytes { done, total });
        g.download(&loc.sub, &dest, &mut fcb).await?;
        if !cb(XferEvent::EntryDone) {
            return Err(ERR_CANCELLED.into());
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 递归下载远程目录到已存在的本地目录（dest 必须已由调用方建好）。
/// 每段名称经 sanitize_name 保证各平台合法。
fn download_dir_boxed<'a>(
    g: &'a mut NfsSession,
    remote: &'a str,
    dest: &'a Path,
    cb: XferCb<'a>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let entries = g.list_dir(remote).await?;
        for (name, attrs) in entries {
            let safe = sanitize_name(&name);
            let dest_child = dest.join(&safe);
            let remote_child = session::join_sub(remote, &name);
            if attrs.is_dir {
                std::fs::create_dir_all(&dest_child)
                    .map_err(|e| format!("创建本地目录失败：{e}"))?;
                download_dir_boxed(g, &remote_child, &dest_child, &mut *cb).await?;
            } else {
                if !cb(XferEvent::Start { label: name }) {
                    return Err(ERR_CANCELLED.into());
                }
                let mut fcb = |done, total| cb(XferEvent::Bytes { done, total });
                g.download(&remote_child, &dest_child, &mut fcb).await?;
                if !cb(XferEvent::EntryDone) {
                    return Err(ERR_CANCELLED.into());
                }
            }
        }
        Ok(())
    })
}

/// 远程新建目录
pub async fn mkdir(pool: &mut SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let (authority, rdir) = parse_nfs_path(remote_dir)?;
    let (host, port) = parse_authority(&authority)?;
    let loc = locate_or_connect(pool, &host, port, &rdir).await?;
    let remote_in_mount = session::join_sub(&loc.sub, name);
    let remote_full = session::join_sub(&rdir, name);
    let mut g = loc.sess.lock().await;
    g.mkdir(&remote_in_mount).await?;
    Ok(format!("nfs://{authority}{remote_full}"))
}

/// 远程新建空文件
pub async fn create_file(pool: &mut SessionPool, remote_dir: &str, name: &str) -> Result<String, String> {
    let (authority, rdir) = parse_nfs_path(remote_dir)?;
    let (host, port) = parse_authority(&authority)?;
    let loc = locate_or_connect(pool, &host, port, &rdir).await?;
    let remote_in_mount = session::join_sub(&loc.sub, name);
    let remote_full = session::join_sub(&rdir, name);
    let mut g = loc.sess.lock().await;
    g.touch(&remote_in_mount).await?;
    Ok(format!("nfs://{authority}{remote_full}"))
}

/// 远程删除：目录递归删（先删内容再删目录），文件直接删
pub async fn delete_entries(pool: &mut SessionPool, paths: &[String]) -> Result<(), String> {
    let (authority, _) = parse_nfs_path(&paths[0])?;
    let (host, port) = parse_authority(&authority)?;
    // 同一服务器的多条目：按路径逐条定位（通常同会话，锁开销可忽略）
    for path in paths {
        let (_, full) = parse_nfs_path(path)?;
        let loc = locate_or_connect(pool, &host, port, &full).await?;
        let mut g = loc.sess.lock().await;
        let a = g.stat(&loc.sub).await?;
        if a.is_dir {
            g.remove_recursive(&loc.sub).await?;
        } else {
            g.remove(&loc.sub).await?;
        }
    }
    Ok(())
}

/// 远程重命名/移动
pub async fn rename_entry(pool: &mut SessionPool, old_path: &str, new_name: &str) -> Result<String, String> {
    let (authority, old_full) = parse_nfs_path(old_path)?;
    let (host, port) = parse_authority(&authority)?;
    let parent = Path::new(&old_full)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string());
    let new_full = session::join_sub(&parent, new_name);
    let loc = locate_or_connect(pool, &host, port, &old_full).await?;
    // 新路径换算为挂载根相对（g.rename 在挂载根内解析）
    let new_in_mount = {
        let g = loc.sess.lock().await;
        session::normalize_sub(&new_full[g.export.len()..])
    };
    let mut g = loc.sess.lock().await;
    g.rename(&loc.sub, &new_in_mount).await?;
    Ok(format!("nfs://{authority}{new_full}"))
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

// ==================== 内嵌入口（主程序 InProcess 后端） ====================

/// 自带会话池的客户端句柄：方法签名与线协议 op 一一对应，
/// 主程序 feature = "nfs" 时经 [`crate::client::NfsClient`] 直接内嵌调用。
pub struct NfsClient {
    pool: Mutex<SessionPool>,
}

impl Default for NfsClient {
    fn default() -> Self {
        Self::new()
    }
}

impl NfsClient {
    pub fn new() -> Self {
        Self { pool: Mutex::new(SessionPool::default()) }
    }

    pub async fn list_dir(&self, path: &str) -> Result<Vec<NfsEntry>, String> {
        let mut pool = self.pool.lock().await;
        list_dir(&mut pool, path).await
    }

    pub async fn stat_path(&self, path: &str) -> Result<String, String> {
        let mut pool = self.pool.lock().await;
        stat_path(&mut pool, path).await
    }

    pub async fn download(
        &self,
        path: &str,
        temp_dir: &Path,
        cb: impl FnMut(u64, u64),
    ) -> Result<String, String> {
        let mut pool = self.pool.lock().await;
        download(&mut pool, path, temp_dir, cb).await
    }

    pub async fn download_plan(
        &self,
        path: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<TransferPlan, String> {
        let mut pool = self.pool.lock().await;
        download_plan(&mut pool, path, cancelled).await
    }

    pub async fn download_to(
        &self,
        local_dir: &str,
        path: &str,
        overwrite: bool,
        cb: XferCb<'_>,
    ) -> Result<String, String> {
        let mut pool = self.pool.lock().await;
        download_to(&mut pool, local_dir, path, overwrite, cb).await
    }

    pub async fn upload_path(
        &self,
        local: &str,
        remote_dir: &str,
        name: &str,
        cb: XferCb<'_>,
    ) -> Result<String, String> {
        let mut pool = self.pool.lock().await;
        upload_path(&mut pool, local, remote_dir, name, cb).await
    }

    pub async fn mkdir(&self, remote_dir: &str, name: &str) -> Result<String, String> {
        let mut pool = self.pool.lock().await;
        mkdir(&mut pool, remote_dir, name).await
    }

    pub async fn create_file(&self, remote_dir: &str, name: &str) -> Result<String, String> {
        let mut pool = self.pool.lock().await;
        create_file(&mut pool, remote_dir, name).await
    }

    pub async fn delete_entries(&self, paths: &[String]) -> Result<(), String> {
        let mut pool = self.pool.lock().await;
        delete_entries(&mut pool, paths).await
    }

    pub async fn rename_entry(&self, old_path: &str, new_name: &str) -> Result<String, String> {
        let mut pool = self.pool.lock().await;
        rename_entry(&mut pool, old_path, new_name).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_paths() {
        let (a, f) = parse_nfs_path("nfs://192.168.1.5/srv/nfs-share/文档/hello.txt").unwrap();
        assert_eq!(a, "192.168.1.5");
        assert_eq!(f, "/srv/nfs-share/文档/hello.txt");
        let (a2, f2) = parse_nfs_path("nfs://h1:20490").unwrap();
        assert_eq!(a2, "h1:20490");
        assert_eq!(f2, "");
        assert!(parse_nfs_path("sftp://h/a").is_err());
        assert!(parse_nfs_path("nfs://").is_err());
    }

    #[test]
    fn parse_authorities() {
        assert_eq!(parse_authority("h1").unwrap(), ("h1".into(), None));
        assert_eq!(parse_authority("h1:2049").unwrap(), ("h1".into(), Some(2049)));
        assert!(parse_authority("h1:0").is_err());
        assert!(parse_authority(":2049").is_err());
        assert!(parse_authority("h1:abc").is_err());
    }

    #[test]
    fn pool_keys() {
        assert_eq!(pool_key("h1", None, "/a/b"), "h1|/a/b");
        assert_eq!(pool_key("h1", Some(2049), "/a/b/"), "h1:2049|/a/b");
    }

    #[test]
    fn upload_plan_counts_tree() {
        let root = std::env::temp_dir().join("rdir-nfs-plan-tree");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        std::fs::write(root.join("top.txt"), "12345").unwrap();
        std::fs::write(root.join("sub/b.bin"), [0u8; 10]).unwrap();
        std::fs::write(root.join("sub/deep/c.txt"), "xyz").unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        let plan = upload_plan(root.to_str().unwrap()).unwrap();
        assert_eq!(plan.files, 3);
        assert_eq!(plan.bytes, 18);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ---- v0.39 NFS 真机集成验证（WSL nfsd；服务器不可达时静默跳过） ----
    /// 主机可用 RDIR_NFS_TEST_HOST 覆盖；导出固定为 /srv/rdir-nfs（测试目录树见
    /// tools/wsl-setup-servers.sh：big-8mb.bin / empty-dir / nested/deep/file.txt / 文档/hello.txt）。

    fn test_host() -> String {
        std::env::var("RDIR_NFS_TEST_HOST").unwrap_or_else(|_| "172.20.214.44".into())
    }

    fn nfs_server_available() -> bool {
        std::net::TcpStream::connect_timeout(
            &format!("{}:2049", test_host())
                .parse()
                .expect("测试主机地址无效"),
            std::time::Duration::from_secs(2),
        )
        .is_ok()
    }

    #[test]
    fn nfs_live_roundtrip_list_transfer_ops() {
        if !nfs_server_available() {
            eprintln!("[skip] NFS 测试服务器（{}:2049）不可达，跳过集成用例", test_host());
            return;
        }
        let host = test_host();
        let rt = tokio::runtime::Runtime::new().expect("async runtime");
        rt.block_on(async {
            let mut pool = pool::SessionPool::default();
            let base = format!("nfs://{host}/srv/rdir-nfs");

            // 0) 清理上轮可能的残留（失败中断会留下 it-dir/upload.bin 等）
            for leftover in ["it-dir", "upload.bin", "cancelled.bin"] {
                let _ = delete_entries(&mut pool, &[format!("{base}/{leftover}")]).await;
            }

            // 1) 根视图：nfs://host 列出导出（showmount -e 语义）
            let exports = list_dir(&mut pool, &format!("nfs://{host}")).await.expect("列导出");
            assert!(
                exports.iter().any(|e| e.path == "/srv/rdir-nfs" || e.name.contains("rdir-nfs")),
                "导出列表应含 /srv/rdir-nfs：{:?}",
                exports.iter().map(|e| e.path.clone()).collect::<Vec<_>>()
            );

            // 2) 列目录：目录优先排序 + 测试树齐全（含中文目录名——挂载 URL 段编码）
            let entries = list_dir(&mut pool, &base).await.expect("列目录");
            let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
            for expect in ["big-8mb.bin", "empty-dir", "nested", "文档"] {
                assert!(names.contains(&expect), "缺少条目 {expect}：{names:?}");
            }
            // 只校验已知条目（上轮失败可能残留 it-dir/upload.bin 等）
            for e in &entries {
                let expect_dir = match e.name.as_str() {
                    "empty-dir" | "nested" | "文档" | "bn" => Some(true),
                    "big-8mb.bin" | "readme.md" => Some(false),
                    _ => None,
                };
                if let Some(want) = expect_dir {
                    assert_eq!(e.is_dir, want, "{} 的目录标志应为 {want}", e.name);
                }
            }
            let big = entries.iter().find(|e| e.name == "big-8mb.bin").unwrap();
            assert_eq!(big.size, 8_388_608, "远程大小应来自 readdirplus 属性");
            assert!(!big.path.is_empty() && big.path.starts_with("nfs://"));

            // 3) 中文子目录 + 深层文件（路径逐级解析）
            let deep = format!("{base}/nested/deep/file.txt");
            assert_eq!(stat_path(&mut pool, &deep).await.expect("stat"), "file");
            assert_eq!(
                stat_path(&mut pool, &format!("{base}/文档")).await.expect("stat cjk"),
                "dir"
            );

            // 4) 下载 8MB：字节数 + 进度单调
            let dir = std::env::temp_dir().join(format!("rdir-nfs-it-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let mut last: u64 = 0;
            let local = download(&mut pool, &deep, &dir, |done, _total| {
                assert!(done >= last, "进度必须单调递增");
                last = done;
            })
            .await
            .expect("下载");
            assert_eq!(std::fs::read(&local).unwrap(), b"deep file\n");

            // 5) 上传（内容回读对账）+ 覆盖上传
            let up_src = dir.join("upload.bin");
            std::fs::write(&up_src, vec![7u8; 300_000]).unwrap();
            let up_url = upload_path(&mut pool, up_src.to_str().unwrap(), &base, "upload.bin", &mut |_| true)
                .await
                .expect("上传");
            assert_eq!(up_url, format!("{base}/upload.bin"));
            let back = download_to(
                &mut pool,
                dir.to_str().unwrap(),
                &format!("{base}/upload.bin"),
                true,
                &mut |_| true,
            )
            .await
            .expect("回读");
            assert_eq!(std::fs::read(&back).unwrap().len(), 300_000);

            // 6) mkdir / touch / rename / 递归删除
            let nd = mkdir(&mut pool, &base, "it-dir").await.expect("mkdir");
            assert_eq!(nd, format!("{base}/it-dir"));
            let nf = create_file(&mut pool, &nd, "a.txt").await.expect("touch");
            assert_eq!(nf, format!("{base}/it-dir/a.txt"));
            let rn = rename_entry(&mut pool, &nf, "b.txt").await.expect("rename");
            assert_eq!(rn, format!("{base}/it-dir/b.txt"));
            delete_entries(&mut pool, &[nd.clone()]).await.expect("递归删除");
            assert!(
                stat_path(&mut pool, &nd).await.is_err(),
                "删除后 stat 应失败"
            );

            // 7) 取消上传：报「已取消」且远端无半成品
            let r = upload_path(&mut pool, up_src.to_str().unwrap(), &base, "cancelled.bin", &mut |_| false).await;
            assert!(r.is_err(), "取消应报错");
            assert!(
                is_cancelled(&r.unwrap_err()),
                "取消错误码应为 CANCELLED"
            );
            assert!(stat_path(&mut pool, &format!("{base}/cancelled.bin")).await.is_err());

            // 清理
            let _ = delete_entries(&mut pool, &[format!("{base}/upload.bin")]).await;
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
