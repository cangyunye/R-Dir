//! "打开方式"与"在此处打开终端"内置插件（v0.4）。
//! 设计原则：
//! - 全部启动走参数数组（Command::new().args()），绝不拼接 shell 字符串 → 零命令注入
//! - 内置白名单（编辑器/浏览器/播放器/Agent）自动探测安装路径，懒加载 + 进程内缓存
//! - 用户自定义工具存 openers.json（仅"选择可执行文件"，不允许输入任意命令字符串）
//! - 终端仅在右键（空白/文件夹）出现；管理员权限继承 R-Dir 自身进程（win 由 OS 保证）

pub mod detect;
pub mod launch;


use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 打开方式条目（内置探测 / Agent / 用户自定义）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenerItem {
    /// 稳定 id：builtin:vscode / agent:claude / custom:<uuid>
    pub id: String,
    pub name: String,
    /// editor / browser / player / image / agent / custom
    pub kind: String,
    /// 是否探测到安装（未探测到前端置灰）
    pub detected: bool,
    /// 启动器描述：.app 名称 / 可执行文件路径 / CLI 命令名
    pub exec: Option<String>,
    /// true = CLI 方式启动（mac 上非 .app）
    pub cli: bool,
    /// 关联后缀（自定义工具）
    pub extensions: Vec<String>,
}

/// 终端条目
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellItem {
    pub id: String,
    pub name: String,
    pub detected: bool,
}

/// 用户自定义工具（openers.json）
#[derive(Serialize, Deserialize, Clone)]
pub struct CustomOpener {
    pub id: String,
    pub name: String,
    pub exec: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct OpenersConfig {
    #[serde(default)]
    custom: Vec<CustomOpener>,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法获取配置目录：{e}"))
        .map(|d| d.join("openers.json"))
}

fn load_config(app: &tauri::AppHandle) -> OpenersConfig {
    let Ok(p) = config_path(app) else {
        return OpenersConfig::default();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &tauri::AppHandle, cfg: &OpenersConfig) -> Result<(), String> {
    let p = config_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    // 原子写：先写临时文件再 rename
    let tmp = p.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(&tmp, data).map_err(|e| format!("写入配置失败：{e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存配置失败：{e}"))?;
    Ok(())
}

/// 列出现有打开方式（内置探测 + Agent + 用户自定义）
#[tauri::command]
pub fn list_openers(app: tauri::AppHandle) -> Vec<OpenerItem> {
    let mut items = Vec::new();
    for it in detect::builtin_openers() {
        let mut it = it;
        it.detected = detect::detect_opener(&mut it);
        items.push(it);
    }
    let cfg = load_config(&app);
    for c in &cfg.custom {
        let exists = std::path::Path::new(&c.exec).exists();
        items.push(OpenerItem {
            id: c.id.clone(),
            name: c.name.clone(),
            kind: "custom".into(),
            detected: exists,
            exec: Some(c.exec.clone()),
            cli: false,
            extensions: c.extensions.clone(),
        });
    }
    items
}

/// 用指定工具打开路径（参数数组，零注入）
#[tauri::command]
pub fn open_with(app: tauri::AppHandle, tool_id: String, path: String) -> Result<(), String> {
    let cfg = load_config(&app);
    if let Some(c) = cfg.custom.iter().find(|x| x.id == tool_id) {
        return launch::launch_custom(&c.exec, &path);
    }
    if let Some(it) = detect::builtin_openers().into_iter().find(|x| x.id == tool_id) {
        return launch::launch_opener(&it, &path);
    }
    Err(format!("未找到工具：{tool_id}"))
}

/// 添加自定义打开方式（仅接受"可执行文件路径"，不接受命令字符串）
#[tauri::command]
pub fn add_custom_opener(
    app: tauri::AppHandle,
    name: String,
    exec: String,
    extensions: Vec<String>,
) -> Result<OpenerItem, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    let exec = exec.trim().to_string();
    if exec.is_empty() || !std::path::Path::new(&exec).exists() {
        return Err("可执行文件不存在，请重新选择".into());
    }
    let mut cfg = load_config(&app);
    if cfg.custom.iter().any(|c| c.exec == exec) {
        return Err("该程序已存在，无需重复添加".into());
    }
    let item = CustomOpener {
        id: format!(
            "custom:{}",
            uuid_v4()
        ),
        name,
        exec,
        extensions,
    };
    cfg.custom.push(item.clone());
    save_config(&app, &cfg)?;
    Ok(OpenerItem {
        id: item.id,
        name: item.name,
        kind: "custom".into(),
        detected: true,
        exec: Some(item.exec),
        cli: false,
        extensions: item.extensions,
    })
}

/// 删除自定义打开方式
#[tauri::command]
pub fn remove_custom_opener(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut cfg = load_config(&app);
    cfg.custom.retain(|c| c.id != id);
    save_config(&app, &cfg)
}

/// 列出可用终端
#[tauri::command]
pub fn list_shells() -> Vec<ShellItem> {
    detect::shell_items()
}

/// 在指定目录打开终端（仅右键调用）
#[tauri::command]
pub fn open_terminal(shell_id: String, path: String) -> Result<(), String> {
    launch::launch_terminal(&shell_id, &path)
}

fn uuid_v4() -> String {
    // 极简 UUID v4（无外部依赖）：基于时间 + 随机数
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let rand = std::process::id() as u128 ^ now;
    format!("{now:016x}{rand:016x}")
}
