mod clipboard;
mod cmdrun;
mod compress;
mod diff;
mod drag_out;
mod extract;
mod find;
mod fs_ops;
mod fs_watch;
mod iconpos;
mod json_store;
mod ops;
mod preview;
mod progress;
mod search;
mod sizestat;
mod text_diff;
mod thumbs;
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
    /// 本地复制/移动的取消标记（id → flag，id 随 transfer-progress 事件下发）
    pub transfer_cancels: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
    >,
    /// 地址栏命令：PATH 可执行扫描缓存（v0.22.0；Arc 供后台重建线程与启动预热共享，
    /// 重建不阻塞补全调用——见 cmdrun::ensure_fresh）
    pub cmd_cache: std::sync::Arc<std::sync::Mutex<cmdrun::ExecCache>>,
    /// v0.23 应用退出守卫：前端确认对话框放行后置位，下一次 ExitRequested 不再拦截
    pub exit_allowed: std::sync::atomic::AtomicBool,
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
/// 勾选"记住密码"时加密存储：已设置并解锁 master-key → AES-256-GCM 密文；
/// 未设置 → 明文原样存盘（v0.22.2 起首次创建不强制设置主密码，主密码只用于解锁
/// 既有密文；之后在 ⋮ 菜单设置主密钥时自动把明文回填加密）。
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
    // 需要落盘的密码/口令 → 有主密钥则加密，没有则明文存盘（不阻断首次创建）
    sftp::servers::seal_auth_secrets(&mut server.auth, state.master_key.lock().await.as_deref())?;
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

/// 批量设置服务器分组（侧边栏拖拽换组 / 分组整体重命名共用）。
/// 只动 group 字段，凭据与连接状态不受影响；返回最新清单。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_set_server_group(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    group: String,
) -> Result<Vec<sftp::ServerView>, String> {
    ensure_plugin(&state, "sftp")?;
    let path = sftp_servers_path(&app)?;
    let mut file = sftp::servers::load_file(&path);
    let mut changed = false;
    for srv in file.servers.iter_mut() {
        if ids.iter().any(|id| *id == srv.id) && srv.group != group {
            srv.group = group.clone();
            changed = true;
        }
    }
    if changed {
        sftp::servers::save_file(&path, &file)?;
    }
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

/// 设置 master-key（仅内存）。首次设置写入校验值，并把清单中已有的
/// 明文密码/口令回填加密（v0.22.2：首次创建不再强制设主密码，明文在此时升级为密文）；
/// 已设置则校验输入是否匹配。
///
/// v0.31.1：解锁分支同样回填——主密钥在内存里只活一个会话，重启后「记住密码」保存的
/// 服务器会以明文落盘；此前解锁只写内存不动文件，导出一直被「存在明文密码」拦住，
/// 用户按提示去菜单设了主密钥也「没生效」。
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
        if sftp::servers::encrypt_all_plaintext(&mut file, key.as_bytes())? > 0 {
            sftp::servers::save_file(&path, &file)?;
        }
    } else {
        file.master_key_check = Some(sftp::servers::master_key_check(key.as_bytes()));
        sftp::servers::encrypt_all_plaintext(&mut file, key.as_bytes())?;
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
        json_store::write_atomic(&path, &json, "写入会话失败", "保存会话失败")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取最近一次会话；无会话文件返回 None
#[tauri::command]
async fn session_load(app: tauri::AppHandle) -> Result<Option<SessionLayout>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = session_path(&app)?;
        json_store::read_json(&path, "读取会话失败", "解析会话失败")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 清除已保存会话（「不保存并退出」用）。前端自动保存会持续更新 session.json，
/// 不保存退出必须显式删除，下次启动才回到默认布局而非最近自动保存的状态。
#[tauri::command]
async fn session_clear(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = session_path(&app)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            // 本来就没有会话（首次启动后直接退出）视作已清除
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清除会话失败：{e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==================== 标签收藏夹（独立于会话保存的标签级快照） ====================

/// 标签收藏项。tab 为前端 SessionTab 快照原样 JSON 透传（zoom/viewMode/iconSize
/// 等前端字段不进 Rust 结构体，避免像 session_save 一样被未知字段丢弃）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabFavorite {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub tab: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoritesFile {
    pub version: u32,
    pub items: Vec<TabFavorite>,
}

fn favorites_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join("favorites.json"))
}

/// 读取收藏夹；无文件返回 None
#[tauri::command]
async fn favorites_load(app: tauri::AppHandle) -> Result<Option<FavoritesFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = favorites_path(&app)?;
        json_store::read_json(&path, "读取收藏夹失败", "解析收藏夹失败")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存收藏夹（整文件原子写：先写临时文件再改名）
#[tauri::command]
async fn favorites_save(app: tauri::AppHandle, items: Vec<TabFavorite>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = FavoritesFile {
            version: 1,
            items,
        };
        let path = favorites_path(&app)?;
        let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        json_store::write_atomic(&path, &json, "写入收藏夹失败", "保存收藏夹失败")
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
        Ok(
            json_store::read_json::<serde_json::Value>(&path, "读取配置失败", "解析配置失败")?
                .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new())),
        )
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
        json_store::write_atomic(&path, &json, "写入配置失败", "保存配置失败")
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

// ==================== v0.19 文本比较 ====================

/// 解析文本比较的一侧路径：本地直接用；SFTP/HTTP 先下载到临时目录（用完即删）。
/// 返回 (本地路径, 是否临时文件)。
async fn resolve_text_side(
    state: &tauri::State<'_, AppState>,
    path: &str,
) -> Result<(String, bool), String> {
    if path.starts_with("sftp://") {
        #[cfg(feature = "sftp")]
        {
            ensure_plugin(state, "sftp")?;
            let pool = state.sftp_pool.lock().await;
            let dir = std::env::temp_dir().join("r-dir-diff");
            // sftp::download_to 不建目录（与 sftp_download 的既有约定一致），这里必须自建，
            // 否则 File::create 报 os error 3「系统找不到指定的路径」
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
            // download_to 同名自动加后缀，避免两侧同名文件相互覆盖（文本比较只传单文件）
            let mut nocb = |_ev: sftp::XferEvent| true;
            let local = sftp::download_to(&pool, &dir.to_string_lossy(), path, false, &mut nocb)
                .await?;
            return Ok((local, true));
        }
        #[cfg(not(feature = "sftp"))]
        {
            let _ = state;
            Err("SFTP 插件未编译，无法读取远程文件".into())
        }
    } else if path.starts_with("http://") || path.starts_with("https://") {
        if !plugins::plugin_enabled(&state.plugins, "http") {
            return Err("HTTP autoindex 插件已禁用（设置 → 插件中可重新启用）".into());
        }
        Ok((http_autoindex::download_to_temp(path.to_string()).await?, true))
    } else {
        Ok((path.to_string(), false))
    }
}

/// v0.19 文本比较：任意两侧（本地 / SFTP / HTTP）的行级 diff。
/// encoding：None/utf-8 之外的 WhatWG 标签（gbk / big5 / shift_jis …）按指定编码解码（v0.21.1）。
#[tauri::command]
async fn diff_text_files(
    state: tauri::State<'_, AppState>,
    left: String,
    right: String,
    encoding: Option<String>,
) -> Result<text_diff::TextDiffOutcome, String> {
    let (llocal, ltemp) = resolve_text_side(&state, &left)
        .await
        .map_err(|e| format!("左侧准备失败：{e}"))?;
    let (rlocal, rtemp) = resolve_text_side(&state, &right)
        .await
        .map_err(|e| format!("右侧准备失败：{e}"))?;
    // 读取 + 行级 diff 是纯 CPU/IO 同步段（上限 8MB×2），放 blocking 池避免占用异步运行时
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = (|| -> Result<text_diff::TextDiffOutcome, String> {
            let enc = encoding.as_deref();
            let (lt, llossy, lbytes) = text_diff::read_local_text(std::path::Path::new(&llocal), enc)?;
            let (rt, rlossy, rbytes) = text_diff::read_local_text(std::path::Path::new(&rlocal), enc)?;
            let la = text_diff::split_lines(&lt);
            let rb = text_diff::split_lines(&rt);
            let (segments, coarse) = text_diff::diff_segments(&la, &rb);
            let (additions, deletions, same) = text_diff::segment_stats(&segments);
            Ok(text_diff::TextDiffOutcome {
                left: text_diff::TextSide {
                    path: left,
                    local_path: llocal.clone(),
                    is_temp: ltemp,
                    lossy: llossy,
                    bytes: lbytes,
                    lines: la.len(),
                    eol: text_diff::detect_eol(&lt).to_string(),
                },
                right: text_diff::TextSide {
                    path: right,
                    local_path: rlocal.clone(),
                    is_temp: rtemp,
                    lossy: rlossy,
                    bytes: rbytes,
                    lines: rb.len(),
                    eol: text_diff::detect_eol(&rt).to_string(),
                },
                segments,
                additions,
                deletions,
                same,
                coarse,
            })
        })();
        // 临时文件用完即删（best-effort；失败留待系统清理临时目录）
        if ltemp {
            let _ = std::fs::remove_file(&llocal);
        }
        if rtemp {
            let _ = std::fs::remove_file(&rlocal);
        }
        outcome
    })
    .await
    .map_err(|e| format!("比较任务失败：{e}"))?
}

/// v0.19 读取文本文件内容（.patch / .diff「查看 Diff」解析用；支持 SFTP/HTTP 路径）。
/// v0.28 起也是预览栏文本预览的读取口；v0.30 返回实际解码（UTF-16 自动识别）。
#[tauri::command]
async fn read_text_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<text_diff::TextFileContent, String> {
    let (local, temp) = resolve_text_side(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = text_diff::read_local_text_full(std::path::Path::new(&local), None).map(|t| {
            text_diff::TextFileContent {
                path,
                local_path: local.clone(),
                is_temp: temp,
                lossy: t.lossy,
                text: t.text,
                encoding: t.encoding.to_string(),
            }
        });
        if temp {
            let _ = std::fs::remove_file(&local);
        }
        result
    })
    .await
    .map_err(|e| format!("读取任务失败：{e}"))?
}

/// 拆 SFTP URL 为 (所在目录 URL, 文件名)：sftp://user@host:22/a/b/c.txt → (sftp://user@host:22/a/b/, c.txt)
#[cfg(feature = "sftp")]
fn split_sftp_dir_name(path: &str) -> Result<(String, String), String> {
    let rest = path.strip_prefix("sftp://").ok_or("非 SFTP 路径")?;
    let slash = rest.find('/').ok_or("SFTP 路径缺少目录部分")?;
    let (authority, full) = rest.split_at(slash);
    let name = full.rsplit('/').next().unwrap_or("").to_string();
    if name.is_empty() {
        return Err("SFTP 路径缺少文件名".into());
    }
    let dir = format!("sftp://{authority}{}", &full[..full.len() - name.len()]);
    Ok((dir, name))
}

/// v0.34 文本比较编辑保存：把编辑后的整份行数组写回一侧。
/// 本地直写；SFTP 先落临时文件再 upload_path 原名覆盖回传；HTTP 远端只读不可写。
/// eol / encoding 语义见 text_diff::encode_lines。
#[tauri::command]
async fn write_text_file(
    state: tauri::State<'_, AppState>,
    path: String,
    lines: Vec<String>,
    eol: String,
    encoding: Option<String>,
) -> Result<(), String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        return Err("HTTP 远端文件只读，无法保存".into());
    }
    let bytes = text_diff::encode_lines(&lines, &eol, encoding.as_deref())?;
    if path.starts_with("sftp://") {
        #[cfg(feature = "sftp")]
        {
            ensure_plugin(&state, "sftp")?;
            let (dir, name) = split_sftp_dir_name(&path)?;
            let tmpdir = std::env::temp_dir().join(format!(
                "r-dir-save-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&tmpdir).map_err(|e| format!("创建临时目录失败：{e}"))?;
            let tmpfile = tmpdir.join(&name);
            let write_result = std::fs::write(&tmpfile, &bytes)
                .map_err(|e| format!("写临时文件失败：{e}"));
            let result = match write_result {
                Ok(()) => {
                    let pool = state.sftp_pool.lock().await;
                    let mut nocb = |_ev: sftp::XferEvent| true;
                    sftp::upload_path(&pool, &tmpfile.to_string_lossy(), &dir, &name, &mut nocb)
                        .await
                        .map(|_: String| ())
                }
                Err(e) => Err(e),
            };
            let _ = std::fs::remove_dir_all(&tmpdir);
            result
        }
        #[cfg(not(feature = "sftp"))]
        {
            let _ = state;
            Err("SFTP 插件未编译，无法保存远程文件".into())
        }
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            std::fs::write(std::path::Path::new(&path), &bytes).map_err(|e| format!("写入失败：{e}"))
        })
        .await
        .map_err(|e| format!("写入任务失败：{e}"))?
    }
}

/// 读取单个路径的元信息（「属性」统计当前目录用）。
#[tauri::command]
fn stat_entry(path: String) -> Result<fs_ops::FileEntry, String> {
    fs_ops::stat_entry(&path)
}

/// 传输指示的文件名 label：取路径末段（兼容 sftp:// URL 与本地路径）；取不到时回退默认文案。
#[cfg(feature = "sftp")]
fn transfer_label(path: &str, fallback: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// 传输收尾事件：前端仅在收到 done=true 后 1.5s 清除状态栏传输指示，
/// 缺失会导致指示器永久卡在「下载中… 100%」（v0.18.1 修复）。
#[cfg(feature = "sftp")]
fn emit_transfer_done(app: &tauri::AppHandle, phase: &str, label: &str) {
    let mut p = progress::TransferProgress::start(phase, label, 1);
    p.done = true;
    progress::emit(app, &p);
}

/// 注册可取消传输：transfer_cancels 插入新旗标，返回 (id, 旗标)。
/// prefix 用于前端取消路由判别（sftp: 走 cancel_transfer，无前缀的 download 是 http）。
#[cfg(feature = "sftp")]
fn register_transfer_cancel(
    state: &tauri::State<'_, AppState>,
    prefix: &str,
) -> (String, std::sync::Arc<std::sync::atomic::AtomicBool>) {
    let id = format!("{prefix}{}", next_transfer_id());
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .transfer_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    (id, flag)
}

/// SFTP 递归传输收尾：完成/失败/取消统一发 done 帧（取消文案收敛为「已取消」，
/// 与本地复制 emit_transfer_end 同语义；其余 label 由前端按 phase 渲染「xx完成」）。
#[cfg(feature = "sftp")]
fn emit_sftp_transfer_end(
    app: &tauri::AppHandle,
    phase: &str,
    total_files: usize,
    r: &Result<impl Sized, String>,
) {
    let label = match r {
        Ok(_) => "完成",
        Err(e) if e.contains("取消") => "已取消",
        Err(_) => "传输失败",
    };
    let mut p = progress::TransferProgress::start(phase, label, total_files);
    p.done_files = total_files;
    p.done = true;
    progress::emit(app, &p);
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
    let name = transfer_label(&path, "下载中…");
    let pool = state.sftp_pool.lock().await;
    let mut throttle = progress::Throttle::new();
    let result = sftp::download(&pool, &path, |done, total| {
        if done < total && !throttle.ready() {
            return;
        }
        let mut p = progress::TransferProgress::start("download", &name, 1);
        p.file_done = done;
        p.file_total = total;
        progress::emit(&app, &p);
    })
    .await;
    emit_transfer_done(&app, "download", &name);
    result
}

/// 下载远程路径（文件或目录）到指定本地目录（粘贴/拖拽 远程→本地）。
/// v0.23 递归：目录逐级建本地目录下载；进度按远程树统计的总文件数上报（计划阶段
/// 即响应取消）；取消经 transfer_cancels（id 带 sftp: 前缀）。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_download_to(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    local_dir: String,
    path: String,
    overwrite: Option<bool>,
) -> Result<String, String> {
    ensure_plugin(&state, "sftp")?;
    let label = transfer_label(&path, "下载中…");
    let (id, flag) = register_transfer_cancel(&state, "sftp:");
    let pool = state.sftp_pool.lock().await;
    // 计划阶段：遍历远程树统计文件数（多个 RTT，期间响应取消）
    let plan = match sftp::download_plan(&pool, &path, &flag).await {
        Ok(p) => p,
        Err(e) => {
            state.transfer_cancels.lock().unwrap().remove(&id);
            return Err(e);
        }
    };
    let mut throttle = progress::Throttle::new();
    let mut done_files = 0usize;
    let mut cur_label = label.clone();
    let id_task = id.clone();
    let app_task = app.clone();
    let result = sftp::download_to(&pool, &local_dir, &path, overwrite.unwrap_or(false), &mut move |ev| {
        if flag.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        let mut p = progress::TransferProgress::start("download", &cur_label, plan.files);
        p.id = Some(id_task.clone());
        match ev {
            sftp::XferEvent::Start(l) => {
                cur_label = l;
                throttle.reset();
            }
            sftp::XferEvent::Bytes(done, total) => {
                if throttle.ready() {
                    p.file_done = done;
                    p.file_total = total;
                    p.done_files = done_files;
                    progress::emit(&app_task, &p);
                }
                return true;
            }
            sftp::XferEvent::EntryDone => done_files += 1,
        }
        p.label = cur_label.clone();
        p.done_files = done_files;
        progress::emit(&app_task, &p);
        true
    })
    .await;
    state.transfer_cancels.lock().unwrap().remove(&id);
    emit_sftp_transfer_end(&app, "download", plan.files, &result);
    result
}

/// 上传本地路径（文件或目录）到远程目录（拖拽/粘贴）。
/// v0.23 递归：目录逐级建远程目录上传；进度按计划阶段统计的总文件数上报；
/// 取消经 transfer_cancels（id 带 sftp: 前缀，前端据此路由到 cancel_transfer）。
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
    let label = transfer_label(&name, "上传中…");
    // 计划阶段：统计本地树（纯本地遍历，快）；失败回退单文件分母，不阻塞传输
    let plan = sftp::upload_plan(&local).unwrap_or(sftp::TransferPlan { files: 1, bytes: 0 });
    let (id, flag) = register_transfer_cancel(&state, "sftp:");
    let pool = state.sftp_pool.lock().await;
    let mut throttle = progress::Throttle::new();
    let mut done_files = 0usize;
    let mut cur_label = label.clone();
    let id_task = id.clone();
    let app_task = app.clone();
    let result = sftp::upload_path(&pool, &local, &dest, &name, &mut move |ev| {
        if flag.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        let mut p = progress::TransferProgress::start("upload", &cur_label, plan.files);
        p.id = Some(id_task.clone());
        match ev {
            sftp::XferEvent::Start(l) => {
                cur_label = l;
                throttle.reset();
            }
            sftp::XferEvent::Bytes(done, total) => {
                // 中间帧限频；Start 帧与 EntryDone 帧立即可见
                if throttle.ready() {
                    p.file_done = done;
                    p.file_total = total;
                    p.done_files = done_files;
                    progress::emit(&app_task, &p);
                }
                return true;
            }
            sftp::XferEvent::EntryDone => done_files += 1,
        }
        p.label = cur_label.clone();
        p.done_files = done_files;
        progress::emit(&app_task, &p);
        true
    })
    .await;
    state.transfer_cancels.lock().unwrap().remove(&id);
    emit_sftp_transfer_end(&app, "upload", plan.files, &result);
    result
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

/// 远程文件打开临时目录的占用信息（路径/文件数/字节；清理菜单展示用）
#[cfg(feature = "sftp")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTempInfo {
    path: String,
    files: u32,
    bytes: u64,
}

/// 查询远程文件打开临时目录（确定性路径 <temp>/r-dir-sftp）占用
#[cfg(feature = "sftp")]
#[tauri::command]
fn sftp_temp_info() -> SftpTempInfo {
    let (bytes, files) = sftp::temp_usage();
    SftpTempInfo {
        path: sftp::open_temp_dir().to_string_lossy().to_string(),
        files,
        bytes,
    }
}

/// 清空远程文件打开临时目录，返回释放的字节数
#[cfg(feature = "sftp")]
#[tauri::command]
fn sftp_clear_temp() -> Result<u64, String> {
    sftp::clear_temp()
}

/// 导出服务器清单到目标文件（前端 save 对话框给路径）。
/// 已保存的密码/口令以密文带走。存在明文保存的密码时需要主密码（v0.31.1）：
/// 优先用调用方传入的 `master_key`，其次用本会话已解锁的内存密钥；都没有则返回
/// `NEED_MASTER_KEY:`，前端弹主密码框后带密码重试。拿到密码后就地加密并落盘
/// （本机清单一并升级为密文），导出时输入的密码顺手激活到内存。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_export_servers(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    target: String,
    exported_at: String,
    master_key: Option<String>,
) -> Result<sftp::servers::ExportOutcome, String> {
    ensure_plugin(&state, "sftp")?;
    let path = sftp_servers_path(&app)?;
    let mut file = sftp::servers::load_file(&path);
    let provided = master_key.map(String::into_bytes);
    {
        let mut mem = state.master_key.lock().await;
        let key: Option<Vec<u8>> = provided.clone().or_else(|| mem.clone());
        if sftp::servers::seal_for_export(&mut file, key.as_deref())? {
            sftp::servers::save_file(&path, &file)?;
        }
        if mem.is_none() {
            if let Some(k) = provided {
                *mem = Some(k);
            }
        }
    }
    let encrypted = sftp::servers::has_ciphertext(&file);
    let export = sftp::servers::ExportFile {
        version: 1,
        exported_at,
        master_key_check: file.master_key_check.clone(),
        servers: file.servers.clone(),
    };
    let exported = export.servers.len();
    tauri::async_runtime::spawn_blocking(move || {
        let json = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;
        std::fs::write(&target, json).map_err(|e| format!("写入导出文件失败：{e}"))
    })
    .await
    .map_err(|e| format!("导出任务失败：{e}"))??;
    Ok(sftp::servers::ExportOutcome { exported, encrypted })
}

/// 导入服务器清单：密文经导入主密码解密 → 本机主密钥回填加密 → 按 id 去重合并。
/// 文件含密文而未提供主密码 → Err("NEED_MASTER_KEY: …")（前端弹主密码框后重试）。
#[cfg(feature = "sftp")]
#[tauri::command]
async fn sftp_import_servers(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file_path: String,
    master_key: Option<String>,
) -> Result<sftp::servers::ImportOutcome, String> {
    ensure_plugin(&state, "sftp")?;
    let text = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&file_path).map_err(|e| format!("读取导出文件失败：{e}"))
    })
    .await
    .map_err(|e| format!("读取任务失败：{e}"))??;
    let export = sftp::servers::parse_export(&text)?;
    let path = sftp_servers_path(&app)?;
    let mut file = sftp::servers::load_file(&path);
    let outcome = {
        let mk = state.master_key.lock().await;
        let local_master: Option<&[u8]> = mk.as_deref();
        let import_master = master_key.as_deref().map(str::as_bytes);
        sftp::servers::import_merge(&mut file, &export, import_master, local_master)?
    };
    sftp::servers::save_file(&path, &file)?;
    Ok(outcome)
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

/// 生成传输任务 id（毫秒时间戳 + 进程内序号，够唯一且无依赖）
pub(crate) fn next_transfer_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("t{ts}-{n}")
}

/// 取消进行中的本地复制/移动（id 来自 transfer-progress 事件载荷）。
#[tauri::command]
fn cancel_transfer(state: tauri::State<'_, AppState>, id: String) {
    if let Some(flag) = state.transfer_cancels.lock().unwrap().get(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 复制条目到目标目录，返回实际创建路径（供撤销记录）。
#[tauri::command]
async fn copy_entries(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    dest: String,
) -> Result<Vec<String>, String> {
    let id = next_transfer_id();
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .transfer_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_task = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let mut done_entries = 0usize;
        let mut label = String::from("复制中…");
        let mut file_done = 0u64;
        let mut file_total = 0u64;
        let mut throttle = progress::Throttle::new();
        let r = ops::copy_entries(&paths, &dest, &mut |ev| {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            match ev {
                ops::CbEvent::Start(name) => {
                    label = name.to_string();
                    file_done = 0;
                    file_total = 0;
                    throttle.reset();
                }
                ops::CbEvent::Bytes(done, total) => {
                    file_done = done;
                    file_total = total;
                    // 中间帧限频；每个文件的最后一帧随 EntryDone 立即发出
                    if !throttle.ready() {
                        return true;
                    }
                }
                ops::CbEvent::EntryDone => done_entries += 1,
            }
            let mut p = progress::TransferProgress::start("copy", &label, n);
            p.done_files = done_entries;
            p.file_done = file_done;
            p.file_total = file_total;
            p.id = Some(id_task.clone());
            progress::emit(&app, &p);
            true
        });
        emit_transfer_end(&app, "copy", n, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    state.transfer_cancels.lock().unwrap().remove(&id);
    result
}

/// 移动条目到目标目录，返回 (源, 目标) 路径对（供撤销记录）。
#[tauri::command]
async fn move_entries(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    dest: String,
) -> Result<Vec<(String, String)>, String> {
    let id = next_transfer_id();
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .transfer_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_task = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let mut done_entries = 0usize;
        let mut label = String::from("移动中…");
        let mut file_done = 0u64;
        let mut file_total = 0u64;
        let mut throttle = progress::Throttle::new();
        let r = ops::move_entries(&paths, &dest, &mut |ev| {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            match ev {
                ops::CbEvent::Start(name) => {
                    label = name.to_string();
                    file_done = 0;
                    file_total = 0;
                    throttle.reset();
                }
                ops::CbEvent::Bytes(done, total) => {
                    file_done = done;
                    file_total = total;
                    // 中间帧限频；每个文件的最后一帧随 EntryDone 立即发出
                    if !throttle.ready() {
                        return true;
                    }
                }
                ops::CbEvent::EntryDone => done_entries += 1,
            }
            let mut p = progress::TransferProgress::start("move", &label, n);
            p.done_files = done_entries;
            p.file_done = file_done;
            p.file_total = file_total;
            p.id = Some(id_task.clone());
            progress::emit(&app, &p);
            true
        });
        emit_transfer_end(&app, "move", n, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    state.transfer_cancels.lock().unwrap().remove(&id);
    result
}

/// 传输结束（完成/失败/取消）统一发 done 事件：失败与取消也要终止进度条，
/// 取消时前端把文案收敛为「已取消」。
fn emit_transfer_end<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    phase: &str,
    total: usize,
    r: &Result<impl Sized, String>,
) {
    let zh = if phase == "copy" { "复制" } else { "移动" };
    let label = match r {
        Ok(_) => format!("{zh}完成"),
        Err(e) if e.contains("取消") => "已取消".into(),
        Err(_) => "传输失败".into(),
    };
    progress::emit(
        app,
        &progress::TransferProgress {
            phase: phase.into(),
            label,
            done_files: total,
            total_files: total,
            file_done: 0,
            file_total: 0,
            done: true,
            id: None,
        },
    );
}

/// 扫描复制/移动前需用户裁决的同名冲突（同名目录可合并，不返回冲突）。
#[tauri::command]
async fn scan_conflicts(paths: Vec<String>, dest: String) -> Result<Vec<ops::Conflict>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::scan_conflicts(&paths, &dest))
        .await
        .map_err(|e| e.to_string())?
}

/// v0.28.0 目录复制语义：顶层同名目录重复检测 + `name (2)` 建议名。
#[tauri::command]
async fn scan_dir_duplicates(paths: Vec<String>, dest: String) -> Result<Vec<ops::DupDir>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::scan_dir_duplicates(&paths, &dest))
        .await
        .map_err(|e| e.to_string())?
}

/// 按冲突裁决表复制，返回实际创建路径（供撤销记录）。
#[tauri::command]
async fn copy_entries_plan(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    dest: String,
    resolutions: std::collections::HashMap<String, ops::Resolution>,
) -> Result<Vec<String>, String> {
    let id = next_transfer_id();
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .transfer_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_task = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let mut done_entries = 0usize;
        let mut label = String::from("复制中…");
        let mut file_done = 0u64;
        let mut file_total = 0u64;
        let mut throttle = progress::Throttle::new();
        let r = ops::copy_entries_plan(&paths, &dest, &resolutions, &mut |ev| {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            match ev {
                ops::CbEvent::Start(name) => {
                    label = name.to_string();
                    file_done = 0;
                    file_total = 0;
                    throttle.reset();
                }
                ops::CbEvent::Bytes(done, total) => {
                    file_done = done;
                    file_total = total;
                    // 中间帧限频；每个文件的最后一帧随 EntryDone 立即发出
                    if !throttle.ready() {
                        return true;
                    }
                }
                ops::CbEvent::EntryDone => done_entries += 1,
            }
            let mut p = progress::TransferProgress::start("copy", &label, n);
            p.done_files = done_entries;
            p.file_done = file_done;
            p.file_total = file_total;
            p.id = Some(id_task.clone());
            progress::emit(&app, &p);
            true
        });
        emit_transfer_end(&app, "copy", n, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    state.transfer_cancels.lock().unwrap().remove(&id);
    result
}

/// 按冲突裁决表移动，返回 (源, 目标) 路径对（供撤销反向移动）。
#[tauri::command]
async fn move_entries_plan(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    dest: String,
    resolutions: std::collections::HashMap<String, ops::Resolution>,
) -> Result<Vec<(String, String)>, String> {
    let id = next_transfer_id();
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .transfer_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_task = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let n = paths.len();
        let mut done_entries = 0usize;
        let mut label = String::from("移动中…");
        let mut file_done = 0u64;
        let mut file_total = 0u64;
        let mut throttle = progress::Throttle::new();
        let r = ops::move_entries_plan(&paths, &dest, &resolutions, &mut |ev| {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            match ev {
                ops::CbEvent::Start(name) => {
                    label = name.to_string();
                    file_done = 0;
                    file_total = 0;
                    throttle.reset();
                }
                ops::CbEvent::Bytes(done, total) => {
                    file_done = done;
                    file_total = total;
                    // 中间帧限频；每个文件的最后一帧随 EntryDone 立即发出
                    if !throttle.ready() {
                        return true;
                    }
                }
                ops::CbEvent::EntryDone => done_entries += 1,
            }
            let mut p = progress::TransferProgress::start("move", &label, n);
            p.done_files = done_entries;
            p.file_done = file_done;
            p.file_total = file_total;
            p.id = Some(id_task.clone());
            progress::emit(&app, &p);
            true
        });
        emit_transfer_end(&app, "move", n, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    state.transfer_cancels.lock().unwrap().remove(&id);
    result
}

/// 把文件列表写入系统剪贴板（跨应用复制/剪切；cut=true 资源管理器粘贴时按移动处理）。
#[tauri::command]
fn clipboard_write_files(paths: Vec<String>, cut: Option<bool>) -> Result<(), String> {
    clipboard::write_file_list(&paths, cut.unwrap_or(false))
}

/// 系统剪贴板文件列表（跨应用粘贴）：paths + 剪切标志
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardFilesPayload {
    paths: Vec<String>,
    cut: bool,
}

/// 从系统剪贴板读取文件列表（跨应用粘贴），含剪切/移动语义标志。
#[tauri::command]
fn clipboard_read_files() -> Result<ClipboardFilesPayload, String> {
    clipboard::read_file_list().map(|f| ClipboardFilesPayload { paths: f.paths, cut: f.cut })
}

/// 清空系统剪贴板：消费外部剪切（移动粘贴完成）后调用，避免残留失效的剪切项。
#[tauri::command]
fn clipboard_clear_files() {
    clipboard::clear()
}

/// 原生拖出（Windows：OLE 拖拽携带 CF_HDROP，浏览器上传投放区/资源管理器可接收）。
/// 阻塞到松手，返回投放效果（0 = 无目标/取消，1 = copy，2 = move，4 = 快捷方式）；
/// 空列表为 no-op（前端启动时的能力探测）。必须保持同步命令以在主线程执行。
#[tauri::command]
fn drag_out_files(paths: Vec<String>) -> Result<u32, String> {
    drag_out::start(paths)
}

/// 修饰键实时状态（v0.34：Windows 原生拖放投放时判定 Alt=移动）。
#[tauri::command]
fn query_modifiers() -> drag_out::Modifiers {
    drag_out::modifiers()
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

/// 从回收站还原条目（撤销删除），返回还原的路径。
#[tauri::command]
async fn restore_from_trash(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::restore_from_trash(&paths))
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

/// 内容搜索（VSCode 风格，默认字面量关键词；默认仅当前层）。
#[tauri::command]
async fn search_content(
    query: String,
    dir: String,
    recursive: bool,
    case_sensitive: bool,
    include_hidden: bool,
    use_regex: bool,
) -> Result<Vec<SearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search::search_content(&query, &dir, recursive, case_sensitive, include_hidden, use_regex)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 快速文件检索（fd 语义：正则 / 通配符 + 递归）。
#[tauri::command]
async fn find_files(
    pattern: String,
    dir: String,
    show_hidden: bool,
    max_depth: Option<usize>,
    glob: bool,
    case_sensitive: bool,
) -> Result<Vec<FindEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        find::find_files(&pattern, &dir, show_hidden, max_depth, glob, case_sensitive)
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
            // Windows：禁用 WebView2 浏览器加速键。Ctrl+J（下载弹窗「下载的文件将在此显示」）、
            // Ctrl+F（查找）、Ctrl+P（打印）、Ctrl+R/F5（整页刷新）、Ctrl+±（缩放）、F12 等
            // 由 WebView2 优先处理，页面 JS 收不到（应用快捷键被劫持，典型：Ctrl+J = 上下分屏
            // 变成弹下载面板）。关闭后全部按键直达页面由 keymap.ts 分发；文本编辑键
            // （Ctrl+C/V/X/A/Z、Home/End 等）不受此设置影响。等价于 wry 的
            // with_browser_accelerator_keys(false)（Tauri 2.11 尚未透传该选项，#16306）。
            #[cfg(target_os = "windows")]
            {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows_webview::core::Interface;
                for w in app.webview_windows().values() {
                    let _ = w.with_webview(move |webview| unsafe {
                        let Ok(core) = webview.controller().CoreWebView2() else {
                            return;
                        };
                        let Ok(settings) = core.Settings() else {
                            return;
                        };
                        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                        }
                    });
                }
            }
            let state = app.state::<AppState>();
            plugins::init(app.handle(), &state.plugins);
            // 命令补全索引预热（后台线程）：优先加载磁盘缓存，PATH 签名变化才重扫，
            // 避免首次在地址栏输入裸词时全量扫描 PATH 卡住主线程
            cmdrun::warm_cache_async(
                state.cmd_cache.clone(),
                cmdrun::index_path(app.handle()),
                plugins::plugin_enabled(&state.plugins, "cmdrun"),
            );
            // 磁盘/卷热插拔监视（v0.27）：挂载/卸载/推出后推送最新列表，侧边栏即时刷新
            volumes::spawn_watcher(app.handle().clone());
            // 打开目录内容监视（v0.26.1）：程序外新增/删除文件推送 fs://changed，窗体即时刷新
            fs_watch::spawn_fs_watcher(app.handle().clone());
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
        cancel_transfer,
        allow_exit,
        fs_watch::fs_watch_set,
        iconpos::icon_positions_load,
        iconpos::icon_positions_save,
        thumbs::thumb_get,
        preview::preview_data,
        scan_conflicts,
        scan_dir_duplicates,
        copy_entries_plan,
        move_entries_plan,
        clipboard_write_files,
        clipboard_read_files,
        clipboard_clear_files,
        drag_out_files,
        query_modifiers,
        rename_entry,
        delete_entries,
        permanent_delete_entries,
        restore_from_trash,
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
        // v0.31 服务器清单导出/导入 + 远程打开临时目录管理
        #[cfg(feature = "sftp")]
        sftp_export_servers,
        #[cfg(feature = "sftp")]
        sftp_import_servers,
        #[cfg(feature = "sftp")]
        sftp_temp_info,
        #[cfg(feature = "sftp")]
        sftp_clear_temp,
        // v0.31 服务器分组整理（拖拽换组 / 分组重命名）
        #[cfg(feature = "sftp")]
        sftp_set_server_group,
        // v0.4 打开方式 / 终端插件
        opener::list_openers,
        opener::open_with,
        opener::add_custom_opener,
        opener::set_opener_extensions,
        opener::remove_custom_opener,
        opener::list_shells,
        opener::open_terminal,
        // v0.29.0 右键 VSCode / Git 打开
        opener::vscode_detected,
        opener::open_vscode,
        opener::list_git_tools,
        opener::open_git_tool,
        // v0.29.0 常用工具条
        opener::list_quick_tools,
        opener::add_quick_tool,
        opener::remove_quick_tool,
        opener::move_quick_tool,
        opener::set_quick_tool_args,
        opener::open_quick_tool,
        opener::detect_editors,
        // 地址栏命令执行（v0.22.0）
        cmdrun::complete_commands,
        cmdrun::run_command,
        // 会话保存 / 恢复
        session_save,
        session_load,
        session_clear,
        // 标签收藏夹
        favorites_load,
        favorites_save,
        // 偏好持久化（v0.14）
        prefs_load,
        prefs_save,
        // 目录大小统计（v0.16）
        compute_size,
        cancel_size,
        // 目录差异比对（v0.17 / v0.18 进度与取消）
        diff_dirs,
        cancel_diff,
        diff_text_files,
        read_text_file,
        write_text_file,
        stat_entry,
        // 插件注册表（v0.5）
        list_plugins,
        set_plugin_enabled,
        // HTTP autoindex 插件（v0.6）
        http_autoindex::http_download_to,
        http_autoindex::cancel_http_download,
        // 压缩（v0.8：zip / tar / tgz，仅打包）
        compress::compress_items,
        // 解压（v0.32：zip / tar 系 / gz / bz2 内置解码；rar / 7z / tar.xz 走系统 tar）
        extract::extract_archive,
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
            match event {
                // v0.23：应用级退出（macOS ⌘Q / Dock「退出」/ app.exit）拦截转前端确认。
                // 仅在仍有窗口可承载确认对话框时拦截；前端确认后经 allow_exit 置位
                // 再 exit(0) 放行。窗口 X 关闭走 JS onCloseRequested（v0.3.0），不在此拦。
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let allowed = _app_handle
                        .try_state::<AppState>()
                        .map(|s| s.exit_allowed.load(std::sync::atomic::Ordering::Relaxed))
                        .unwrap_or(false);
                    if !allowed && !_app_handle.webview_windows().is_empty() {
                        api.prevent_exit();
                        use tauri::Emitter;
                        let _ = _app_handle.emit("app-exit-requested", ());
                    }
                }
                // v0.7：应用退出时停止所有分享服务
                tauri::RunEvent::Exit => {
                    #[cfg(feature = "share")]
                    {
                        if let Some(share_state) = _app_handle.try_state::<share::ShareState>() {
                            share::shutdown_all(&share_state.manager);
                        }
                    }
                }
                _ => {}
            }
        });
}

/// v0.23：前端退出确认对话框（保存并退出/直接退出）放行下一次 ExitRequested。
/// 置位后调用 exit(0) 不再被 prevent_exit 拦截。
#[tauri::command]
fn allow_exit(state: tauri::State<'_, AppState>) {
    state
        .exit_allowed
        .store(true, std::sync::atomic::Ordering::Relaxed);
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
        sess.upload(&local, &remote2, |_, _| true).await.expect("upload");
        let renamed = format!("{dir}/renamed.txt");
        sess.rename(&f1, &renamed).await.expect("rename");
        let local2 = std::env::temp_dir().join(format!("rdir-download-{}.txt", std::process::id()));
        sess.download(&remote2, &local2, |_, _| true).await.expect("download");
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

/// v0.34 文本比较编辑保存：SFTP URL 拆目录/文件名（回传覆盖用）
#[cfg(all(test, feature = "sftp"))]
mod write_text_tests {
    use super::*;

    #[test]
    fn split_sftp_dir_name_cases() {
        assert_eq!(
            split_sftp_dir_name("sftp://u@h:2222/a/b/c.txt").unwrap(),
            ("sftp://u@h:2222/a/b/".to_string(), "c.txt".to_string())
        );
        // 根目录下的文件
        assert_eq!(
            split_sftp_dir_name("sftp://u@h/f.md").unwrap(),
            ("sftp://u@h/".to_string(), "f.md".to_string())
        );
        // 以 / 结尾（目录）→ 无文件名
        assert!(split_sftp_dir_name("sftp://u@h/a/").is_err());
        // 缺目录部分 / 非 sftp
        assert!(split_sftp_dir_name("sftp://u@h").is_err());
        assert!(split_sftp_dir_name("/local/path").is_err());
    }
}
