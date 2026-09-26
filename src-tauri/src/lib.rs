mod clipboard;
mod compress;
mod diff;
mod find;
mod fs_ops;
mod ops;
mod progress;
mod search;
mod sizestat;
mod volumes;

#[cfg(feature = "sftp")]
mod sftp;

mod opener;
mod plugins;
mod http_autoindex;
#[cfg(feature = "share")]
mod share;

use find::FindEntry;
use fs_ops::FileEntry;
use search::SearchMatch;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use volumes::{QuickAccessItem, VolumeInfo};

/// 应用全局状态
#[derive(Default)]
pub struct AppState {
    /// SFTP 会话池（内置插件，feature = "sftp" 编译期门控，可随时拔出）
    #[cfg(feature = "sftp")]
    pub sftp_pool: tokio::sync::Mutex<sftp::pool::SessionPool>,
    /// master-key（AES-256-GCM 加密保存密码用）：仅内存、不落盘；会话期间复用
    #[cfg(feature = "sftp")]
    pub master_key: tokio::sync::Mutex<Option<Vec<u8>>>,
    /// 插件注册表启用状态（v0.5，plugins.json 持久化）
    pub plugins: plugins::PluginState,
    /// 目录大小统计的取消标记（id → flag，右键「属性」用）
    pub size_cancels: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
    >,
    /// 差异比对的取消标记（id → flag，v0.18 差异比对窗口用）
    pub diff_cancels: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
    >,
    /// 窗口分享管理器（v0.7，feature = "share"）
    #[cfg(feature = "share")]
    pub share: share::ShareState,
}

// ==================== 后端能力抽象（v0.18 同步比对） ====================

/// 后端分类（按路径前缀）。新后端（S3/网盘等）接入点：
/// ① 增加分类臂 ② 在 [`BackendKind::caps`] 注册能力 ③ 在 [`list_side`] 提供 list 分支。
/// 比对内核（diff::compare_entries）与同步浏览/面板 UI 对后端无感知。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendKind {
    Local,
    Sftp,
    Http,
}

/// 后端能力声明
#[derive(Clone, Copy, Debug)]
struct BackendCaps {
    /// 参与比对的最大层级：1 名称 / 2 +大小 / 3 +hash（hash 需本地文件读取，仅 Local 为 3）
    max_diff_level: u8,
    /// 是否支持创建目录（同步浏览「在对侧新建并进入」按钮的门控）
    can_mkdir: bool,
}

impl BackendKind {
    fn classify(path: &str) -> Self {
        if path.starts_with("sftp://") {
            BackendKind::Sftp
        } else if path.starts_with("http://") || path.starts_with("https://") {
            BackendKind::Http
        } else {
            BackendKind::Local
        }
    }

    fn caps(self) -> BackendCaps {
        match self {
            BackendKind::Local => BackendCaps { max_diff_level: 3, can_mkdir: true },
            BackendKind::Sftp => BackendCaps { max_diff_level: 2, can_mkdir: true },
            BackendKind::Http => BackendCaps { max_diff_level: 1, can_mkdir: false },
        }
    }
}

/// 列目录的统一后端调度：`list_dir` 命令与 `diff_dirs` 共用，
/// 「哪些后端能列目录」只有这一个权威答案。
async fn list_side(
    state: &tauri::State<'_, AppState>,
    path: &str,
) -> Result<Vec<FileEntry>, String> {
    if path.starts_with("sftp://") {
        if !plugins::plugin_enabled(&state.plugins, "sftp") {
            return Err("SFTP 插件已禁用（设置 → 插件中可重新启用）".into());
        }
        #[cfg(feature = "sftp")]
        {
            let pool = state.sftp_pool.lock().await;
            return sftp::list_dir(&pool, path).await;
        }
        #[cfg(not(feature = "sftp"))]
        return Err("SFTP 插件未编译（该构建已拔出远程功能）".into());
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        if !plugins::plugin_enabled(&state.plugins, "http") {
            return Err("HTTP autoindex 插件已禁用（设置 → 插件中可重新启用）".into());
        }
        let url = path.to_string();
        return tauri::async_runtime::spawn_blocking(move || http_autoindex::list_http_dir(&url))
            .await
            .map_err(|e| format!("HTTP 请求任务失败：{e}"))?;
    }
    let p = path.to_string();
    tauri::async_runtime::spawn_blocking(move || fs_ops::list_dir(&p))
        .await
        .map_err(|e| e.to_string())?
}

/// 列出目录内容（目录优先、名称排序）。
/// 本地路径走 fs_ops；sftp:// 前缀路由到 SFTP 插件。
#[tauri::command]
async fn list_dir(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    list_side(&state, &path).await
}

/// 条目类型探测：返回 "dir" / "file" / "symlink"（标签/远程虚拟目录双击跳转用）。
#[tauri::command]
async fn stat_path(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    if path.starts_with("sftp://") {
        if !plugins::plugin_enabled(&state.plugins, "sftp") {
            return Err("SFTP 插件已禁用（设置 → 插件中可重新启用）".into());
        }
        #[cfg(feature = "sftp")]
        {
            let pool = state.sftp_pool.lock().await;
            return sftp::stat_path(&pool, &path).await;
        }
        #[cfg(not(feature = "sftp"))]
        return Err("SFTP 插件未编译".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            Ok("dir".to_string())
        } else if meta.file_type().is_symlink() {
            Ok("symlink".to_string())
        } else {
            Ok("file".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 批量条目类型探测：返回与输入等长的 kind 列表（"dir"/"file"/"symlink"/"missing"）。
/// 标签视图等批量场景一次 IPC 完成，避免逐条 stat_path 往返。
#[tauri::command]
async fn stat_paths(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|p| match std::fs::metadata(&p) {
                Ok(m) if m.is_dir() => "dir".to_string(),
                Ok(m) if m.file_type().is_symlink() => "symlink".to_string(),
                Ok(_) => "file".to_string(),
                Err(_) => "missing".to_string(),
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

// ==================== 插件注册表命令（v0.5） ====================

/// 校验插件启用状态（返回 Err 时插件已禁用）。仅 SFTP 命令使用。
#[cfg(feature = "sftp")]
fn ensure_plugin(state: &AppState, id: &str) -> Result<(), String> {
    if plugins::plugin_enabled(&state.plugins, id) {
        Ok(())
    } else {
        Err(format!("插件已禁用（设置 → 插件中可重新启用）：{id}"))
    }
}

/// 插件清单（内置插件注册表 + 启用状态）
#[tauri::command]
fn list_plugins(state: tauri::State<'_, AppState>) -> Vec<plugins::PluginInfo> {
    let map = state.plugins.enabled.lock().unwrap().clone();
    plugins::builtin_plugins(&map)
}

/// 启用 / 禁用插件并持久化；返回最新清单
#[tauri::command]
fn set_plugin_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<Vec<plugins::PluginInfo>, String> {
    plugins::set_enabled(&state.plugins, &id, enabled);
    let file = plugins::to_file(&state.plugins);
    plugins::save_file(&app, &file)?;
    let map = state.plugins.enabled.lock().unwrap().clone();
    Ok(plugins::builtin_plugins(&map))
}

// ==================== SFTP 插件命令（feature = "sftp"） ====================

#[cfg(feature = "sftp")]
fn sftp_servers_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join(sftp::servers::SERVERS_FILE))
}

/// 服务器清单
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_list_servers(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sftp::ServerView>, String> {
    ensure_plugin(&state, "sftp")?;
    let path = sftp_servers_path(&app)?;
    let file = sftp::servers::load_file(&path);
    let pool = state.sftp_pool.lock().await;
    Ok(file.servers.iter().map(|s| sftp::to_view(s, &pool)).collect())
}

/// 保存（新增或更新）服务器；返回最新清单。
/// 勾选"记住密码"时用 master-key 加密存储（未设置 master-key 返回 NEED_MASTER_KEY）。
/// 编辑已有服务器时，密码/口令/密钥留空 = 保留原值（不覆盖）。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_save_server(
    app: tauri::AppHandle,
    mut server: sftp::servers::ServerConfigFile,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sftp::ServerView>, String> {
    ensure_plugin(&state, "sftp")?;
    use sftp::servers::AuthConfig;
    let path = sftp_servers_path(&app)?;
    let mut file = sftp::servers::load_file(&path);
    let id = sftp::servers::server_id(&server.user, &server.host, server.port);
    // 编辑保留：已存在服务器且对应字段留空 → 沿用旧值（密文原样保留）
    if let Some(old) = file.servers.iter().find(|s| s.id == id) {
        match (&mut server.auth, &old.auth) {
            (AuthConfig::Password { password, .. }, AuthConfig::Password { password: old_pw, .. }) => {
                if password.is_empty() {
                    *password = old_pw.clone();
                }
            }
            (
                AuthConfig::PublicKey { key_path, passphrase, save_passphrase },
                AuthConfig::PublicKey { key_path: old_kp, passphrase: old_pp, .. },
            ) => {
                if key_path.is_empty() {
                    *key_path = old_kp.clone();
                }
                if passphrase.is_none() && *save_passphrase {
                    *passphrase = old_pp.clone();
                }
            }
            _ => {}
        }
    }
    // 需要落盘的密码/口令 → 用 master-key 加密
    match &mut server.auth {
        AuthConfig::Password { password, save_password } => {
            if *save_password && !password.is_empty() && !password.starts_with(sftp::servers::ENC_PREFIX) {
                let mk = state.master_key.lock().await;
                let Some(key) = mk.as_deref() else {
                    return Err("NEED_MASTER_KEY: 需要先设置主密钥（用于加密保存的密码）".into());
                };
                *password = sftp::servers::encrypt_password(key, password)?;
            }
        }
        AuthConfig::PublicKey { passphrase, save_passphrase, .. } => {
            if *save_passphrase {
                if let Some(p) = passphrase.as_deref() {
                    if !p.is_empty() && !p.starts_with(sftp::servers::ENC_PREFIX) {
                        let mk = state.master_key.lock().await;
                        let Some(key) = mk.as_deref() else {
                            return Err("NEED_MASTER_KEY: 需要先设置主密钥（用于加密保存的口令）".into());
                        };
                        *passphrase = Some(sftp::servers::encrypt_password(key, p)?);
                    }
                }
            }
        }
    }
    if let Some(existing) = file.servers.iter_mut().find(|s| s.id == id) {
        *existing = server;
    } else {
        file.servers.push(server);
    }
    sftp::servers::save_file(&path, &file)?;
    let pool = state.sftp_pool.lock().await;
    Ok(file.servers.iter().map(|s| sftp::to_view(s, &pool)).collect())
}

/// 删除服务器配置（连接不断开）
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_remove_server(
    app: tauri::AppHandle,
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sftp::ServerView>, String> {
    ensure_plugin(&state, "sftp")?;
    let path = sftp_servers_path(&app)?;
    let mut file = sftp::servers::load_file(&path);
    file.servers.retain(|s| s.id != id);
    sftp::servers::save_file(&path, &file)?;
    let pool = state.sftp_pool.lock().await;
    Ok(file.servers.iter().map(|s| sftp::to_view(s, &pool)).collect())
}

/// master-key 状态：是否设置过（有校验值）+ 当前内存是否已输入
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_master_key_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<sftp::MasterKeyStatus, String> {
    let path = sftp_servers_path(&app)?;
    let file = sftp::servers::load_file(&path);
    let configured = file.master_key_check.is_some();
    let active = state.master_key.lock().await.is_some();
    Ok(sftp::MasterKeyStatus { configured, active })
}

/// 设置 master-key（仅内存）。首次设置写入校验值；已设置则校验输入是否匹配。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_set_master_key(
    app: tauri::AppHandle,
    key: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("主密钥不能为空".into());
    }
    let path = sftp_servers_path(&app)?;
    let mut file = sftp::servers::load_file(&path);
    if let Some(check) = &file.master_key_check {
        if *check != sftp::servers::master_key_check(key.as_bytes()) {
            return Err("主密钥不正确".into());
        }
    } else {
        file.master_key_check = Some(sftp::servers::master_key_check(key.as_bytes()));
        sftp::servers::save_file(&path, &file)?;
    }
    *state.master_key.lock().await = Some(key.into_bytes());
    Ok(())
}

/// 重置主密钥：清除校验值和所有已加密密码（密钥连接不受影响）。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_reset_master_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let path = sftp_servers_path(&app)?;
    let mut file = sftp::servers::load_file(&path);
    file.master_key_check = None;
    // 清空所有 enc:v1: 开头的密码（无法解密的密文）
    for srv in file.servers.iter_mut() {
        if let sftp::servers::AuthConfig::Password { password, save_password, .. } = &mut srv.auth {
            if password.starts_with(sftp::servers::ENC_PREFIX) {
                password.clear();
                *save_password = false;
            }
        }
    }
    *state.master_key.lock().await = None;
    sftp::servers::save_file(&path, &file)?;
    Ok(())
}

/// 连接服务器（密码/密钥认证；存盘的加密密码在此时用 master-key 解密）。
/// 密码/口令/密钥留空时回退到 servers.json 中已保存的配置（供"断开后一键重连"）。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut server: sftp::servers::ServerConfigFile,
) -> Result<sftp::ServerView, String> {
    ensure_plugin(&state, "sftp")?;
    // 回退到已保存配置：host 留空 = 只传 id（会话恢复），整条回退存盘配置；
    // 字段留空 → 用存盘值（可能为 enc: 密文，下方统一解密）
    let path = sftp_servers_path(&app)?;
    let file = sftp::servers::load_file(&path);
    if let Some(stored) = file.servers.iter().find(|s| s.id == server.id) {
        if server.host.is_empty() {
            server = stored.clone();
        } else {
            match (&mut server.auth, &stored.auth) {
            (
                sftp::servers::AuthConfig::Password { password, .. },
                sftp::servers::AuthConfig::Password { password: sp, .. },
            ) => {
                if password.is_empty() && !sp.is_empty() {
                    *password = sp.clone();
                }
            }
            (
                sftp::servers::AuthConfig::PublicKey { key_path, passphrase, .. },
                sftp::servers::AuthConfig::PublicKey {
                    key_path: skp,
                    passphrase: spp,
                    ..
                },
            ) => {
                if key_path.is_empty() {
                    *key_path = skp.clone();
                }
                if passphrase.is_none() {
                    *passphrase = spp.clone();
                }
            }
            _ => {}
        }
        }
    }
    // 密文密码 → 用 master-key 解密（内存无 key 时要求先输入）
    match &mut server.auth {
        sftp::servers::AuthConfig::Password { password, .. } => {
            if password.starts_with(sftp::servers::ENC_PREFIX) {
                let mk = state.master_key.lock().await;
                let Some(key) = mk.as_deref() else {
                    return Err("NEED_MASTER_KEY: 需要输入主密钥以解密已保存的密码".into());
                };
                *password = sftp::servers::decrypt_password(key, password)?;
            }
        }
        sftp::servers::AuthConfig::PublicKey { passphrase, .. } => {
            if let Some(p) = passphrase.as_deref() {
                if p.starts_with(sftp::servers::ENC_PREFIX) {
                    let mk = state.master_key.lock().await;
                    let Some(key) = mk.as_deref() else {
                        return Err("NEED_MASTER_KEY: 需要输入主密钥以解密已保存的口令".into());
                    };
                    *passphrase = Some(sftp::servers::decrypt_password(key, p)?);
                }
            }
        }
    }
    let cfg = sftp::to_server_config(
        &server.user,
        &server.host,
        server.port,
        server.root.clone(),
        &server.auth,
    );
    let mut pool = state.sftp_pool.lock().await;
    sftp::connect_and_store(&mut pool, &cfg).await?;
    Ok(sftp::to_view(&server, &pool))
}

/// 断开服务器连接
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_disconnect(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    ensure_plugin(&state, "sftp")?;
    let mut pool = state.sftp_pool.lock().await;
    pool.remove(&id);
    Ok(())
}

// ==================== 会话保存 / 恢复（v0.3.0） ====================

/// 单个窗格的会话快照：只存路径与类型标识，SFTP 仅存 serverId，不含任何凭据
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionPane {
    pub id: u32,
    pub path: String,
    /// "local" | "sftp" | "tag"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_id: Option<String>,
}

/// 标签页快照：分屏树原样 JSON 保存（root），窗格明细在 panes
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: u32,
    pub title: String,
    /// 用户自定义标签页名（右键「重命名」）；缺省时前端回落自动标题
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    pub active_pane: u32,
    pub root: serde_json::Value,
    pub panes: Vec<SessionPane>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLayout {
    pub version: u32,
    pub saved_at: String,
    pub active_tab: usize,
    pub tabs: Vec<SessionTab>,
}

fn session_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join("session.json"))
}

/// 保存会话布局（原子写：先写临时文件再改名）
#[tauri::command]
async fn session_save(app: tauri::AppHandle, layout: SessionLayout) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = session_path(&app)?;
        let json = serde_json::to_string_pretty(&layout).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("写入会话失败：{e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("保存会话失败：{e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取最近一次会话；无会话文件返回 None
#[tauri::command]
async fn session_load(app: tauri::AppHandle) -> Result<Option<SessionLayout>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = session_path(&app)?;
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取会话失败：{e}"))?;
        serde_json::from_str(&raw).map(Some).map_err(|e| format!("解析会话失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==================== 偏好持久化（v0.14：标签配置可靠落盘） ====================

/// prefs.json 存标签重命名/文件标签/快捷访问，与 session.json 同级；
/// 作为 WebView localStorage 的可靠备份（避免本地存储被清空导致配置丢失）。
fn prefs_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join("prefs.json"))
}

/// 读取偏好文件；不存在时返回空对象
#[tauri::command]
async fn prefs_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = prefs_path(&app)?;
        if !path.exists() {
            return Ok(serde_json::Value::Object(serde_json::Map::new()));
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败：{e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("解析配置失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存偏好文件（原子写：先写临时文件再改名）
#[tauri::command]
async fn prefs_save(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = prefs_path(&app)?;
        let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("写入配置失败：{e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("保存配置失败：{e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==================== 目录大小统计（v0.16：右键「属性」） ====================

/// 递归统计路径集合的大小/文件数/目录数，进度走 "size-progress" 事件。
#[tauri::command]
async fn compute_size(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    paths: Vec<String>,
) -> Result<sizestat::SizeStat, String> {
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .size_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_for_task = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        sizestat::compute(&id_for_task, &paths, &flag, |p| {
            let _ = app.emit("size-progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string());
    state.size_cancels.lock().unwrap().remove(&id);
    result
}

/// 取消进行中的大小统计（关闭属性弹窗时调用）。
#[tauri::command]
fn cancel_size(state: tauri::State<'_, AppState>, id: String) {
    if let Some(flag) = state.size_cancels.lock().unwrap().get(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

// ==================== 目录差异比对（v0.17） ====================

/// 比对两个目录（顶层）：level 1 名称 / 2 大小 / 3 hash+时间戳。
/// v0.18：左右路径按 [`BackendKind`] 能力钳制层级——任一侧非本地时 level ≤ 2 且不进 hash
/// 阶段（远程无内容读取通道）；条目统一经 [`list_side`] 获取，本地/SFTP 两侧可任意组合。
/// 进度走 "diff-progress" 事件；可通过 `cancel_diff(id)` 中途停止。
#[tauri::command]
async fn diff_dirs(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    left: String,
    right: String,
    level: u8,
    case_sensitive: bool,
    mtime_tolerance_ms: i64,
) -> Result<diff::DiffOutcome, String> {
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .diff_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_for_task = id.clone();
    // 能力钳制：面板/模态窗请求的层级不得超过两侧后端的能力上限
    let level = level
        .min(BackendKind::classify(&left).caps().max_diff_level)
        .min(BackendKind::classify(&right).caps().max_diff_level)
        .max(1);
    let opts = diff::DiffOptions {
        level,
        case_sensitive,
        mtime_tolerance_ms,
    };
    // 两侧串行列目录（同主机的 SFTP 会话本就由 pool 互斥）
    let l = list_side(&state, &left).await?;
    let r = list_side(&state, &right).await?;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        diff::compare_entries(&id_for_task, l, r, &opts, &flag, |p| {
            let _ = app.emit("diff-progress", p);
        })
    })
    .await;
    state.diff_cancels.lock().unwrap().remove(&id);
    joined.map_err(|e| e.to_string())?
}

/// 取消进行中的差异比对（点「停止」或关闭窗口时调用）。
#[tauri::command]
fn cancel_diff(state: tauri::State<'_, AppState>, id: String) {
    if let Some(flag) = state.diff_cancels.lock().unwrap().get(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 读取单个路径的元信息（「属性」统计当前目录用）。
#[tauri::command]
fn stat_entry(path: String) -> Result<fs_ops::FileEntry, String> {
    fs_ops::stat_entry(&path)
}

/// 下载远程文件到临时目录，返回本地路径（供打开）
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    ensure_plugin(&state, "sftp")?;
    let pool = state.sftp_pool.lock().await;
    sftp::download(&pool, &path, |done, total| {
        let mut p = progress::TransferProgress::start("download", "下载中…", 1);
        p.file_done = done;
        p.file_total = total;
        progress::emit(&app, &p);
    })
    .await
}

/// 下载远程文件到指定本地目录（粘贴/拖拽 远程→本地），返回本地路径
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_download_to(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    local_dir: String,
    path: String,
) -> Result<String, String> {
    ensure_plugin(&state, "sftp")?;
    let pool = state.sftp_pool.lock().await;
    sftp::download_to(&pool, &local_dir, &path, |done, total| {
        let mut p = progress::TransferProgress::start("download", "下载中…", 1);
        p.file_done = done;
        p.file_total = total;
        progress::emit(&app, &p);
    })
    .await
}

/// 上传本地文件到远程目录（拖拽/复制）
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    local: String,
    dest: String,
    name: String,
) -> Result<String, String> {
    ensure_plugin(&state, "sftp")?;
    let pool = state.sftp_pool.lock().await;
    sftp::upload(&pool, &local, &dest, &name, |done, total| {
        let mut p = progress::TransferProgress::start("upload", "上传中…", 1);
        p.file_done = done;
        p.file_total = total;
        progress::emit(&app, &p);
    })
    .await
}

/// 远程新建目录
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_mkdir(
    state: tauri::State<'_, AppState>,
    dir: String,
    name: String,
) -> Result<String, String> {
    ensure_plugin(&state, "sftp")?;
    let pool = state.sftp_pool.lock().await;
    sftp::mkdir(&pool, &dir, &name).await
}

/// 远程新建空文件
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_create_file(
    state: tauri::State<'_, AppState>,
    dir: String,
    name: String,
) -> Result<String, String> {
    ensure_plugin(&state, "sftp")?;
    let pool = state.sftp_pool.lock().await;
    sftp::create_file(&pool, &dir, &name).await
}

/// 远程删除（目录仅空目录；文件直接删除）
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_delete(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    ensure_plugin(&state, "sftp")?;
    let pool = state.sftp_pool.lock().await;
    sftp::delete_entries(&pool, &paths).await
}

/// 远程重命名
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_rename(
    state: tauri::State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    ensure_plugin(&state, "sftp")?;
    let pool = state.sftp_pool.lock().await;
    sftp::rename_entry(&pool, &path, &new_name).await
}

/// 目录路径补全。
#[tauri::command]
fn complete_path(input: String, cwd: String) -> Vec<String> {
    fs_ops::complete_path(&input, &cwd)
}

/// 地址栏输入解析：展开 "~"（主目录）与相对路径为绝对路径（v0.18）。
#[tauri::command]
fn resolve_path(input: String, cwd: String) -> String {
    fs_ops::resolve_path(&input, &cwd)
}

/// 枚举磁盘/卷。
#[tauri::command]
fn get_volumes() -> Vec<VolumeInfo> {
    volumes::list_volumes()
}

/// 快速访问目录（主目录、桌面、文档、下载、图片、音乐、影片）。
#[tauri::command]
fn get_quick_access() -> Vec<QuickAccessItem> {
    volumes::quick_access()
}

/// 获取当前用户主目录。
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取主目录".to_string())
}

/// 返回父目录；已是根目录时返回自身。
#[tauri::command]
fn parent_dir(path: String) -> Result<String, String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        return Ok(http_autoindex::parent_http_url(&path).unwrap_or(path));
    }
    let p = std::path::Path::new(&path);
    match p.parent() {
        Some(parent) if parent.as_os_str() != p.as_os_str() => {
            Ok(parent.to_string_lossy().to_string())
        }
        _ => Ok(path),
    }
}

/// 复制条目到目标目录，返回实际创建路径（供撤销记录）。
#[tauri::command]
async fn copy_entries(app: tauri::AppHandle, paths: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let mut done_files = 0usize;
        let created = ops::copy_entries(&paths, &dest, &mut |file_done, file_total| {
            let mut p = progress::TransferProgress::start("copy", "复制中…", n);
            p.done_files = done_files;
            p.file_done = file_done;
            p.file_total = file_total;
            progress::emit(&app, &p);
        })?;
        done_files = n;
        progress::emit(
            &app,
            &progress::TransferProgress {
                phase: "copy".into(),
                label: "复制完成".into(),
                done_files,
                total_files: n,
                file_done: 0,
                file_total: 0,
                done: true,
                id: None,
            },
        );
        Ok(created)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 移动条目到目标目录，返回 (源, 目标) 路径对（供撤销记录）。
#[tauri::command]
async fn move_entries(app: tauri::AppHandle, paths: Vec<String>, dest: String) -> Result<Vec<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let mut done_files = 0usize;
        let moved = ops::move_entries(&paths, &dest, &mut |file_done, file_total| {
            let mut p = progress::TransferProgress::start("move", "移动中…", n);
            p.done_files = done_files;
            p.file_done = file_done;
            p.file_total = file_total;
            progress::emit(&app, &p);
        })?;
        done_files = n;
        progress::emit(
            &app,
            &progress::TransferProgress {
                phase: "move".into(),
                label: "移动完成".into(),
                done_files,
                total_files: n,
                file_done: 0,
                file_total: 0,
                done: true,
                id: None,
            },
        );
        Ok(moved)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 扫描复制/移动前需用户裁决的同名冲突（同名目录可合并，不返回冲突）。
#[tauri::command]
async fn scan_conflicts(paths: Vec<String>, dest: String) -> Result<Vec<ops::Conflict>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::scan_conflicts(&paths, &dest))
        .await
        .map_err(|e| e.to_string())?
}

/// 按冲突裁决表复制，返回实际创建路径（供撤销记录）。
#[tauri::command]
async fn copy_entries_plan(
    app: tauri::AppHandle,
    paths: Vec<String>,
    dest: String,
    resolutions: std::collections::HashMap<String, ops::Resolution>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let created = ops::copy_entries_plan(&paths, &dest, &resolutions, &mut |file_done, file_total| {
            let mut p = progress::TransferProgress::start("copy", "复制中…", n);
            p.file_done = file_done;
            p.file_total = file_total;
            progress::emit(&app, &p);
        })?;
        progress::emit(
            &app,
            &progress::TransferProgress {
                phase: "copy".into(),
                label: "复制完成".into(),
                done_files: n,
                total_files: n,
                file_done: 0,
                file_total: 0,
                done: true,
                id: None,
            },
        );
        Ok(created)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按冲突裁决表移动，返回 (源, 目标) 路径对（供撤销反向移动）。
#[tauri::command]
async fn move_entries_plan(
    app: tauri::AppHandle,
    paths: Vec<String>,
    dest: String,
    resolutions: std::collections::HashMap<String, ops::Resolution>,
) -> Result<Vec<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let moved = ops::move_entries_plan(&paths, &dest, &resolutions, &mut |file_done, file_total| {
            let mut p = progress::TransferProgress::start("move", "移动中…", n);
            p.file_done = file_done;
            p.file_total = file_total;
            progress::emit(&app, &p);
        })?;
        progress::emit(
            &app,
            &progress::TransferProgress {
                phase: "move".into(),
                label: "移动完成".into(),
                done_files: n,
                total_files: n,
                file_done: 0,
                file_total: 0,
                done: true,
                id: None,
            },
        );
        Ok(moved)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把文件列表写入系统剪贴板（跨应用复制）。
#[tauri::command]
fn clipboard_write_files(paths: Vec<String>) -> Result<(), String> {
    clipboard::write_file_list(&paths)
}

/// 从系统剪贴板读取文件列表（跨应用粘贴）。
#[tauri::command]
fn clipboard_read_files() -> Result<Vec<String>, String> {
    clipboard::read_file_list()
}

/// 重命名条目，返回新路径。
#[tauri::command]
async fn rename_entry(path: String, new_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::rename_entry(&path, &new_name))
        .await
        .map_err(|e| e.to_string())?
}

/// 删除条目（进回收站）。
#[tauri::command]
async fn delete_entries(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::delete_entries(&paths))
        .await
        .map_err(|e| e.to_string())?
}

/// 永久删除条目（绕过回收站）。
#[tauri::command]
async fn permanent_delete_entries(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::permanent_delete_entries(&paths))
        .await
        .map_err(|e| e.to_string())?
}

/// 新建文件夹。
#[tauri::command]
async fn create_dir(parent: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::create_dir(&parent, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// 新建空文件。
#[tauri::command]
async fn create_file(parent: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::create_file(&parent, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// 内容搜索（VSCode 风格，字面量关键词；默认仅当前层）。
#[tauri::command]
async fn search_content(
    query: String,
    dir: String,
    recursive: bool,
    case_sensitive: bool,
) -> Result<Vec<SearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search::search_content(&query, &dir, recursive, case_sensitive)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 快速文件检索（fd 语义：正则 + smart case + 递归）。
#[tauri::command]
async fn find_files(
    pattern: String,
    dir: String,
    show_hidden: bool,
    max_depth: Option<usize>,
) -> Result<Vec<FindEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        find::find_files(&pattern, &dir, show_hidden, max_depth)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Windows：显式设置进程 AppUserModelID，让任务栏把 R-Dir 当作独立应用
/// （正确分组 / 固定到任务栏 / 通知显示应用名，而非挂到 WebView2 或通用宿主名下）。
#[cfg(target_os = "windows")]
fn set_app_user_model_id(id: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "shell32")]
    extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
    }
    let wide: Vec<u16> = std::ffi::OsStr::new(id)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // 失败（旧系统 / 无 shell32）不影响功能，忽略返回值
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().manage(AppState::default());
    #[cfg(feature = "share")]
    {
        builder = builder.manage(share::ShareState::default());
    }
    builder = builder.setup(|app| {
            #[cfg(target_os = "windows")]
            set_app_user_model_id("com.rfm.app");
            let state = app.state::<AppState>();
            plugins::init(app.handle(), &state.plugins);
            Ok(())
        });
    // 注意：tauri Builder::invoke_handler 是“覆盖”语义（后调覆盖先调），
    // 因此所有命令必须合并到同一个 generate_handler! 中，用 cfg 属性按 feature 裁剪，
    // 否则 v0.7 独立 share 块会覆盖掉 sftp 块的全部命令（曾导致 list_dir/sftp 丢失）。
    builder = builder.invoke_handler(tauri::generate_handler![
        list_dir,
        complete_path,
        resolve_path,
        get_volumes,
        get_quick_access,
        get_home_dir,
        parent_dir,
        stat_path,
        stat_paths,
        copy_entries,
        move_entries,
        scan_conflicts,
        copy_entries_plan,
        move_entries_plan,
        clipboard_write_files,
        clipboard_read_files,
        rename_entry,
        delete_entries,
        permanent_delete_entries,
        create_dir,
        create_file,
        search_content,
        find_files,
        #[cfg(feature = "sftp")]
        sftp_list_servers,
        #[cfg(feature = "sftp")]
        sftp_save_server,
        #[cfg(feature = "sftp")]
        sftp_remove_server,
        #[cfg(feature = "sftp")]
        sftp_master_key_status,
        #[cfg(feature = "sftp")]
        sftp_set_master_key,
        #[cfg(feature = "sftp")]
        sftp_reset_master_key,
        #[cfg(feature = "sftp")]
        sftp_connect,
        #[cfg(feature = "sftp")]
        sftp_disconnect,
        #[cfg(feature = "sftp")]
        sftp_download,
        #[cfg(feature = "sftp")]
        sftp_download_to,
        #[cfg(feature = "sftp")]
        sftp_upload,
        #[cfg(feature = "sftp")]
        sftp_mkdir,
        #[cfg(feature = "sftp")]
        sftp_create_file,
        #[cfg(feature = "sftp")]
        sftp_delete,
        #[cfg(feature = "sftp")]
        sftp_rename,
        // v0.4 打开方式 / 终端插件
        opener::list_openers,
        opener::open_with,
        opener::add_custom_opener,
        opener::set_opener_extensions,
        opener::remove_custom_opener,
        opener::list_shells,
        opener::open_terminal,
        // 会话保存 / 恢复
        session_save,
        session_load,
        // 偏好持久化（v0.14）
        prefs_load,
        prefs_save,
        // 目录大小统计（v0.16）
        compute_size,
        cancel_size,
        // 目录差异比对（v0.17 / v0.18 进度与取消）
        diff_dirs,
        cancel_diff,
        stat_entry,
        // 插件注册表（v0.5）
        list_plugins,
        set_plugin_enabled,
        // HTTP autoindex 插件（v0.6）
        http_autoindex::http_download_to,
        http_autoindex::cancel_http_download,
        // 压缩（v0.8：zip / tar / tgz，仅打包）
        compress::compress_items,
        // 窗口分享插件（v0.7）
        #[cfg(feature = "share")]
        share::share_create,
        #[cfg(feature = "share")]
        share::share_list,
        #[cfg(feature = "share")]
        share::share_stop,
        #[cfg(feature = "share")]
        share::share_stop_by_dir
    ]);

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // v0.7：应用退出时停止所有分享服务
            if let tauri::RunEvent::Exit = event {
                #[cfg(feature = "share")]
                {
                    if let Some(share_state) = _app_handle.try_state::<share::ShareState>() {
                        share::shutdown_all(&share_state.manager);
                    }
                }
            }
        });
}

/// SFTP 插件集成测试：连接本机 SSH（127.0.0.1），密钥认证 + 列目录。
/// 运行：cargo test --features sftp -- --ignored --nocapture
#[cfg(all(test, feature = "sftp"))]
mod sftp_tests {
    use super::sftp;
    use sftp::session::{AuthMethod, ServerConfig};

    #[tokio::test]
    #[ignore]
    async fn connect_key_and_list_home() {
        let user = std::env::var("RDIR_TEST_USER").unwrap_or_else(|_| "vigil".into());
        // 探测常用私钥
        let home = dirs::home_dir().expect("home");
        let key_candidates = ["id_ed25519", "id_rsa", "id_ecdsa"];
        let mut key_path = None;
        for name in key_candidates {
            let p = home.join(".ssh").join(name);
            if p.exists() {
                key_path = Some(p.to_string_lossy().to_string());
                break;
            }
        }
        let auth = match key_path {
            Some(kp) => AuthMethod::PublicKey { key_path: kp, passphrase: None },
            None => {
                // 无密钥则尝试空密码（macOS 默认不允许，仅提示）
                AuthMethod::Password("".into())
            }
        };
        let cfg = ServerConfig {
            name: "127.0.0.1".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: user.clone(),
            auth,
            root: None,
            save_secret: false,
        };
        let mut sess = sftp::session::SftpSession::connect(&cfg)
            .await
            .expect("connect failed");
        let home_remote = sess.realpath(".").await.expect("realpath failed");
        println!("home remote: {home_remote}");
        let entries = sess.list_dir(&home_remote).await.expect("list_dir failed");
        println!("entries: {} (e.g. {:?})", entries.len(), entries.first().map(|(n, _)| n.clone()));
        assert!(!entries.is_empty(), "目录不应为空");
        sess.close().await;
    }

    #[tokio::test]
    #[ignore]
    async fn connect_password_auth() {
        let user = std::env::var("RDIR_TEST_USER").unwrap_or_else(|_| "vigil".into());
        let pw = std::env::var("RDIR_TEST_PASSWORD").ok();
        let Some(pw) = pw else {
            eprintln!("跳过密码测试：未设置 RDIR_TEST_PASSWORD");
            return;
        };
        let cfg = ServerConfig {
            name: "127.0.0.1".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user,
            auth: AuthMethod::Password(pw),
            root: None,
            save_secret: false,
        };
        let mut sess = sftp::session::SftpSession::connect(&cfg).await.expect("connect failed");
        let entries = sess.list_dir("/").await.expect("list_dir failed");
        println!("root entries: {}", entries.len());
        sess.close().await;
    }

    #[test]
    fn master_key_encrypt_roundtrip() {
        let key = b"my-master-key-123";
        let plain = "P@ssw0rd!";
        let enc = sftp::servers::encrypt_password(key, plain).expect("encrypt");
        assert!(enc.starts_with(sftp::servers::ENC_PREFIX), "应带密文前缀");
        // 每次加密 nonce 随机 → 两次密文不同
        let enc2 = sftp::servers::encrypt_password(key, plain).unwrap();
        assert_ne!(enc, enc2, "同密码两次加密结果应不同（随机 nonce）");
        // 正确 key 可解密
        assert_eq!(sftp::servers::decrypt_password(key, &enc).unwrap(), plain);
        // 错误 key 解密失败
        assert!(sftp::servers::decrypt_password(b"wrong-key", &enc).is_err());
        // 明文透传
        assert_eq!(sftp::servers::decrypt_password(key, "plain-secret").unwrap(), "plain-secret");
        // 校验值稳定且区分 key
        assert_eq!(sftp::servers::master_key_check(key), sftp::servers::master_key_check(key));
        assert_ne!(sftp::servers::master_key_check(key), sftp::servers::master_key_check(b"other-key"));
        // 校验值不包含密钥原文
        assert!(!sftp::servers::master_key_check(key).contains("my-master-key"));
    }

    #[test]
    fn servers_file_roundtrip_with_group() {
        use sftp::servers::{AuthConfig, ServerConfigFile, ServersFile};
        let dir = std::env::temp_dir().join(format!("rdir-servers-test-{}", std::process::id()));
        let path = dir.join("servers.json");
        let f = ServersFile {
            master_key_check: Some("deadbeef".into()),
            servers: vec![ServerConfigFile {
                id: "u@h:22".into(),
                name: "测试".into(),
                host: "h".into(),
                port: 22,
                user: "u".into(),
                root: None,
                group: "工作".into(),
                auth: AuthConfig::Password { password: "enc:v1:abc".into(), save_password: true },
            }],
        };
        sftp::servers::save_file(&path, &f).unwrap();
        let back = sftp::servers::load_file(&path);
        assert_eq!(back.master_key_check.as_deref(), Some("deadbeef"));
        assert_eq!(back.servers.len(), 1);
        assert_eq!(back.servers[0].group, "工作");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 模拟前端 ConnectDialog 的真实 payload（camelCase 字段），
    /// 覆盖 sftp_connect/sftp_save_server 的 JSON 反序列化层（此前集成测试绕过此层导致字段名 bug 漏网）
    #[test]
    fn auth_config_deserialize_frontend_payload() {
        use sftp::servers::{AuthConfig, ServerConfigFile};
        // 密码模式：auth=password + savePassword
        let json = r#"{"id":"u@h:22","name":"t","host":"h","port":22,"user":"u","root":null,"group":"","auth":"password","password":"pw","savePassword":true}"#;
        let cfg: ServerConfigFile = serde_json::from_str(json).expect("password payload");
        match &cfg.auth {
            AuthConfig::Password { password, save_password } => {
                assert_eq!(password, "pw");
                assert!(*save_password);
            }
            _ => panic!("应解析为 Password"),
        }
        // 公钥模式：auth=publicKey + keyPath + savePassphrase
        let json2 = r#"{"id":"u@h:22","name":"t","host":"h","port":22,"user":"u","root":null,"group":"","auth":"publicKey","keyPath":"/Users/vigil/.ssh/id_ed25519","passphrase":null,"savePassphrase":false}"#;
        let cfg2: ServerConfigFile = serde_json::from_str(json2).expect("publicKey payload");
        match &cfg2.auth {
            AuthConfig::PublicKey { key_path, passphrase, save_passphrase } => {
                assert_eq!(key_path, "/Users/vigil/.ssh/id_ed25519");
                assert!(passphrase.is_none());
                assert!(!*save_passphrase);
            }
            _ => panic!("应解析为 PublicKey"),
        }
        // 旧版 snake_case 存盘文件仍可读（alias 兼容）
        let old = r#"{"id":"u@h:22","name":"t","host":"h","port":22,"user":"u","root":null,"group":"","auth":"password","password":"pw","save_password":false}"#;
        let cfg3: ServerConfigFile = serde_json::from_str(old).expect("old snake_case payload");
        match &cfg3.auth {
            AuthConfig::Password { save_password, .. } => assert!(!*save_password),
            _ => panic!("应解析为 Password"),
        }
        // 序列化输出应为 camelCase（写入 servers.json 的新格式）
        let out = serde_json::to_value(&cfg2).unwrap();
        assert_eq!(out["auth"], "publicKey");
        assert_eq!(out["keyPath"], "/Users/vigil/.ssh/id_ed25519");
        assert_eq!(out["savePassphrase"], false);
    }

    /// 远程写操作全链路：mkdir → touch → upload → rename → download → remove → rmdir
    #[tokio::test]
    #[ignore]
    async fn remote_write_ops() {
        let user = std::env::var("RDIR_TEST_USER").unwrap_or_else(|_| "vigil".into());
        let cfg = ServerConfig {
            name: "127.0.0.1".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user,
            auth: AuthMethod::PublicKey { key_path: String::new(), passphrase: None },
            root: None,
            save_secret: false,
        };
        let mut sess = sftp::session::SftpSession::connect(&cfg).await.expect("connect failed");
        // 测试根：家目录下 .rdir-test-sftp（避免污染）
        let home = sess.realpath(".").await.expect("realpath home");
        let base = format!("{home}/.rdir-test-sftp");
        if sess.stat(&base).await.is_err() {
            sess.mkdir(&base).await.expect("mkdir base");
        }
        let dir = format!("{base}/write-test-{}", std::process::id());
        sess.mkdir(&dir).await.expect("mkdir");
        let f1 = format!("{dir}/hello.txt");
        sess.touch(&f1).await.expect("touch");
        let local = std::env::temp_dir().join(format!("rdir-upload-{}.txt", std::process::id()));
        std::fs::write(&local, "upload content 你好").unwrap();
        let remote2 = format!("{dir}/uploaded.txt");
        sess.upload(&local, &remote2, |_, _| {}).await.expect("upload");
        let renamed = format!("{dir}/renamed.txt");
        sess.rename(&f1, &renamed).await.expect("rename");
        let local2 = std::env::temp_dir().join(format!("rdir-download-{}.txt", std::process::id()));
        sess.download(&remote2, &local2, |_, _| {}).await.expect("download");
        let text = std::fs::read_to_string(&local2).expect("read local");
        assert_eq!(text, "upload content 你好", "上传/下载内容往返应一致");
        // 清理：文件 + 目录 + 本地临时
        sess.remove(&renamed).await.expect("remove renamed");
        sess.remove(&remote2).await.expect("remove uploaded");
        sess.rmdir(&dir).await.expect("rmdir");
        let _ = std::fs::remove_file(&local);
        let _ = std::fs::remove_file(&local2);
        println!("remote_write_ops OK（{dir} 已清理）");
    }
}

/// 会话快照序列化测试：自定义标签页名必须随 session.json 往返（回归 v0.17.2）
#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn session_tab_custom_title_roundtrip() {
        let tab = SessionTab {
            id: 1,
            title: "git".into(),
            custom_title: Some("我的标签".into()),
            active_pane: 1,
            root: serde_json::json!({ "type": "pane", "paneId": 1 }),
            panes: vec![],
        };
        let json = serde_json::to_string(&tab).unwrap();
        assert!(json.contains("customTitle"), "序列化应含 customTitle：{json}");
        let back: SessionTab = serde_json::from_str(&json).unwrap();
        assert_eq!(back.custom_title.as_deref(), Some("我的标签"));
    }

    #[test]
    fn session_tab_without_custom_title_omits_field() {
        let tab = SessionTab {
            id: 1,
            title: "git".into(),
            custom_title: None,
            active_pane: 1,
            root: serde_json::json!({}),
            panes: vec![],
        };
        let json = serde_json::to_string(&tab).unwrap();
        assert!(!json.contains("customTitle"), "无自定义名时不应输出字段：{json}");
    }
}

/// 后端能力抽象测试（v0.18 同步比对：SFTP 一/二层，未来 S3/网盘按能力表接入）
#[cfg(test)]
mod backend_tests {
    use super::*;

    #[test]
    fn classify_by_prefix() {
        assert_eq!(BackendKind::classify(r"F:\data"), BackendKind::Local);
        assert_eq!(BackendKind::classify("/home/u"), BackendKind::Local);
        assert_eq!(BackendKind::classify("sftp://u@h:22/remote"), BackendKind::Sftp);
        assert_eq!(BackendKind::classify("http://x/"), BackendKind::Http);
        assert_eq!(BackendKind::classify("https://x/"), BackendKind::Http);
    }

    #[test]
    fn caps_table() {
        assert_eq!(BackendKind::Local.caps().max_diff_level, 3);
        assert!(BackendKind::Local.caps().can_mkdir);
        assert_eq!(BackendKind::Sftp.caps().max_diff_level, 2);
        assert!(BackendKind::Sftp.caps().can_mkdir);
        assert_eq!(BackendKind::Http.caps().max_diff_level, 1);
        assert!(!BackendKind::Http.caps().can_mkdir);
    }

    #[test]
    fn diff_level_clamped_by_weakest_side() {
        // 请求层 3：任一侧 SFTP → 落到 2；HTTP → 落到 1；两侧本地保持 3
        let clamp = |l: BackendKind, r: BackendKind, req: u8| {
            req.min(l.caps().max_diff_level)
                .min(r.caps().max_diff_level)
                .max(1)
        };
        assert_eq!(clamp(BackendKind::Local, BackendKind::Sftp, 3), 2);
        assert_eq!(clamp(BackendKind::Sftp, BackendKind::Sftp, 3), 2);
        assert_eq!(clamp(BackendKind::Local, BackendKind::Http, 3), 1);
        assert_eq!(clamp(BackendKind::Local, BackendKind::Local, 3), 3);
    }
}
