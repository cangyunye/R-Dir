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

/// 常用工具条条目（v0.29.0，openers.json 的 quickTools 有序数组 = 显示顺序）
#[derive(Serialize, Deserialize, Clone)]
pub struct QuickTool {
    pub id: String,
    pub name: String,
    pub exec: String,
    /// 启动参数串（v0.31.1）：引号感知切分，支持 `{path}` / `{dir}` / `$pwd` / `{name}` 占位符；
    /// 空 = 默认行为（终端类只设 cwd，其他工具 `exec <path>`）。旧配置无此字段按空处理。
    #[serde(default)]
    pub args: String,
}

/// QuickTool → 前端条目（detected 实时判断，卸载的置灰）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuickToolItem {
    pub id: String,
    pub name: String,
    pub exec: String,
    pub args: String,
    pub detected: bool,
}

fn to_quick_item(q: &QuickTool) -> QuickToolItem {
    QuickToolItem {
        id: q.id.clone(),
        name: q.name.clone(),
        exec: q.exec.clone(),
        args: q.args.clone(),
        detected: std::path::Path::new(&q.exec).exists(),
    }
}

/// 常用工具条上限（与标签/快捷访问交互一致：达上限拒绝并提示）
pub const MAX_QUICK_TOOLS: usize = 10;

#[derive(Serialize, Deserialize, Default)]
struct OpenersConfig {
    #[serde(default)]
    custom: Vec<CustomOpener>,
    #[serde(default)]
    quick_tools: Vec<QuickTool>,
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
    let mut cfg = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // 历史坏数据自愈（v0.33 win 首跑暴露）：探测曾把无扩展名脚本（VS Code bin\code）
    // 当可执行入库，CreateProcess 启动必报 os error 193 → 同目录同名 .exe/.cmd 改指
    if migrate_extensionless_execs(&mut cfg) {
        let _ = save_config(app, &cfg);
    }
    cfg
}

/// 无扩展名 exec 的修复目标：同目录同名 .exe / .cmd 存在则返回（坏数据自愈用）。
/// Windows 上无扩展名文件不可由 CreateProcess 执行（sh 脚本 → os error 193）。
fn fix_extensionless_exec(exec: &str) -> Option<String> {
    let p = std::path::Path::new(exec);
    if p.extension().is_some() || !p.exists() {
        return None;
    }
    let dir = p.parent()?;
    let stem = p.file_name()?.to_str()?;
    ["exe", "cmd"].iter().find_map(|ext| {
        let cand = dir.join(format!("{stem}.{ext}"));
        cand.exists().then(|| cand.to_string_lossy().into_owned())
    })
}

/// 修复 openers.json 里的历史坏数据（仅 quickTools——自定义打开方式走文件对话框
/// 选 .exe，进不来这种路径）。返回是否有改动，由 load_config 落盘。
fn migrate_extensionless_execs(cfg: &mut OpenersConfig) -> bool {
    let mut changed = false;
    for q in &mut cfg.quick_tools {
        if let Some(fixed) = fix_extensionless_exec(&q.exec) {
            q.exec = fixed;
            changed = true;
        }
    }
    changed
}

fn save_config(app: &tauri::AppHandle, cfg: &OpenersConfig) -> Result<(), String> {
    let p = config_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    // 原子写：先写临时文件再 rename
    let data = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败：{e}"))?;
    crate::json_store::write_atomic(&p, &data, "写入配置失败", "保存配置失败")
}

/// 归一化扩展名列表：去空白、去前导点、小写、去重（保留顺序）
pub fn normalize_exts(exts: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in exts {
        let n = e.trim().trim_start_matches('.').to_lowercase();
        if !n.is_empty() && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// CustomOpener → 前端条目（detected 实时判断）
fn to_item(c: &CustomOpener) -> OpenerItem {
    OpenerItem {
        id: c.id.clone(),
        name: c.name.clone(),
        kind: "custom".into(),
        detected: std::path::Path::new(&c.exec).exists(),
        exec: Some(c.exec.clone()),
        cli: false,
        extensions: c.extensions.clone(),
    }
}

/// 列出现有打开方式（内置探测 + Agent + 用户自定义）
#[tauri::command]
pub fn list_openers(app: tauri::AppHandle) -> Vec<OpenerItem> {
    // v0.6.3 起只返回用户自定义注册的打开方式，不再探测系统内置工具
    load_config(&app).custom.iter().map(to_item).collect()
}

/// 用指定工具打开路径（参数数组，零注入）
#[tauri::command]
pub fn open_with(
    app: tauri::AppHandle,
    tool_id: String,
    path: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if !crate::plugins::plugin_enabled(&state.plugins, "opener") {
        return Err("“打开方式”插件已禁用（设置 → 插件中可重新启用）".into());
    }
    let cfg = load_config(&app);
    if let Some(c) = cfg.custom.iter().find(|x| x.id == tool_id) {
        return launch::launch_custom(&c.exec, &path);
    }
    Err(format!("未找到工具：{tool_id}"))
}

/// 添加自定义打开方式（仅接受"可执行文件路径"，不接受命令字符串）
/// 同一可执行文件重复添加时合并扩展名（不报错、不重复建项）。
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
    let extensions = normalize_exts(&extensions);
    let mut cfg = load_config(&app);
    // 已注册同 exec → 合并扩展名
    if let Some(c) = cfg.custom.iter_mut().find(|c| c.exec == exec) {
        for e in extensions {
            if !c.extensions.contains(&e) {
                c.extensions.push(e);
            }
        }
        let item = to_item(c);
        save_config(&app, &cfg)?;
        return Ok(item);
    }
    let item = CustomOpener {
        id: format!("custom:{}", uuid_v4()),
        name,
        exec,
        extensions,
    };
    cfg.custom.push(item.clone());
    save_config(&app, &cfg)?;
    Ok(to_item(&item))
}

/// 覆盖设置某个打开方式的关联扩展名（设置面板增删扩展后保存）
#[tauri::command]
pub fn set_opener_extensions(
    app: tauri::AppHandle,
    id: String,
    extensions: Vec<String>,
) -> Result<(), String> {
    let mut cfg = load_config(&app);
    let c = cfg
        .custom
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("未找到打开方式：{id}"))?;
    c.extensions = normalize_exts(&extensions);
    save_config(&app, &cfg)
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

/// 是否探测到 VSCode（v0.29.0 右键「用 VSCode 打开」）
#[tauri::command]
pub fn vscode_detected() -> bool {
    detect::find_vscode().detected()
}

/// 「Git 打开」工具清单（v0.29.0，含未安装项，detected 标记）
#[tauri::command]
pub fn list_git_tools() -> Vec<detect::GitToolItem> {
    detect::git_tool_items()
}

/// 用 VSCode 打开路径（文件/目录均可）
#[tauri::command]
pub fn open_vscode(
    path: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if !crate::plugins::plugin_enabled(&state.plugins, "opener") {
        return Err("“打开方式”插件已禁用（设置 → 插件中可重新启用）".into());
    }
    launch::launch_vscode(&path)
}

/// 在指定目录打开 Git 工具（Git Bash / GUI 客户端）
#[tauri::command]
pub fn open_git_tool(
    tool_id: String,
    path: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if !crate::plugins::plugin_enabled(&state.plugins, "terminal") {
        return Err("“终端”插件已禁用（设置 → 插件中可重新启用）".into());
    }
    launch::launch_git_tool(&tool_id, &path)
}

// ───────────────── v0.29.0 常用工具条 ─────────────────

/// 纯函数：加入常用条（同 exec 去重、上限收敛）。返回 Err = 达上限。
fn quick_add(
    cfg: &mut OpenersConfig,
    id: Option<String>,
    name: String,
    exec: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    let exec = exec.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if exec.is_empty() {
        return Err("可执行文件路径不能为空".into());
    }
    if cfg.quick_tools.iter().any(|q| q.exec == exec) {
        return Ok(()); // 同一可执行文件只进一次（幂等，不报错）
    }
    if cfg.quick_tools.len() >= MAX_QUICK_TOOLS {
        return Err(format!("常用工具最多 {} 个", MAX_QUICK_TOOLS));
    }
    cfg.quick_tools.push(QuickTool {
        id: id.unwrap_or_else(|| format!("qt:{}", uuid_v4())),
        name,
        exec,
        args: String::new(),
    });
    Ok(())
}

/// 纯函数：设置启动参数串（找不到 id 报错）
fn quick_set_args(cfg: &mut OpenersConfig, id: &str, args: &str) -> Result<(), String> {
    let q = cfg
        .quick_tools
        .iter_mut()
        .find(|q| q.id == id)
        .ok_or_else(|| format!("未找到常用工具：{id}"))?;
    q.args = args.trim().to_string();
    Ok(())
}

/// 纯函数：移除
fn quick_remove(cfg: &mut OpenersConfig, id: &str) {
    cfg.quick_tools.retain(|q| q.id != id);
}

/// 纯函数：上移/下移（越界静默忽略）
fn quick_move(cfg: &mut OpenersConfig, id: &str, up: bool) {
    let Some(pos) = cfg.quick_tools.iter().position(|q| q.id == id) else {
        return;
    };
    let target = if up { pos.checked_sub(1) } else { Some(pos + 1) };
    let Some(target) = target else { return };
    if target >= cfg.quick_tools.len() {
        return;
    }
    cfg.quick_tools.swap(pos, target);
}

#[tauri::command]
pub fn list_quick_tools(app: tauri::AppHandle) -> Vec<QuickToolItem> {
    load_config(&app)
        .quick_tools
        .iter()
        .map(to_quick_item)
        .collect()
}

/// 添加常用工具（id 缺省生成；建议芯片传稳定 slug 以便 VSCode 固定行去重）。
/// 返回最新清单。同 exec 幂等。
#[tauri::command]
pub fn add_quick_tool(
    app: tauri::AppHandle,
    id: Option<String>,
    name: String,
    exec: String,
) -> Result<Vec<QuickToolItem>, String> {
    let mut cfg = load_config(&app);
    quick_add(&mut cfg, id, name, exec)?;
    save_config(&app, &cfg)?;
    Ok(cfg.quick_tools.iter().map(to_quick_item).collect())
}

#[tauri::command]
pub fn remove_quick_tool(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<QuickToolItem>, String> {
    let mut cfg = load_config(&app);
    quick_remove(&mut cfg, &id);
    save_config(&app, &cfg)?;
    Ok(cfg.quick_tools.iter().map(to_quick_item).collect())
}

#[tauri::command]
pub fn move_quick_tool(
    app: tauri::AppHandle,
    id: String,
    up: bool,
) -> Result<Vec<QuickToolItem>, String> {
    let mut cfg = load_config(&app);
    quick_move(&mut cfg, &id, up);
    save_config(&app, &cfg)?;
    Ok(cfg.quick_tools.iter().map(to_quick_item).collect())
}

/// 设置常用工具的启动参数串（v0.31.1）。返回最新清单。
#[tauri::command]
pub fn set_quick_tool_args(
    app: tauri::AppHandle,
    id: String,
    args: String,
) -> Result<Vec<QuickToolItem>, String> {
    let mut cfg = load_config(&app);
    quick_set_args(&mut cfg, &id, &args)?;
    save_config(&app, &cfg)?;
    Ok(cfg.quick_tools.iter().map(to_quick_item).collect())
}

/// 用常用工具打开路径（目录 = 作为工作区打开 / 终端类在该目录开窗；文件 = 用该工具打开）
#[tauri::command]
pub fn open_quick_tool(
    app: tauri::AppHandle,
    id: String,
    path: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if !crate::plugins::plugin_enabled(&state.plugins, "opener") {
        return Err("“打开方式”插件已禁用（设置 → 插件中可重新启用）".into());
    }
    let cfg = load_config(&app);
    let q = cfg
        .quick_tools
        .iter()
        .find(|q| q.id == id)
        .ok_or_else(|| format!("未找到常用工具：{id}"))?;
    launch::launch_quick_tool(&q.exec, &q.args, &path)
}

/// 「检测到本机已安装」建议清单（常用工具条设置分区用）
#[tauri::command]
pub fn detect_editors() -> Vec<detect::EditorCandidate> {
    detect::editor_candidates()
}

/// 在指定目录打开终端（仅右键调用）
#[tauri::command]
pub fn open_terminal(
    shell_id: String,
    path: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if !crate::plugins::plugin_enabled(&state.plugins, "terminal") {
        return Err("“终端”插件已禁用（设置 → 插件中可重新启用）".into());
    }
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

#[cfg(test)]
mod tests {
    use super::{normalize_exts, quick_add, quick_move, quick_remove, quick_set_args, OpenersConfig};

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn quick_tool_args_default_for_old_config() {
        // v0.29 写出的 openers.json 没有 args 字段，反序列化必须兼容
        let json = r#"{"custom":[],"quick_tools":[{"id":"a","name":"A","exec":"/a"}]}"#;
        let cfg: OpenersConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.quick_tools.len(), 1);
        assert_eq!(cfg.quick_tools[0].args, "");
    }

    #[test]
    fn quick_set_args_trims_and_rejects_unknown() {
        let mut cfg = OpenersConfig::default();
        quick_add(&mut cfg, Some("gb".into()), "Git Bash".into(), r"C:\Git\git-bash.exe".into()).unwrap();
        quick_set_args(&mut cfg, "gb", "  --cd={dir}  ").unwrap();
        assert_eq!(cfg.quick_tools[0].args, "--cd={dir}");
        quick_set_args(&mut cfg, "gb", "").unwrap();
        assert_eq!(cfg.quick_tools[0].args, "");
        assert!(quick_set_args(&mut cfg, "nope", "x").is_err());
    }

    #[test]
    fn normalize_lowercases_strips_dot_and_trims() {
        assert_eq!(normalize_exts(&v(&[" .JSON ", "Yaml"])), v(&["json", "yaml"]));
    }

    #[test]
    fn normalize_dedups_keeping_order() {
        assert_eq!(normalize_exts(&v(&["json", ".JSON", "json", "yaml"])), v(&["json", "yaml"]));
    }

    #[test]
    fn normalize_drops_empty_and_blank() {
        assert_eq!(normalize_exts(&v(&["", "  ", ".", "txt"])), v(&["txt"]));
    }

    #[test]
    fn normalize_keeps_star() {
        assert_eq!(normalize_exts(&v(&["*"])), v(&["*"]));
    }

    #[test]
    fn quick_add_dedupes_by_exec_and_caps() {
        let mut cfg = OpenersConfig::default();
        quick_add(&mut cfg, Some("a".into()), "A".into(), "/a".into()).unwrap();
        // 同 exec 幂等
        quick_add(&mut cfg, Some("b".into()), "B".into(), "/a".into()).unwrap();
        assert_eq!(cfg.quick_tools.len(), 1);
        assert_eq!(cfg.quick_tools[0].id, "a");
        // 稳定 id 生效、缺省生成 qt: 前缀
        quick_add(&mut cfg, None, "C".into(), "/c".into()).unwrap();
        assert!(cfg.quick_tools[1].id.starts_with("qt:"));
        // 上限收敛
        for i in 0..super::MAX_QUICK_TOOLS {
            let _ = quick_add(&mut cfg, None, format!("X{i}"), format!("/x{i}"));
        }
        assert_eq!(cfg.quick_tools.len(), super::MAX_QUICK_TOOLS);
        assert!(quick_add(&mut cfg, None, "Y".into(), "/y".into()).is_err());
    }

    #[test]
    fn quick_add_rejects_blank() {
        let mut cfg = OpenersConfig::default();
        assert!(quick_add(&mut cfg, None, "  ".into(), "/a".into()).is_err());
        assert!(quick_add(&mut cfg, None, "A".into(), "  ".into()).is_err());
    }

    #[test]
    fn migrate_repoints_extensionless_exec_to_sibling() {
        // v0.33 曾把 VS Code 的 bin\code（sh 脚本）入库；同目录 code.cmd 存在 → 改指
        let base = std::env::temp_dir().join(format!("rdir-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("code"), "").unwrap();
        std::fs::write(base.join("code.cmd"), "").unwrap();
        let mut cfg = OpenersConfig::default();
        cfg.quick_tools.push(super::QuickTool {
            id: "vscode".into(),
            name: "Visual Studio Code".into(),
            exec: base.join("code").to_string_lossy().into_owned(),
            args: String::new(),
        });
        assert!(super::migrate_extensionless_execs(&mut cfg));
        assert_eq!(
            cfg.quick_tools[0].exec,
            base.join("code.cmd").to_string_lossy().into_owned()
        );
        // 幂等：修复后不再改动
        assert!(!super::migrate_extensionless_execs(&mut cfg));
        // 带扩展名的有效路径与悬空路径都不动
        cfg.quick_tools[0].exec = r"C:\Windows\System32\cmd.exe".into();
        assert!(!super::migrate_extensionless_execs(&mut cfg));
        cfg.quick_tools[0].exec = base.join("gone").to_string_lossy().into_owned();
        assert!(!super::migrate_extensionless_execs(&mut cfg));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn quick_move_and_remove() {
        let mut cfg = OpenersConfig::default();
        for (id, exec) in [("a", "/a"), ("b", "/b"), ("c", "/c")] {
            quick_add(&mut cfg, Some(id.into()), id.into(), exec.into()).unwrap();
        }
        quick_move(&mut cfg, "c", true);
        let order: Vec<&str> = cfg.quick_tools.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(order, ["a", "c", "b"]);
        // 越界静默
        quick_move(&mut cfg, "a", true);
        quick_move(&mut cfg, "b", false);
        assert_eq!(cfg.quick_tools.len(), 3);
        quick_remove(&mut cfg, "c");
        assert_eq!(cfg.quick_tools.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        quick_remove(&mut cfg, "missing");
        assert_eq!(cfg.quick_tools.len(), 2);
    }
}
