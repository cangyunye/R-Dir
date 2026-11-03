//! v0.40 NFS 后端抽象：同一 [`NfsBackend`] 契约，三种实现——
//! - **InProcess**（feature = "nfs"）：内嵌 rdir-nfs 客户端（开发/全量构建，零进程开销）；
//! - **Sidecar**（feature = "nfs-sidecar"）：经 .rdplugin 安装的伴生进程（`rdir-nfs`），
//!   stdio JSON 行协议按 id 多路复用，懒启动 / 崩溃自动重启 / 5 分钟空闲回收；
//! - **Unavailable**：两者皆无（`--no-default-features` 极简构建），所有操作返回明确错误。
//! 优先级 InProcess > Sidecar。lib.rs 的 nfs:// 路由只认 [`NfsHandle`]，零 cfg 双分支。
//!
//! 事件/取消契约与 SFTP 完全同构：XferEvent 三臂 + cb 返回 false 取消 +
//! CANCELLED 错误码，前端进度与取消路由零改动（v0.39 的既有约定）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use rdir_nfs::protocol::NfsEntry;

use crate::fs_ops::FileEntry;

pub use rdir_nfs::protocol::{TransferPlan, XferEvent, PROTOCOL_VERSION as NFS_PROTOCOL_VERSION};

/// 递归传输回调：返回 false = 取消整个传输（与 SFTP/本地复制同语义）
pub type XferCb<'a> = &'a mut (dyn FnMut(XferEvent) -> bool + Send + 'a);

/// 统计本地路径（文件或目录树）的文件数与总字节（上传进度分母）。
/// 纯本地遍历，与后端形态无关——nfs_upload 命令无条件编译，两实现共用。
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

/// NfsEntry → 前端条目（字段一一对应；协议层独立定义以解耦 fs_ops）
fn entry_to_file_entry(e: NfsEntry) -> FileEntry {
    FileEntry {
        name: e.name,
        path: e.path,
        is_dir: e.is_dir,
        is_symlink: e.is_symlink,
        size: e.size,
        modified: e.modified,
        created: e.created,
        permissions: e.permissions,
        extension: e.extension,
    }
}

// 仅 sidecar 模块消费；双 feature 全量形状下随模块一起被 dead-code 判死（同上）
#[cfg_attr(all(feature = "nfs", feature = "nfs-sidecar"), allow(dead_code))]
fn value_to_string(v: serde_json::Value) -> Result<String, String> {
    match v {
        serde_json::Value::String(s) => Ok(s),
        other => Err(format!("NFS 插件返回了非字符串结果：{other}")),
    }
}

#[cfg_attr(all(feature = "nfs", feature = "nfs-sidecar"), allow(dead_code))]
fn value_to<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("NFS 插件返回格式错误：{e}"))
}

// ==================== 后端契约 ====================

#[async_trait]
pub trait NfsBackend: Send + Sync {
    async fn list_dir(&self, path: String) -> Result<Vec<FileEntry>, String>;
    async fn stat_path(&self, path: String) -> Result<String, String>;
    /// 下载单文件到临时目录（打开场景，无取消）；进度经 cb(done, total)
    async fn download(
        &self,
        path: String,
        temp_dir: &Path,
        cb: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<String, String>;
    /// 遍历远程树统计文件数/字节（下载分母）；cancelled 置位即中止
    async fn download_plan(
        &self,
        path: String,
        cancelled: Arc<AtomicBool>,
    ) -> Result<TransferPlan, String>;
    async fn download_to(
        &self,
        local_dir: String,
        path: String,
        overwrite: bool,
        cb: XferCb<'_>,
    ) -> Result<String, String>;
    async fn upload_path(
        &self,
        local: String,
        remote_dir: String,
        name: String,
        cb: XferCb<'_>,
    ) -> Result<String, String>;
    async fn mkdir(&self, remote_dir: String, name: String) -> Result<String, String>;
    async fn create_file(&self, remote_dir: String, name: String) -> Result<String, String>;
    async fn delete_entries(&self, paths: Vec<String>) -> Result<(), String>;
    async fn rename_entry(&self, old_path: String, new_name: String) -> Result<String, String>;
}

// ==================== InProcess（feature = "nfs"） ====================

#[cfg(feature = "nfs")]
pub struct InProcess {
    client: rdir_nfs::client::NfsClient,
}

#[cfg(feature = "nfs")]
impl InProcess {
    pub fn new() -> Self {
        Self { client: rdir_nfs::client::NfsClient::new() }
    }
}

#[cfg(feature = "nfs")]
impl Default for InProcess {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "nfs")]
#[async_trait]
impl NfsBackend for InProcess {
    async fn list_dir(&self, path: String) -> Result<Vec<FileEntry>, String> {
        self.client
            .list_dir(&path)
            .await
            .map(|v| v.into_iter().map(entry_to_file_entry).collect())
    }

    async fn stat_path(&self, path: String) -> Result<String, String> {
        self.client.stat_path(&path).await
    }

    async fn download(
        &self,
        path: String,
        temp_dir: &Path,
        cb: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<String, String> {
        self.client
            .download(&path, temp_dir, |done, total| cb(done, total))
            .await
    }

    async fn download_plan(
        &self,
        path: String,
        cancelled: Arc<AtomicBool>,
    ) -> Result<TransferPlan, String> {
        self.client.download_plan(&path, &cancelled).await
    }

    async fn download_to(
        &self,
        local_dir: String,
        path: String,
        overwrite: bool,
        cb: XferCb<'_>,
    ) -> Result<String, String> {
        self.client.download_to(&local_dir, &path, overwrite, cb).await
    }

    async fn upload_path(
        &self,
        local: String,
        remote_dir: String,
        name: String,
        cb: XferCb<'_>,
    ) -> Result<String, String> {
        self.client.upload_path(&local, &remote_dir, &name, cb).await
    }

    async fn mkdir(&self, remote_dir: String, name: String) -> Result<String, String> {
        self.client.mkdir(&remote_dir, &name).await
    }

    async fn create_file(&self, remote_dir: String, name: String) -> Result<String, String> {
        self.client.create_file(&remote_dir, &name).await
    }

    async fn delete_entries(&self, paths: Vec<String>) -> Result<(), String> {
        self.client.delete_entries(&paths).await
    }

    async fn rename_entry(&self, old_path: String, new_name: String) -> Result<String, String> {
        self.client.rename_entry(&old_path, &new_name).await
    }
}

// ==================== Sidecar（feature = "nfs-sidecar"） ====================

// 内嵌 nfs 与 sidecar 同开（--features nfs 全量形状）时 select_backend 走 InProcess，
// 本模块从外部不可达 → 整链 dead_code；保留编译以支撑无内嵌构建的插件形态。
#[cfg(feature = "nfs-sidecar")]
#[cfg_attr(all(feature = "nfs", feature = "nfs-sidecar"), allow(dead_code))]
mod sidecar {
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rdir_nfs::protocol::{Cancel, CancelOp, Frame, Op};
    use serde::Serialize;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::{mpsc, Mutex};

    use super::*;

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 请求行：id 与 tagged Op 拍平（{"id":7,"op":"list_dir","args":{…}}）
    #[derive(Serialize)]
    struct ReqLine<'a> {
        id: u64,
        #[serde(flatten)]
        op: &'a Op,
    }

    struct Running {
        stdin: Mutex<tokio::process::ChildStdin>,
        child: Mutex<tokio::process::Child>,
        pending: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Frame>>>>,
    }

    /// 伴生进程宿主：懒启动（首次 nfs:// 调用时，每次启动前重读 install.json，
    /// 装完即用无需重启应用）；进程退出自动清态、下次调用重启；5 分钟空闲回收。
    pub struct SidecarHost {
        /// 插件安装根（app_config_dir()/plugins）；init 时填入，未填视为未安装
        plugins_root: std::sync::Mutex<Option<PathBuf>>,
        running: Mutex<Option<Arc<Running>>>,
        next_id: AtomicU64,
        last_used: AtomicU64,
        reaper_started: AtomicBool,
    }

    /// 已安装插件的二进制路径（install.json 缺失/损坏 = 未安装）
    fn installed_exe(root: &Path) -> Result<PathBuf, String> {
        let install_json = root.join("nfs").join("install.json");
        let text = std::fs::read_to_string(&install_json)
            .map_err(|_| "NFS 插件未安装（设置 → 插件中可安装）".to_string())?;
        let info: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("NFS 插件安装信息损坏：{e}"))?;
        let exe = info
            .get("exe")
            .and_then(|v| v.as_str())
            .ok_or("NFS 插件安装信息缺少 exe 字段")?;
        let path = PathBuf::from(exe);
        if !path.exists() {
            return Err("NFS 插件文件缺失，请在设置 → 插件中重新安装".into());
        }
        Ok(path)
    }

    impl SidecarHost {
        pub fn new_arc() -> Arc<Self> {
            Arc::new(Self {
                plugins_root: std::sync::Mutex::new(None),
                running: Mutex::new(None),
                next_id: AtomicU64::new(1),
                last_used: AtomicU64::new(now_ms()),
                reaper_started: AtomicBool::new(false),
            })
        }

        pub fn set_plugins_root(&self, root: PathBuf) {
            *self.plugins_root.lock().unwrap() = Some(root);
        }

        async fn ensure_running(self: &Arc<Self>) -> Result<Arc<Running>, String> {
            self.last_used.store(now_ms(), Ordering::Relaxed);
            if let Some(r) = self.running.lock().await.as_ref() {
                return Ok(r.clone());
            }
            let root = self
                .plugins_root
                .lock()
                .unwrap()
                .clone()
                .ok_or("NFS 插件未安装（设置 → 插件中可安装）")?;
            let exe = installed_exe(&root)?;
            let mut child = tokio::process::Command::new(&exe)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .spawn()
                .map_err(|e| format!("NFS 插件启动失败：{e}"))?;
            let stdin = child.stdin.take().ok_or("NFS 插件进程无 stdin")?;
            let stdout = child.stdout.take().ok_or("NFS 插件进程无 stdout")?;
            let running = Arc::new(Running {
                stdin: Mutex::new(stdin),
                child: Mutex::new(child),
                pending: Arc::new(Mutex::new(HashMap::new())),
            });
            self.spawn_reader(stdout, &running);
            self.spawn_reaper();
            *self.running.lock().await = Some(running.clone());
            Ok(running)
        }

        /// stdout 读任务：按 id 路由帧到等待方；EOF = 进程退出 →
        /// 唤醒全部 pending（下一次调用自动重启进程）
        fn spawn_reader(
            self: &Arc<Self>,
            stdout: tokio::process::ChildStdout,
            running: &Arc<Running>,
        ) {
            let pending = running.pending.clone();
            let host = self.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match serde_json::from_str::<Frame>(&line) {
                        Ok(Frame::Log { level, message }) => {
                            eprintln!("NFS 插件 [{level}] {message}");
                        }
                        Ok(frame) => {
                            let id = match &frame {
                                Frame::Ok { id, .. }
                                | Frame::Err { id, .. }
                                | Frame::Ev { id, .. } => *id,
                                Frame::Log { .. } => unreachable!("上一臂已处理"),
                            };
                            if let Some(tx) = pending.lock().await.get(&id) {
                                let _ = tx.send(frame);
                            }
                        }
                        Err(e) => eprintln!("NFS 插件输出解析失败：{e}"),
                    }
                }
                {
                    let mut map = pending.lock().await;
                    for (_, tx) in map.drain() {
                        let _ = tx.send(Frame::Err { id: 0, error: "NFS 插件进程已退出".into() });
                    }
                }
                *host.running.lock().await = None;
                eprintln!("NFS 插件进程已退出，将在下次调用时自动重启");
            });
        }

        /// 空闲回收：每分钟巡检，5 分钟无调用杀进程（下次调用自动重启）
        fn spawn_reaper(self: &Arc<Self>) {
            if self.reaper_started.swap(true, Ordering::Relaxed) {
                return;
            }
            let host = self.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let idle_ms = now_ms().saturating_sub(host.last_used.load(Ordering::Relaxed));
                    if idle_ms >= 5 * 60 * 1000 {
                        if let Some(r) = host.running.lock().await.take() {
                            let _ = r.child.lock().await.kill().await;
                        }
                    }
                }
            });
        }

        async fn send_cancel(&self, id: u64) {
            let running = self.running.lock().await;
            let Some(r) = running.as_ref() else { return };
            let line = match serde_json::to_string(&Cancel { op: CancelOp::Cancel, id }) {
                Ok(l) => l,
                Err(_) => return,
            };
            let mut stdin = r.stdin.lock().await;
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
        }

        /// 发起一次操作：写请求行 → 泵事件帧到 on_event（返回 false 转发 cancel）→
        /// 返回终态。cancel 提供时轮询旗标转发（服务 download_plan 等无事件操作）。
        pub async fn call(
            self: &Arc<Self>,
            op: Op,
            cancel: Option<Arc<AtomicBool>>,
            mut on_event: impl FnMut(XferEvent) -> bool + Send,
        ) -> Result<serde_json::Value, String> {
            let running = self.ensure_running().await?;
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();
            running.pending.lock().await.insert(id, tx);
            self.last_used.store(now_ms(), Ordering::Relaxed);
            if let Some(flag) = cancel {
                let host = self.clone();
                let pending = running.pending.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        if flag.load(Ordering::Relaxed) {
                            host.send_cancel(id).await;
                        }
                        if !pending.lock().await.contains_key(&id) {
                            break;
                        }
                    }
                });
            }
            let line = serde_json::to_string(&ReqLine { id, op: &op })
                .map_err(|e| e.to_string())?;
            let write_ok = {
                let mut stdin = running.stdin.lock().await;
                stdin.write_all(line.as_bytes()).await.is_ok()
                    && stdin.write_all(b"\n").await.is_ok()
                    && stdin.flush().await.is_ok()
            };
            if !write_ok {
                running.pending.lock().await.remove(&id);
                *self.running.lock().await = None;
                return Err("NFS 插件进程通信失败，请重试".into());
            }
            let mut cancelled_sent = false;
            loop {
                match rx.recv().await {
                    Some(Frame::Ev { event, .. }) => {
                        if !on_event(event) && !cancelled_sent {
                            cancelled_sent = true;
                            self.send_cancel(id).await;
                        }
                    }
                    Some(Frame::Ok { value, .. }) => return Ok(value),
                    Some(Frame::Err { error, .. }) => return Err(error),
                    Some(Frame::Log { .. }) => continue,
                    None => return Err("NFS 插件进程已退出".into()),
                }
            }
        }
    }

    /// NfsBackend 包装：持有宿主 Arc，把契约方法映射为线协议 op
    pub struct Sidecar(pub Arc<SidecarHost>);

    #[async_trait]
    impl NfsBackend for Sidecar {
        async fn list_dir(&self, path: String) -> Result<Vec<FileEntry>, String> {
            let v = self.0.call(Op::ListDir { path }, None, |_| true).await?;
            value_to::<Vec<NfsEntry>>(v)
                .map(|entries| entries.into_iter().map(entry_to_file_entry).collect())
        }

        async fn stat_path(&self, path: String) -> Result<String, String> {
            value_to_string(self.0.call(Op::StatPath { path }, None, |_| true).await?)
        }

        async fn download(
            &self,
            path: String,
            temp_dir: &Path,
            cb: &mut (dyn FnMut(u64, u64) + Send),
        ) -> Result<String, String> {
            let temp = temp_dir.to_string_lossy().into_owned();
            let v = self
                .0
                .call(
                    Op::Download { path, temp_dir: temp },
                    None,
                    |ev| {
                        if let XferEvent::Bytes { done, total } = ev {
                            cb(done, total);
                        }
                        true
                    },
                )
                .await?;
            value_to_string(v)
        }

        async fn download_plan(
            &self,
            path: String,
            cancelled: Arc<AtomicBool>,
        ) -> Result<TransferPlan, String> {
            let v = self
                .0
                .call(Op::DownloadPlan { path }, Some(cancelled), |_| true)
                .await?;
            value_to(v)
        }

        async fn download_to(
            &self,
            local_dir: String,
            path: String,
            overwrite: bool,
            cb: XferCb<'_>,
        ) -> Result<String, String> {
            let v = self
                .0
                .call(
                    Op::DownloadTo { local_dir, path, overwrite },
                    None,
                    move |ev| cb(ev),
                )
                .await?;
            value_to_string(v)
        }

        async fn upload_path(
            &self,
            local: String,
            remote_dir: String,
            name: String,
            cb: XferCb<'_>,
        ) -> Result<String, String> {
            let v = self
                .0
                .call(Op::UploadPath { local, remote_dir, name }, None, move |ev| cb(ev))
                .await?;
            value_to_string(v)
        }

        async fn mkdir(&self, remote_dir: String, name: String) -> Result<String, String> {
            value_to_string(self.0.call(Op::Mkdir { remote_dir, name }, None, |_| true).await?)
        }

        async fn create_file(&self, remote_dir: String, name: String) -> Result<String, String> {
            value_to_string(
                self.0
                    .call(Op::CreateFile { remote_dir, name }, None, |_| true)
                    .await?,
            )
        }

        async fn delete_entries(&self, paths: Vec<String>) -> Result<(), String> {
            self.0.call(Op::DeleteEntries { paths }, None, |_| true).await?;
            Ok(())
        }

        async fn rename_entry(&self, old_path: String, new_name: String) -> Result<String, String> {
            value_to_string(
                self.0
                    .call(Op::RenameEntry { old_path, new_name }, None, |_| true)
                    .await?,
            )
        }
    }
}

// ==================== Unavailable（两者皆未编译） ====================

#[cfg(not(any(feature = "nfs", feature = "nfs-sidecar")))]
struct Unavailable;

#[cfg(not(any(feature = "nfs", feature = "nfs-sidecar")))]
const UNAVAILABLE_ERR: &str = "NFS 功能未编译且未安装插件";

#[cfg(not(any(feature = "nfs", feature = "nfs-sidecar")))]
#[async_trait]
impl NfsBackend for Unavailable {
    async fn list_dir(&self, _path: String) -> Result<Vec<FileEntry>, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn stat_path(&self, _path: String) -> Result<String, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn download(
        &self,
        _path: String,
        _temp_dir: &Path,
        _cb: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<String, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn download_plan(
        &self,
        _path: String,
        _cancelled: Arc<AtomicBool>,
    ) -> Result<TransferPlan, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn download_to(
        &self,
        _local_dir: String,
        _path: String,
        _overwrite: bool,
        _cb: XferCb<'_>,
    ) -> Result<String, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn upload_path(
        &self,
        _local: String,
        _remote_dir: String,
        _name: String,
        _cb: XferCb<'_>,
    ) -> Result<String, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn mkdir(&self, _remote_dir: String, _name: String) -> Result<String, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn create_file(&self, _remote_dir: String, _name: String) -> Result<String, String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn delete_entries(&self, _paths: Vec<String>) -> Result<(), String> {
        Err(UNAVAILABLE_ERR.into())
    }
    async fn rename_entry(&self, _old_path: String, _new_name: String) -> Result<String, String> {
        Err(UNAVAILABLE_ERR.into())
    }
}

// ==================== 统一句柄（lib.rs 唯一入口） ====================

/// NFS 后端句柄：AppState 持有，tauri setup 阶段 [`NfsHandle::init`] 一次定型。
/// 方法在未初始化（测试/极早调用）时返回统一错误，不 panic。
pub struct NfsHandle {
    backend: std::sync::OnceLock<Box<dyn NfsBackend>>,
}

impl Default for NfsHandle {
    fn default() -> Self {
        Self { backend: std::sync::OnceLock::new() }
    }
}

impl NfsHandle {
    /// 决定后端形态：InProcess（feature = "nfs"）> Sidecar > Unavailable。
    /// Sidecar 需插件安装根以定位已装插件；Unavailable 仅占位报错。
    pub fn init(&self, plugins_root: Option<PathBuf>) {
        let backend: Box<dyn NfsBackend> = self.select_backend(plugins_root);
        let _ = self.backend.set(backend);
    }

    #[cfg(feature = "nfs")]
    fn select_backend(&self, _plugins_root: Option<PathBuf>) -> Box<dyn NfsBackend> {
        Box::new(InProcess::new())
    }

    #[cfg(all(not(feature = "nfs"), feature = "nfs-sidecar"))]
    fn select_backend(&self, plugins_root: Option<PathBuf>) -> Box<dyn NfsBackend> {
        let host = sidecar::SidecarHost::new_arc();
        if let Some(root) = plugins_root {
            host.set_plugins_root(root);
        }
        Box::new(sidecar::Sidecar(host))
    }

    #[cfg(not(any(feature = "nfs", feature = "nfs-sidecar")))]
    fn select_backend(&self, _plugins_root: Option<PathBuf>) -> Box<dyn NfsBackend> {
        Box::new(Unavailable)
    }

    fn get(&self) -> Result<&dyn NfsBackend, String> {
        self.backend
            .get()
            .map(|b| &**b)
            .ok_or_else(|| "NFS 后端未初始化".to_string())
    }

    pub async fn list_dir(&self, path: String) -> Result<Vec<FileEntry>, String> {
        self.get()?.list_dir(path).await
    }

    pub async fn stat_path(&self, path: String) -> Result<String, String> {
        self.get()?.stat_path(path).await
    }

    pub async fn download(
        &self,
        path: String,
        temp_dir: &Path,
        cb: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<String, String> {
        self.get()?.download(path, temp_dir, cb).await
    }

    pub async fn download_plan(
        &self,
        path: String,
        cancelled: Arc<AtomicBool>,
    ) -> Result<TransferPlan, String> {
        self.get()?.download_plan(path, cancelled).await
    }

    pub async fn download_to(
        &self,
        local_dir: String,
        path: String,
        overwrite: bool,
        cb: XferCb<'_>,
    ) -> Result<String, String> {
        self.get()?.download_to(local_dir, path, overwrite, cb).await
    }

    pub async fn upload_path(
        &self,
        local: String,
        remote_dir: String,
        name: String,
        cb: XferCb<'_>,
    ) -> Result<String, String> {
        self.get()?.upload_path(local, remote_dir, name, cb).await
    }

    pub async fn mkdir(&self, remote_dir: String, name: String) -> Result<String, String> {
        self.get()?.mkdir(remote_dir, name).await
    }

    pub async fn create_file(&self, remote_dir: String, name: String) -> Result<String, String> {
        self.get()?.create_file(remote_dir, name).await
    }

    pub async fn delete_entries(&self, paths: Vec<String>) -> Result<(), String> {
        self.get()?.delete_entries(paths).await
    }

    pub async fn rename_entry(&self, old_path: String, new_name: String) -> Result<String, String> {
        self.get()?.rename_entry(old_path, new_name).await
    }
}
