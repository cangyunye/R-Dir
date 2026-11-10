//! v0.5 插件注册表：内置插件契约（协议前缀 + 操作集 + 启用开关 + 配置入口）。
//!
//! 设计说明：当前全部为"内置插件"（编译进二进制），但按统一契约登记；
//! 未来 http-autoindex 等外置插件（脱离编译、运行时加载）沿用同一注册表与面板，
//! 只需替换加载层（wasm / 独立进程 IPC），路由、配置、诊断零改动。

use serde::{Deserialize, Serialize};
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
    /// builtin（编译期内置）| external（运行时加载的伴生进程插件，如 .rdplugin 安装的 NFS）
    pub source: String,
    /// 声明的协议前缀，如 ["sftp://"]
    pub protocols: Vec<String>,
    /// 支持的操作集：list / read / write / delete / transfer / search / open / shell
    pub operations: Vec<String>,
    pub enabled: bool,
    /// 是否有配置面板入口（如 sftp 服务器管理、opener 自定义工具管理）
    pub configurable: bool,
    /// v0.40 外置插件的安装态（builtin 恒为 true；external 为 false 时面板给安装入口）
    pub installed: bool,
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
pub fn builtin_plugins(enabled_map: &HashMap<String, bool>, nfs_installed: bool) -> Vec<PluginInfo> {
    // 面板展示与 plugin_enabled 门禁必须同源（default_enabled）——
    // 此前这里硬编码 unwrap_or(true)，默认关闭的插件（全盘索引）在面板上
    // 显示已开启而实际是关的，首次点击反而发出「关闭」指令
    let enabled = |id: &str| enabled_map.get(id).copied().unwrap_or_else(|| default_enabled(id));
    // 内嵌 nfs 构建不消费该参数（external 条目仅在 nfs-sidecar 构建下出现）
    let _ = nfs_installed;
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
        installed: true,
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
        installed: true,
    });
    #[cfg(feature = "share")]
    v.push(PluginInfo {
        id: "share".into(),
        name: "窗口分享".into(),
        description: "把当前窗口目录分享为链接：他人浏览器只读浏览 + Range 断点续传下载；支持上溯开关、连接数上限、有效期".into(),
        version: "0.7".into(),
        source: "builtin".into(),
        protocols: vec!["share://".into()],
        operations: vec!["read".into(), "transfer".into()],
        enabled: enabled("share"),
        configurable: false,
        installed: true,
    });
    v.push(PluginInfo {
        id: "smb".into(),
        name: "SMB / Windows 网络共享".into(),
        description: "地址栏 smb://host/share 或 \\\\host\\share 浏览 Windows 共享：UNC 委托本地引擎，认证走系统凭据；smb://host 列出共享（仅 Windows）".into(),
        version: "0.1".into(),
        source: "builtin".into(),
        protocols: vec!["smb://".into()],
        operations: vec![
            "list".into(),
            "read".into(),
            "write".into(),
            "delete".into(),
            "transfer".into(),
        ],
        enabled: enabled("smb"),
        configurable: false,
        installed: true,
    });
    // v0.40 NFS 双形态：feature = "nfs" 内嵌编译（builtin）；否则 nfs-sidecar 构建下为
    // 外置伴生进程插件（.rdplugin 安装，未安装时面板给安装入口，路由仍可用提供明确报错）
    #[cfg(feature = "nfs")]
    v.push(PluginInfo {
        id: "nfs".into(),
        name: "NFS 网络文件系统".into(),
        description: "地址栏 nfs://host/export 直连 NFSv3 导出（纯 Rust 客户端，不经系统挂载）：浏览读写、递归上传下载；nfs://host 列出导出".into(),
        version: "0.2".into(),
        source: "builtin".into(),
        protocols: vec!["nfs://".into()],
        operations: vec![
            "list".into(),
            "read".into(),
            "write".into(),
            "delete".into(),
            "transfer".into(),
        ],
        enabled: enabled("nfs"),
        configurable: false,
        installed: true,
    });
    #[cfg(all(not(feature = "nfs"), feature = "nfs-sidecar"))]
    v.push(PluginInfo {
        id: "nfs".into(),
        name: "NFS 网络文件系统（插件）".into(),
        description: "经 .rdplugin 安装的 NFSv3 伴生进程插件（设置 → 插件安装后生效）：地址栏 nfs://host/export 直连导出，浏览读写、递归上传下载".into(),
        version: "0.2".into(),
        source: "external".into(),
        protocols: vec!["nfs://".into()],
        operations: vec![
            "list".into(),
            "read".into(),
            "write".into(),
            "delete".into(),
            "transfer".into(),
        ],
        enabled: enabled("nfs"),
        configurable: false,
        installed: nfs_installed,
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
        installed: true,
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
        installed: true,
    });
    v.push(PluginInfo {
        id: "cmdrun".into(),
        name: "地址栏命令".into(),
        description: "路径栏输入命令：PATH 可执行扫描补全，回车在终端中 cd 到当前目录执行".into(),
        version: "0.22".into(),
        source: "builtin".into(),
        protocols: vec![],
        operations: vec!["run".into()],
        enabled: enabled("cmdrun"),
        configurable: false,
        installed: true,
    });
    v.push(PluginInfo {
        id: "index-search".into(),
        name: "全盘索引搜索".into(),
        description: "后台索引本地固定卷，文件名检索 Everything 级瞬时返回：默认关闭，启用后利用空闲时间构建、周期秒级增量；范围与排除在 设置 → 全盘索引 配置".into(),
        version: "0.1".into(),
        source: "builtin".into(),
        protocols: vec![],
        operations: vec!["search".into()],
        enabled: enabled("index-search"),
        configurable: true,
        installed: true,
    });
    v
}

// ==================== 状态操作 ====================

/// 各插件的默认启用状态。绝大多数默认开启；「全盘索引搜索」默认关闭——
/// 后台全盘扫描属重资源功能，由用户在插件面板显式开启。
pub fn default_enabled(id: &str) -> bool {
    !matches!(id, "index-search")
}

pub fn plugin_enabled(state: &PluginState, id: &str) -> bool {
    state
        .enabled
        .lock()
        .unwrap()
        .get(id)
        .copied()
        .unwrap_or_else(|| default_enabled(id))
}

pub fn set_enabled(state: &PluginState, id: &str, enabled: bool) {
    state.enabled.lock().unwrap().insert(id.to_string(), enabled);
}

// ==================== 持久化 ====================

fn plugins_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::config_dir(app)?;
    Ok(dir.join(PLUGINS_FILE))
}

/// 插件文件路径（配置目录显式传入；GUI 命令与 web 桥共用）
pub(crate) fn plugins_file_in(config_dir: &std::path::Path) -> std::path::PathBuf {
    config_dir.join(PLUGINS_FILE)
}

/// 载入持久化状态（首次运行返回空，全部插件默认启用）
pub fn load_file(app: &tauri::AppHandle) -> PluginStateFile {
    load_file_in(&crate::paths::config_dir(app).unwrap_or_default())
}

/// load_file 核心（GUI 命令与 web 桥共用）
pub(crate) fn load_file_in(config_dir: &std::path::Path) -> PluginStateFile {
    let path = plugins_file_in(config_dir);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 原子写入（tmp + rename）
pub fn save_file(app: &tauri::AppHandle, file: &PluginStateFile) -> Result<(), String> {
    save_file_in(&crate::paths::config_dir(app)?, file)
}

/// save_file 核心（GUI 命令与 web 桥共用）
pub(crate) fn save_file_in(
    config_dir: &std::path::Path,
    file: &PluginStateFile,
) -> Result<(), String> {
    let path = plugins_file_in(config_dir);
    let dir = path.parent().ok_or("配置目录无效")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    crate::json_store::write_atomic(&path, &json, "写入失败", "落盘失败")
}

/// 启动时初始化：载入 plugins.json → 填充 PluginState
pub fn init(app: &tauri::AppHandle, state: &PluginState) {
    init_in(&crate::paths::config_dir(app).unwrap_or_default(), state);
}

/// init 核心（GUI 命令与 web 桥共用）
pub(crate) fn init_in(config_dir: &std::path::Path, state: &PluginState) {
    let file = load_file_in(config_dir);
    let mut map = state.enabled.lock().unwrap();
    for (id, entry) in file.plugins {
        map.insert(id, entry.enabled);
    }
}

/// 把内存状态整理为持久化结构（只记录与默认值不同的项，减少文件噪音；
/// 「全盘索引」默认关闭，其 enabled=true 也会被记录）
pub fn to_file(state: &PluginState) -> PluginStateFile {
    let map = state.enabled.lock().unwrap().clone();
    PluginStateFile {
        plugins: map
            .into_iter()
            .filter(|(id, enabled)| *enabled != default_enabled(id))
            .map(|(id, enabled)| (id, PluginEntry { enabled }))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v0.47 回归：面板清单（builtin_plugins）与真实门禁（plugin_enabled）必须
    /// 同源 default_enabled——此前清单侧硬编码默认全开，默认关闭的「全盘索引」
    /// 在面板显示已开启而实际是关的（视觉与行为颠倒，首次点击发出的是关闭指令）
    #[test]
    fn panel_matches_gate_for_default_off_plugin() {
        let map = HashMap::new(); // 空表 = 全默认（无 plugins.json 覆盖）
        let list = builtin_plugins(&map, false);
        let idx = list.iter().find(|p| p.id == "index-search").expect("index-search 应在清单");
        assert!(!idx.enabled, "面板默认态应与 default_enabled 一致（关）");
        let state = PluginState::default();
        assert!(!plugin_enabled(&state, "index-search"), "门禁默认值应与面板一致");
        // 其余插件默认开：两侧同样一致
        let sftp = list.iter().find(|p| p.id == "sftp").expect("sftp 应在清单");
        assert!(sftp.enabled);
        assert!(plugin_enabled(&state, "sftp"));
    }

    /// 开启默认关闭的插件 → to_file 落盘记录；再关回默认值 → 记录消失（噪音过滤）
    #[test]
    fn toggle_persists_non_default_and_filters_default() {
        let state = PluginState::default();
        set_enabled(&state, "index-search", true);
        let file = to_file(&state);
        assert_eq!(file.plugins.get("index-search").map(|e| e.enabled), Some(true), "非默认开启必须落盘");
        // 面板显示随 map 翻转（显式 true → 开）
        let map = state.enabled.lock().unwrap().clone();
        let list = builtin_plugins(&map, false);
        let idx = list.iter().find(|p| p.id == "index-search").unwrap();
        assert!(idx.enabled);
        // 关回默认值 → 落盘记录消失（噪音过滤）；面板显示随显式 false（关）
        set_enabled(&state, "index-search", false);
        let file = to_file(&state);
        assert!(file.plugins.get("index-search").is_none(), "默认值不落盘（噪音过滤）");
        let map = state.enabled.lock().unwrap().clone();
        let list = builtin_plugins(&map, false);
        let idx = list.iter().find(|p| p.id == "index-search").unwrap();
        assert!(!idx.enabled, "显式 false 面板应显示关");
    }
}
