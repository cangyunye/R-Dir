//! v0.5 插件注册表：内置插件契约（协议前缀 + 操作集 + 启用开关 + 配置入口）。
//!
//! 设计说明：当前全部为"内置插件"（编译进二进制），但按统一契约登记；
//! 未来 http-autoindex 等外置插件（脱离编译、运行时加载）沿用同一注册表与面板，
//! 只需替换加载层（wasm / 独立进程 IPC），路由、配置、诊断零改动。

use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::collections::HashMap;
use std::sync::Mutex;

pub const PLUGINS_FILE: &str = "plugins.json";

// ==================== 数据结构 ====================

/// 插件信息（面板展示 + 注册表）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// builtin（编译期内置）| external（未来运行时加载）
    pub source: String,
    /// 声明的协议前缀，如 ["sftp://"]
    pub protocols: Vec<String>,
    /// 支持的操作集：list / read / write / delete / transfer / search / open / shell
    pub operations: Vec<String>,
    pub enabled: bool,
    /// 是否有配置面板入口（如 sftp 服务器管理、opener 自定义工具管理）
    pub configurable: bool,
}

/// 插件启用状态（内存，AppState 持有）
#[derive(Default)]
pub struct PluginState {
    pub enabled: Mutex<HashMap<String, bool>>,
}

/// 持久化文件 plugins.json
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateFile {
    #[serde(default)]
    pub plugins: HashMap<String, PluginEntry>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

// ==================== 内置插件声明 ====================

/// 列出内置插件。`#[cfg(feature = "sftp")]` 编译期拔出的插件不出现（面板干净）。
pub fn builtin_plugins(enabled_map: &HashMap<String, bool>) -> Vec<PluginInfo> {
    let enabled = |id: &str| enabled_map.get(id).copied().unwrap_or(true);
    let mut v = Vec::new();
    #[cfg(feature = "sftp")]
    v.push(PluginInfo {
        id: "sftp".into(),
        name: "SFTP / SSH 远程文件系统".into(),
        description: "浏览与读写远程服务器文件；密码经 master-key 加密保存，私钥走 ~/.ssh".into(),
        version: "0.2".into(),
        source: "builtin".into(),
        protocols: vec!["sftp://".into()],
        operations: vec![
            "list".into(),
            "read".into(),
            "write".into(),
            "delete".into(),
            "transfer".into(),
        ],
        enabled: enabled("sftp"),
        configurable: true,
    });
    v.push(PluginInfo {
        id: "http".into(),
        name: "HTTP autoindex 目录浏览".into(),
        description: "解析 nginx autoindex 页面为文件 / 文件夹列表，支持上下层 URL 导航（只读浏览）".into(),
        version: "0.6".into(),
        source: "builtin".into(),
        protocols: vec!["http://".into(), "https://".into()],
        operations: vec!["list".into(), "read".into()],
        enabled: enabled("http"),
        configurable: false,
    });
    v.push(PluginInfo {
        id: "opener".into(),
        name: "打开方式".into(),
        description: "右键自定义打开方式：用户自行注册工具，参数数组安全启动".into(),
        version: "0.4".into(),
        source: "builtin".into(),
        protocols: vec![],
        operations: vec!["open".into()],
        enabled: enabled("opener"),
        configurable: true,
    });
    v.push(PluginInfo {
        id: "terminal".into(),
        name: "终端".into(),
        description: "在文件夹/空白处右键打开终端（mac Terminal/iTerm/fish/nu/zsh，win wt/powershell/cmd/fish/nu）".into(),
        version: "0.4".into(),
        source: "builtin".into(),
        protocols: vec![],
        operations: vec!["shell".into()],
        enabled: enabled("terminal"),
        configurable: false,
    });
    v
}

// ==================== 状态操作 ====================

pub fn plugin_enabled(state: &PluginState, id: &str) -> bool {
    state
        .enabled
        .lock()
        .unwrap()
        .get(id)
        .copied()
        .unwrap_or(true)
}

pub fn set_enabled(state: &PluginState, id: &str, enabled: bool) {
    state.enabled.lock().unwrap().insert(id.to_string(), enabled);
}

// ==================== 持久化 ====================

fn plugins_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join(PLUGINS_FILE))
}

/// 载入持久化状态（首次运行返回空，全部插件默认启用）
pub fn load_file(app: &tauri::AppHandle) -> PluginStateFile {
    let path = plugins_path(app).unwrap_or_default();
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 原子写入（tmp + rename）
pub fn save_file(app: &tauri::AppHandle, file: &PluginStateFile) -> Result<(), String> {
    let path = plugins_path(app)?;
    let dir = path.parent().ok_or("配置目录无效")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("落盘失败：{e}"))?;
    Ok(())
}

/// 启动时初始化：载入 plugins.json → 填充 PluginState
pub fn init(app: &tauri::AppHandle, state: &PluginState) {
    let file = load_file(app);
    let mut map = state.enabled.lock().unwrap();
    for (id, entry) in file.plugins {
        map.insert(id, entry.enabled);
    }
}

/// 把内存状态整理为持久化结构（只记录非默认值，减少文件噪音）
pub fn to_file(state: &PluginState) -> PluginStateFile {
    let map = state.enabled.lock().unwrap().clone();
    PluginStateFile {
        plugins: map
            .into_iter()
            .filter(|(_, enabled)| !*enabled)
            .map(|(id, enabled)| (id, PluginEntry { enabled }))
            .collect(),
    }
}
