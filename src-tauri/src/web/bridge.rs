//! web 命令桥：POST /api/invoke 的分发表（首批 = 浏览/持久化/缩略图/预览）。
//!
//! 设计对齐：参数键名与前端 api.ts 的 camelCase 一致（等价于 Tauri 的
//! snake_case → camelCase 映射）；错误串沿用后端 `CODE|详情` 契约，前端
//! terr() 原样翻译；返回值 serde 序列化后与 tauri invoke 的 data 同构。
//!
//! 与 #[tauri::command] 的关系：持久化类命令（session/prefs/favorites/iconpos）
//! 在 lib.rs 中是「路径解析 + json_store 读写」薄包装，此处以 WebCtx 自己的
//! 目录镜像同一逻辑；纯逻辑类（fs_ops/themes/preview/thumbs/volumes/sizestat）
//! 直接复用模块函数。后续批次按需扩表（写操作、SFTP、搜索等）。
//!
//! 未收录命令统一返回 `WEB_UNSUPPORTED|...`——前端可见的明确降级信号，
//! 而非静默失败。

use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// web 运行时上下文（serve 构建一次，全部命令共享）
pub struct WebCtx {
    /// 与 GUI 同构的应用状态（SFTP 池/NFS 句柄/取消旗标/插件注册表）
    pub state: crate::AppState,
    /// 事件出口（WebEmitter；进度/变更事件经 WS 下发）
    pub sink: crate::events::EventSink,
    /// WebEmitter 持有者（WS 连接 subscribe 用）
    pub emitter: Arc<crate::events::WebEmitter>,
    /// 配置目录（session/prefs/favorites/themes/plugins 等落点）
    pub config_dir: PathBuf,
    /// 应用数据目录（thumbs/icon-positions 等缓存落点）
    pub data_dir: PathBuf,
    /// 访问令牌（cookie 交换与校验）
    pub token: String,
    /// 只读模式（首批桥无写类命令；后续批次接入时按此拒绝）
    pub read_only: bool,
}

/// 从 args 提取必填参数（键名 = 前端 camelCase）
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    let v = args
        .get(key)
        .cloned()
        .ok_or_else(|| format!("ARG_MISSING|缺少参数 {key}"))?;
    serde_json::from_value(v).map_err(|e| format!("ARG_TYPE|参数 {key} 不合法：{e}"))
}

/// 从 args 提取可空参数：缺失或 null → None（前端对 Option 参数恒传 null 占位）
fn opt_arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<Option<T>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(
            T::deserialize(v.clone()).map_err(|e| format!("ARG_TYPE|参数 {key} 不合法：{e}"))?,
        )),
    }
}

/// Result → Value（None → null；与 tauri invoke 的 Option 序列化一致）
fn val<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 写类命令清单：`--read-only` 时服务端统一拒绝（比 UI 隐藏更可靠的防线；
/// 新增写类命令必须同步登记，漏登记 = 只读模式出现写通道）。
/// 口径 = 修改被浏览的文件系统（本地或远端）。缓存性写入不算：缩略图缓存、
/// sftp_download 落临时目录（远程预览/打开的前置步骤）在只读模式下照常工作。
const WRITE_COMMANDS: &[&str] = &[
    "copy_entries",
    "move_entries",
    "copy_entries_plan",
    "move_entries_plan",
    "rename_entry",
    "delete_entries",
    "permanent_delete_entries",
    "restore_from_trash",
    "create_dir",
    "create_file",
    "compress_items",
    "extract_archive",
    // 远端写 / 落用户指定本地目录
    "sftp_download_to",
    "sftp_upload",
    // v0.44.0 SFTP↔SFTP 中转：写目标远端
    "sftp_relay",
    "sftp_mkdir",
    "sftp_create_file",
    "sftp_delete",
    "sftp_rename",
    "write_text_file",
    "http_download_to",
    // 写用户在服务端指定路径（导出类）
    "sftp_export_servers",
    "theme_export",
];

/// 声明式分发表：单一 match 生成 dispatch + 命令清单。
/// 新增桥接命令 = 加一行 `名称 => 处理函数`。
macro_rules! web_commands {
    ( $( $name:literal => $handler:ident ),* $(,)? ) => {
        pub async fn dispatch(
            ctx: &WebCtx,
            cmd: &str,
            args: &Value,
        ) -> Result<Value, String> {
            // 服务端只读门禁：写类命令在进入处理函数前拒绝
            if ctx.read_only && WRITE_COMMANDS.contains(&cmd) {
                return Err("READ_ONLY|只读模式拒绝写操作".into());
            }
            match cmd {
                $( $name => $handler(ctx, args).await, )*
                _ => Err(format!("WEB_UNSUPPORTED|命令 {cmd} 未在 web 模式提供")),
            }
        }
        /// 已桥接命令清单（诊断/未来 /api/caps 用）
        pub const COMMANDS: &[&str] = &[ $( $name ),* ];
    };
}

// ==================== 处理函数 ====================

async fn c_get_home_dir(_ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取主目录".to_string()))
}

async fn c_get_volumes(_ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(Ok(crate::volumes::list_volumes()))
}

async fn c_get_quick_access(_ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(Ok(crate::volumes::quick_access()))
}

/// 镜像 lib.rs parent_dir（本地 + http autoindex；根返回自身）
async fn c_parent_dir(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    if path.starts_with("http://") || path.starts_with("https://") {
        return val(Ok(crate::http_autoindex::parent_http_url(&path).unwrap_or(path)));
    }
    let p = std::path::Path::new(&path);
    match p.parent() {
        Some(parent) if parent.as_os_str() != p.as_os_str() => {
            val(Ok(parent.to_string_lossy().to_string()))
        }
        _ => val(Ok(path)),
    }
}

/// 全后端路由（smb/sftp/nfs/http/local），与 GUI list_dir 共用 list_side
async fn c_list_dir(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    val(crate::list_side(&ctx.state, &path).await)
}

async fn c_resolve_path(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let input: String = arg(args, "input")?;
    let cwd: String = arg(args, "cwd")?;
    val(Ok(crate::fs_ops::resolve_path(&input, &cwd)))
}

async fn c_complete_path(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let input: String = arg(args, "input")?;
    let cwd: String = arg(args, "cwd")?;
    tokio::task::spawn_blocking(move || crate::fs_ops::complete_path(&input, &cwd))
        .await
        .map_err(|e| e.to_string())
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 条目类型探测：全后端路由（与 GUI stat_path 共用 stat_path_core）
async fn c_stat_path(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    val(crate::stat_path_core(&ctx.state, path).await)
}

/// 镜像 lib.rs stat_paths（批量，等长 kind 列表）
async fn c_stat_paths(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let kinds: Vec<String> = paths
        .into_iter()
        .map(|p| match std::fs::metadata(&p) {
            Ok(m) if m.is_dir() => "dir".to_string(),
            Ok(m) if m.file_type().is_symlink() => "symlink".to_string(),
            Ok(_) => "file".to_string(),
            Err(_) => "missing".to_string(),
        })
        .collect();
    val(Ok(kinds))
}

async fn c_stat_entry(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    tokio::task::spawn_blocking(move || crate::fs_ops::stat_entry(&path))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_fs_watch_set(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let dirs: Vec<String> = arg(args, "dirs")?;
    crate::fs_watch::fs_watch_set(dirs);
    Ok(Value::Null)
}

// ---- 会话 / 收藏夹 / 偏好（镜像 lib.rs 同名命令：路径换 WebCtx 目录） ----

async fn c_session_load(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    let path = ctx.config_dir.join("session.json");
    tokio::task::spawn_blocking(move || {
        crate::json_store::read_json::<crate::SessionLayout>(
            &path,
            "读取会话失败",
            "解析会话失败",
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_session_save(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let layout: crate::SessionLayout = arg(args, "layout")?;
    let path = ctx.config_dir.join("session.json");
    tokio::task::spawn_blocking(move || {
        let json = serde_json::to_string_pretty(&layout).map_err(|e| e.to_string())?;
        crate::json_store::write_atomic(&path, &json, "写入会话失败", "保存会话失败")
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| Value::Null)
}

async fn c_session_clear(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    let path = ctx.config_dir.join("session.json");
    tokio::task::spawn_blocking(move || match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // 文件不存在时静默成功（镜像 lib.rs session_clear）
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清除会话失败：{e}")),
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| Value::Null)
}

async fn c_favorites_load(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    let path = ctx.config_dir.join("favorites.json");
    tokio::task::spawn_blocking(move || {
        crate::json_store::read_json::<crate::FavoritesFile>(
            &path,
            "读取收藏夹失败",
            "解析收藏夹失败",
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_favorites_save(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let items: Vec<crate::TabFavorite> = arg(args, "items")?;
    let path = ctx.config_dir.join("favorites.json");
    tokio::task::spawn_blocking(move || {
        let file = crate::FavoritesFile { version: 1, items };
        let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        crate::json_store::write_atomic(&path, &json, "写入收藏夹失败", "保存收藏夹失败")
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| Value::Null)
}

async fn c_prefs_load(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    let path = ctx.config_dir.join("prefs.json");
    tokio::task::spawn_blocking(move || {
        Ok(crate::json_store::read_json::<Value>(
            &path,
            "读取配置失败",
            "解析配置失败",
        )?
        .unwrap_or_else(|| Value::Object(serde_json::Map::new())))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn c_prefs_save(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let value: Value = arg(args, "value")?;
    let path = ctx.config_dir.join("prefs.json");
    tokio::task::spawn_blocking(move || {
        let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        crate::json_store::write_atomic(&path, &json, "写入配置失败", "保存配置失败")
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| Value::Null)
}

// ---- 图标位置 / 主题 / 插件 / 缩略图 / 预览 ----

async fn c_icon_positions_load(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    let path = ctx.data_dir.join("icon-positions.json");
    tokio::task::spawn_blocking(move || {
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => return Ok(Value::Object(serde_json::Map::new())),
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(v @ Value::Object(_)) => Ok(v),
            _ => Ok(Value::Object(serde_json::Map::new())),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn c_icon_positions_save(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let positions: Value = arg(args, "positions")?;
    if !positions.is_object() {
        return Err("位置表格式错误".to_string());
    }
    let dir = ctx.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
        let path = dir.join("icon-positions.json");
        let body = serde_json::to_string_pretty(&positions).map_err(|e| e.to_string())?;
        crate::json_store::write_atomic(&path, &body, "写入失败", "保存失败")
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| Value::Null)
}

/// 镜像 lib.rs themes_list（THEMES_DIR = config_dir/themes）
async fn c_themes_list(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    let dir = ctx.config_dir.join("themes");
    tokio::task::spawn_blocking(move || crate::themes::list_in(&dir))
        .await
        .map_err(|e| e.to_string())
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 镜像 lib.rs list_plugins（web 首批不桥接 NFS 伴生进程安装链路 → installed=false，
/// 已安装机器的 NFS 入口在 web 模式隐藏，属可接受降级）
async fn c_list_plugins(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    let map = ctx.state.plugins.enabled.lock().unwrap().clone();
    val(Ok(crate::plugins::builtin_plugins(&map, false)))
}

async fn c_thumb_get(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    let size: u32 = arg(args, "size")?;
    crate::thumbs::thumb_get_in(ctx.data_dir.join("thumbs"), path, size)
        .await
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_preview_data(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    crate::preview::preview_data(path)
        .await
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_probe_local_file(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    crate::preview::probe_local_file(path)
        .await
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 镜像 lib.rs compute_size（取消旗标 + sink 进度事件与 GUI 同构）
async fn c_compute_size(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    let paths: Vec<String> = arg(args, "paths")?;
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    ctx.state
        .size_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    let id_for_task = id.clone();
    let sink = ctx.sink.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::sizestat::compute(&id_for_task, &paths, &flag, |p| {
            sink.emit("size-progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string());
    ctx.state.size_cancels.lock().unwrap().remove(&id);
    val(result)
}

async fn c_cancel_size(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    if let Some(flag) = ctx.state.size_cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(Value::Null)
}

// ==================== 写类命令（复制/移动/删除/改名/新建/压缩/解压） ====================
// 均镜像 lib.rs 同名命令语义：transfer_cancels 取消旗标 + sink 进度/收尾帧，
// 前端进度条与取消按钮经 WS 同帧工作。

/// 注册可取消传输（镜像 lib.rs register_transfer_cancel；prefix 供前端取消路由判别）
fn register_transfer_cancel(ctx: &WebCtx, prefix: &str) -> (String, Arc<std::sync::atomic::AtomicBool>) {
    let id = format!("{prefix}{}", crate::next_transfer_id());
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    ctx.state
        .transfer_cancels
        .lock()
        .unwrap()
        .insert(id.clone(), flag.clone());
    (id, flag)
}

/// 镜像 lib.rs copy_entries / move_entries：同构进度回调 + 收尾帧，仅 phase 与
/// 回调产出不同（copy → Vec<String> 创建路径；move → (源,目标) 对）。
async fn run_local_transfer(
    ctx: &WebCtx,
    phase: &str,
    paths: Vec<String>,
    dest: String,
    plan: Option<std::collections::HashMap<String, crate::ops::Resolution>>,
) -> Result<Value, String> {
    let (id, flag) = register_transfer_cancel(ctx, "");
    let id_task = id.clone();
    let sink = ctx.sink.clone();
    let phase_owned = phase.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let n = paths.len();
        let mut done_entries = 0usize;
        let mut label = String::from("复制中…");
        let mut file_done = 0u64;
        let mut file_total = 0u64;
        let mut throttle = crate::progress::Throttle::new();
        let cb = &mut |ev: crate::ops::CbEvent| -> bool {
            if flag.load(Ordering::Relaxed) {
                return false;
            }
            match ev {
                crate::ops::CbEvent::Start(name) => {
                    label = name.to_string();
                    file_done = 0;
                    file_total = 0;
                    throttle.reset();
                }
                crate::ops::CbEvent::Bytes(done, total) => {
                    file_done = done;
                    file_total = total;
                    // 中间帧限频；每个文件的最后一帧随 EntryDone 立即发出
                    if !throttle.ready() {
                        return true;
                    }
                }
                crate::ops::CbEvent::EntryDone => done_entries += 1,
            }
            let mut p = crate::progress::TransferProgress::start(&phase_owned, &label, n);
            p.done_files = done_entries;
            p.file_done = file_done;
            p.file_total = file_total;
            p.id = Some(id_task.clone());
            crate::progress::emit(&sink, &p);
            true
        };
        // 四种形态返回类型不同（Vec<String> / Vec<(String,String)>），统一序列化后走同一收尾帧
        let r: Result<Value, String> = match (phase_owned.as_str(), plan) {
            ("copy", None) => {
                crate::ops::copy_entries(&paths, &dest, cb)
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            }
            ("move", None) => {
                crate::ops::move_entries(&paths, &dest, cb)
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            }
            ("copy", Some(resolutions)) => {
                crate::ops::copy_entries_plan(&paths, &dest, &resolutions, cb)
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            }
            ("move", Some(resolutions)) => {
                crate::ops::move_entries_plan(&paths, &dest, &resolutions, cb)
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            }
            _ => unreachable!("phase 恒为 copy/move"),
        };
        crate::emit_transfer_end(&sink, &phase_owned, n, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    ctx.state.transfer_cancels.lock().unwrap().remove(&id);
    result
}

async fn c_copy_entries(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let dest: String = arg(args, "dest")?;
    run_local_transfer(ctx, "copy", paths, dest, None).await
}

async fn c_move_entries(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let dest: String = arg(args, "dest")?;
    run_local_transfer(ctx, "move", paths, dest, None).await
}

async fn c_copy_entries_plan(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let dest: String = arg(args, "dest")?;
    let resolutions = arg(args, "resolutions")?;
    run_local_transfer(ctx, "copy", paths, dest, Some(resolutions)).await
}

async fn c_move_entries_plan(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let dest: String = arg(args, "dest")?;
    let resolutions = arg(args, "resolutions")?;
    run_local_transfer(ctx, "move", paths, dest, Some(resolutions)).await
}

async fn c_scan_conflicts(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let dest: String = arg(args, "dest")?;
    tokio::task::spawn_blocking(move || crate::ops::scan_conflicts(&paths, &dest))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_scan_dir_duplicates(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let dest: String = arg(args, "dest")?;
    tokio::task::spawn_blocking(move || crate::ops::scan_dir_duplicates(&paths, &dest))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_rename_entry(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    let new_name: String = arg(args, "newName")?;
    tokio::task::spawn_blocking(move || crate::ops::rename_entry(&path, &new_name))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_delete_entries(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    tokio::task::spawn_blocking(move || crate::ops::delete_entries(&paths))
        .await
        .map_err(|e| e.to_string())?
        .map(|_| Value::Null)
}

async fn c_permanent_delete_entries(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    tokio::task::spawn_blocking(move || crate::ops::permanent_delete_entries(&paths))
        .await
        .map_err(|e| e.to_string())?
        .map(|_| Value::Null)
}

async fn c_restore_from_trash(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    tokio::task::spawn_blocking(move || crate::ops::restore_from_trash(&paths))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_create_dir(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let parent: String = arg(args, "parent")?;
    let name: String = arg(args, "name")?;
    tokio::task::spawn_blocking(move || crate::ops::create_dir(&parent, &name))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_create_file(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let parent: String = arg(args, "parent")?;
    let name: String = arg(args, "name")?;
    tokio::task::spawn_blocking(move || crate::ops::create_file(&parent, &name))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_cancel_transfer(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    if let Some(flag) = ctx.state.transfer_cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(Value::Null)
}

/// 镜像 lib.rs compress_items（无取消链路，进度/收尾帧在 blocking 内发出）
async fn c_compress_items(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    let target_dir: String = arg(args, "targetDir")?;
    let format: String = arg(args, "format")?;
    let sink = ctx.sink.clone();
    tokio::task::spawn_blocking(move || {
        crate::compress::compress_items_blocking(&sink, paths, target_dir, format)
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 镜像 lib.rs extract_archive（取消旗标 + NEED_PASSWORD 密码重试契约原样透传）
async fn c_extract_archive(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    let target_dir: String = arg(args, "targetDir")?;
    let mode: Option<String> = opt_arg(args, "mode")?;
    let password: Option<String> = opt_arg(args, "password")?;
    let (id, flag) = register_transfer_cancel(ctx, "");
    let id_task = id.clone();
    let sink = ctx.sink.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::extract::run_extract(
            &sink,
            &id_task,
            &flag,
            &path,
            &target_dir,
            mode.as_deref().unwrap_or("smart"),
            password.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    ctx.state.transfer_cancels.lock().unwrap().remove(&id);
    result.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

// ==================== SFTP（第三批；NFS 插件链路不桥接） ====================
// servers.json 落 WebCtx.config_dir（与 GUI 共用同一份清单）；服务器管理/连接/传输
// 全部调 lib.rs 的 *_core 共享实现（合并/解密/主密钥回填逻辑单一来源）。

#[cfg(feature = "sftp")]
fn sftp_servers_path(ctx: &WebCtx) -> PathBuf {
    ctx.config_dir.join(crate::sftp::servers::SERVERS_FILE)
}

#[cfg(feature = "sftp")]
async fn c_sftp_list_servers(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(crate::sftp_list_servers_core(&ctx.state, &sftp_servers_path(ctx)).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_save_server(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let server = arg(args, "server")?;
    val(crate::sftp_save_server_core(&ctx.state, &sftp_servers_path(ctx), server).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_remove_server(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    val(crate::sftp_remove_server_core(&ctx.state, &sftp_servers_path(ctx), id).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_set_server_group(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let ids: Vec<String> = arg(args, "ids")?;
    let group: String = arg(args, "group")?;
    val(crate::sftp_set_server_group_core(&ctx.state, &sftp_servers_path(ctx), ids, group).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_master_key_status(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(crate::sftp_master_key_status_core(&ctx.state, &sftp_servers_path(ctx)).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_set_master_key(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let key: String = arg(args, "key")?;
    val(crate::sftp_set_master_key_core(&ctx.state, &sftp_servers_path(ctx), key).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_reset_master_key(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(crate::sftp_reset_master_key_core(&ctx.state, &sftp_servers_path(ctx)).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_connect(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let server = arg(args, "server")?;
    val(crate::sftp_connect_core(&ctx.state, &sftp_servers_path(ctx), server).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_disconnect(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    crate::sftp_disconnect_core(&ctx.state, &sftp_servers_path(ctx), id).await?;
    Ok(Value::Null)
}

#[cfg(feature = "sftp")]
async fn c_sftp_download(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    let local_dir: Option<String> = opt_arg(args, "localDir")?;
    val(crate::sftp_download_core(&ctx.state, &ctx.sink, path, local_dir).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_download_to(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let local_dir: String = arg(args, "localDir")?;
    let path: String = arg(args, "path")?;
    let overwrite: Option<bool> = opt_arg(args, "overwrite")?;
    val(crate::sftp_download_to_core(&ctx.state, &ctx.sink, local_dir, path, overwrite).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_upload(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let local: String = arg(args, "local")?;
    let dest: String = arg(args, "dest")?;
    let name: String = arg(args, "name")?;
    val(crate::sftp_upload_core(&ctx.state, &ctx.sink, local, dest, name).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_relay(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let src: String = arg(args, "src")?;
    let dest_dir: String = arg(args, "destDir")?;
    let name: String = arg(args, "name")?;
    let local_dir: Option<String> = opt_arg(args, "localDir")?;
    val(crate::sftp_relay_core(&ctx.state, &ctx.sink, src, dest_dir, name, local_dir).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_mkdir(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let dir: String = arg(args, "dir")?;
    let name: String = arg(args, "name")?;
    crate::ensure_plugin(&ctx.state, "sftp")?;
    let pool = ctx.state.sftp_pool.lock().await;
    val(crate::sftp::mkdir(&pool, &dir, &name).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_create_file(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let dir: String = arg(args, "dir")?;
    let name: String = arg(args, "name")?;
    crate::ensure_plugin(&ctx.state, "sftp")?;
    let pool = ctx.state.sftp_pool.lock().await;
    val(crate::sftp::create_file(&pool, &dir, &name).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_delete(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    crate::ensure_plugin(&ctx.state, "sftp")?;
    let pool = ctx.state.sftp_pool.lock().await;
    crate::sftp::delete_entries(&pool, &paths)
        .await
        .map(|_| Value::Null)
}

#[cfg(feature = "sftp")]
async fn c_sftp_rename(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    let new_name: String = arg(args, "newName")?;
    crate::ensure_plugin(&ctx.state, "sftp")?;
    let pool = ctx.state.sftp_pool.lock().await;
    val(crate::sftp::rename_entry(&pool, &path, &new_name).await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_export_servers(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let target: String = arg(args, "target")?;
    let exported_at: String = arg(args, "exportedAt")?;
    let master_key: Option<String> = opt_arg(args, "masterKey")?;
    val(crate::sftp_export_servers_core(
        &ctx.state,
        &sftp_servers_path(ctx),
        target,
        exported_at,
        master_key,
    )
    .await)
}

#[cfg(feature = "sftp")]
async fn c_sftp_import_servers(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let file_path: String = arg(args, "filePath")?;
    let master_key: Option<String> = opt_arg(args, "masterKey")?;
    val(crate::sftp_import_servers_core(
        &ctx.state,
        &sftp_servers_path(ctx),
        file_path,
        master_key,
    )
    .await)
}

/// 未编译 sftp feature 的构建：全部 SFTP 命令统一拒绝（与 GUI「SFTP 插件未编译」同文案）
#[cfg(not(feature = "sftp"))]
macro_rules! sftp_stubs {
    ( $( $name:ident ),* $(,)? ) => {
        $(
            async fn $name(_ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
                Err("SFTP 插件未编译（该构建已拔出远程功能）".into())
            }
        )*
    };
}
#[cfg(not(feature = "sftp"))]
sftp_stubs!(
    c_sftp_list_servers,
    c_sftp_save_server,
    c_sftp_remove_server,
    c_sftp_set_server_group,
    c_sftp_master_key_status,
    c_sftp_set_master_key,
    c_sftp_reset_master_key,
    c_sftp_connect,
    c_sftp_disconnect,
    c_sftp_download,
    c_sftp_download_to,
    c_sftp_upload,
    c_sftp_mkdir,
    c_sftp_create_file,
    c_sftp_delete,
    c_sftp_rename,
    c_sftp_export_servers,
    c_sftp_import_servers,
);

// ==================== 比对 / 文本 / 搜索 / 杂项 ====================

/// 目录差异比对（两侧任意后端组合；diff-progress 经 sink，层级按后端能力钳制）
async fn c_diff_dirs(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    let left: String = arg(args, "left")?;
    let right: String = arg(args, "right")?;
    let level: u8 = arg(args, "level")?;
    let case_sensitive: bool = arg(args, "caseSensitive")?;
    let mtime_tolerance_ms: i64 = arg(args, "mtimeToleranceMs")?;
    val(crate::diff_dirs_core(
        &ctx.state,
        &ctx.sink,
        id,
        left,
        right,
        level,
        case_sensitive,
        mtime_tolerance_ms,
    )
    .await)
}

async fn c_cancel_diff(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    if let Some(flag) = ctx.state.diff_cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(Value::Null)
}

async fn c_diff_text_files(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let left: String = arg(args, "left")?;
    let right: String = arg(args, "right")?;
    let encoding: Option<String> = opt_arg(args, "encoding")?;
    val(crate::diff_text_files_core(&ctx.state, left, right, encoding).await)
}

async fn c_read_text_file(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    val(crate::read_text_file_core(&ctx.state, path).await)
}

async fn c_write_text_file(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    let lines: Vec<String> = arg(args, "lines")?;
    let eol: String = arg(args, "eol")?;
    let encoding: Option<String> = opt_arg(args, "encoding")?;
    crate::write_text_file_core(&ctx.state, path, lines, eol, encoding)
        .await
        .map(|_| Value::Null)
}

async fn c_search_content(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let query: String = arg(args, "query")?;
    let dir: String = arg(args, "dir")?;
    let recursive: bool = arg(args, "recursive")?;
    let case_sensitive: bool = arg(args, "caseSensitive")?;
    let include_hidden: bool = arg(args, "includeHidden")?;
    let use_regex: bool = arg(args, "useRegex")?;
    let max_depth: Option<usize> = opt_arg(args, "maxDepth")?;
    let exclude_globs: Option<Vec<String>> = opt_arg(args, "excludeGlobs")?;
    tokio::task::spawn_blocking(move || {
        crate::search::search_content(
            &query,
            &dir,
            recursive,
            case_sensitive,
            include_hidden,
            use_regex,
            max_depth,
            &exclude_globs.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_find_files(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let pattern: String = arg(args, "pattern")?;
    let dir: String = arg(args, "dir")?;
    let show_hidden: bool = arg(args, "showHidden")?;
    let max_depth: Option<usize> = opt_arg(args, "maxDepth")?;
    let glob: bool = arg(args, "glob")?;
    let case_sensitive: bool = arg(args, "caseSensitive")?;
    tokio::task::spawn_blocking(move || {
        crate::find::find_files(&pattern, &dir, show_hidden, max_depth, glob, case_sensitive)
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

// ==================== 全盘索引（v0.45） ====================

/// 惰性启动共享索引器（web 模式无 setup 钩子，首条 index_* 命令启动）；
/// 同时同步插件开关（设置分区/搜索面板轮询状态即完成同步）
fn index_with_ctx(ctx: &WebCtx) -> &'static std::sync::Arc<crate::indexer::Indexer> {
    let ix = crate::indexer::ensure(&ctx.config_dir, {
        crate::plugins::plugin_enabled(&ctx.state.plugins, "index-search")
    });
    ix.sync_enabled(&ctx.state.plugins);
    ix
}

async fn c_index_status(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(Ok(index_with_ctx(ctx).status()))
}

/// v0.46 启动路径拉取（桌面端 Explorer/Finder 右键集成）；web 模式无「带路径启动」语义，恒空
async fn c_launch_paths_take(_ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    Ok(Value::Array(vec![]))
}

async fn c_index_search(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let query: String = arg(args, "query")?;
    let case_sensitive: bool = arg(args, "caseSensitive")?;
    let glob: bool = arg(args, "glob")?;
    let regex: bool = arg(args, "regex")?;
    let is_dir: Option<bool> = opt_arg(args, "isDir")?;
    let show_hidden: bool = opt_arg(args, "showHidden")?.unwrap_or(false);
    let ix = index_with_ctx(ctx);
    // spawn_blocking 需要owned 数据：插件开关表克隆一份（PluginState.enabled 是 pub 字段）
    let enabled_map = ctx.state.plugins.enabled.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || {
        let ps = crate::plugins::PluginState {
            enabled: std::sync::Mutex::new(enabled_map),
        };
        crate::indexer::search_checked(&ps, &ix, &query, case_sensitive, glob, regex, is_dir, show_hidden)
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_index_rebuild(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    index_with_ctx(ctx).rebuild();
    val(Ok(()))
}

async fn c_index_get_config(ctx: &WebCtx, _args: &Value) -> Result<Value, String> {
    val(Ok(index_with_ctx(ctx).get_config()))
}

async fn c_index_set_config(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let roots: Vec<String> = arg(args, "roots")?;
    let exclusions: Vec<String> = arg(args, "exclusions")?;
    let rescan_interval_secs: u64 = arg(args, "rescanIntervalSecs")?;
    let watch_enabled: bool = arg(args, "watchEnabled")?;
    index_with_ctx(ctx).set_config(roots, exclusions, rescan_interval_secs, watch_enabled)?;
    val(Ok(()))
}

async fn c_file_fingerprints(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = arg(args, "paths")?;
    tokio::task::spawn_blocking(move || crate::fs_ops::file_fingerprints(&paths))
        .await
        .map_err(|e| e.to_string())
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 镜像 lib.rs remote_temp_info（camelCase 载荷：path/files/bytes）
async fn c_remote_temp_info(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let local_dir: Option<String> = opt_arg(args, "localDir")?;
    let dir = crate::remote_temp::resolve_temp_dir(local_dir.as_deref());
    let (bytes, files) = crate::remote_temp::temp_usage(&dir);
    Ok(serde_json::json!({
        "path": dir.to_string_lossy(),
        "files": files,
        "bytes": bytes,
    }))
}

async fn c_remote_temp_clear(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let local_dir: Option<String> = opt_arg(args, "localDir")?;
    val(crate::remote_temp::clear_temp(
        &crate::remote_temp::resolve_temp_dir(local_dir.as_deref()),
    ))
}

async fn c_http_download_to(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let local_dir: String = arg(args, "localDir")?;
    let url: String = arg(args, "url")?;
    val(crate::http_autoindex::http_download_to_core(&ctx.state, &ctx.sink, local_dir, url).await)
}

async fn c_cancel_http_download(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let url: String = arg(args, "url")?;
    crate::http_autoindex::cancel_http_download(url);
    Ok(Value::Null)
}

// ==================== 主题管理 / 插件开关 ====================
// 与 GUI 共用 config_dir/themes 与 plugins.json（主题调色盘保存、插件开关即改即生效）

async fn c_theme_install(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    let dir = crate::themes::themes_dir_in(&ctx.config_dir);
    tokio::task::spawn_blocking(move || crate::themes::install_into(&dir, std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_theme_delete(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    let dir = crate::themes::themes_dir_in(&ctx.config_dir);
    tokio::task::spawn_blocking(move || crate::themes::delete_in(&dir, &id))
        .await
        .map_err(|e| e.to_string())?
        .map(|_| Value::Null)
}

async fn c_theme_save(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let pack = arg(args, "pack")?;
    let dir = crate::themes::themes_dir_in(&ctx.config_dir);
    tokio::task::spawn_blocking(move || crate::themes::save_into(&dir, pack))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn c_theme_export(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let pack = arg(args, "pack")?;
    let path: String = arg(args, "path")?;
    tokio::task::spawn_blocking(move || crate::themes::export_to(std::path::Path::new(&path), pack))
        .await
        .map_err(|e| e.to_string())?
        .map(|_| Value::Null)
}

async fn c_set_plugin_enabled(ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "id")?;
    let enabled: bool = arg(args, "enabled")?;
    val(crate::set_plugin_enabled_core(&ctx.state, &ctx.config_dir, id, enabled))
}

// ==================== 分发表 ====================
// 首批：浏览/持久化/缩略图/预览/属性统计；第二批：写类（复制/移动/删除/改名/新建/压缩/解压）。

web_commands! {
    "get_home_dir" => c_get_home_dir,
    "get_volumes" => c_get_volumes,
    "get_quick_access" => c_get_quick_access,
    "parent_dir" => c_parent_dir,
    "list_dir" => c_list_dir,
    "resolve_path" => c_resolve_path,
    "complete_path" => c_complete_path,
    "stat_path" => c_stat_path,
    "stat_paths" => c_stat_paths,
    "stat_entry" => c_stat_entry,
    "fs_watch_set" => c_fs_watch_set,
    "session_load" => c_session_load,
    "session_save" => c_session_save,
    "session_clear" => c_session_clear,
    "favorites_load" => c_favorites_load,
    "favorites_save" => c_favorites_save,
    "prefs_load" => c_prefs_load,
    "prefs_save" => c_prefs_save,
    "icon_positions_load" => c_icon_positions_load,
    "icon_positions_save" => c_icon_positions_save,
    "themes_list" => c_themes_list,
    "list_plugins" => c_list_plugins,
    "thumb_get" => c_thumb_get,
    "preview_data" => c_preview_data,
    "probe_local_file" => c_probe_local_file,
    "compute_size" => c_compute_size,
    "cancel_size" => c_cancel_size,
    // ---- 写类（--read-only 时服务端拒绝） ----
    "copy_entries" => c_copy_entries,
    "move_entries" => c_move_entries,
    "copy_entries_plan" => c_copy_entries_plan,
    "move_entries_plan" => c_move_entries_plan,
    "scan_conflicts" => c_scan_conflicts,
    "scan_dir_duplicates" => c_scan_dir_duplicates,
    "rename_entry" => c_rename_entry,
    "delete_entries" => c_delete_entries,
    "permanent_delete_entries" => c_permanent_delete_entries,
    "restore_from_trash" => c_restore_from_trash,
    "create_dir" => c_create_dir,
    "create_file" => c_create_file,
    "cancel_transfer" => c_cancel_transfer,
    "compress_items" => c_compress_items,
    "extract_archive" => c_extract_archive,
    // ---- 第三批：SFTP（NFS 插件链路不桥接） ----
    "sftp_list_servers" => c_sftp_list_servers,
    "sftp_save_server" => c_sftp_save_server,
    "sftp_remove_server" => c_sftp_remove_server,
    "sftp_set_server_group" => c_sftp_set_server_group,
    "sftp_master_key_status" => c_sftp_master_key_status,
    "sftp_set_master_key" => c_sftp_set_master_key,
    "sftp_reset_master_key" => c_sftp_reset_master_key,
    "sftp_connect" => c_sftp_connect,
    "sftp_disconnect" => c_sftp_disconnect,
    "sftp_download" => c_sftp_download,
    "sftp_download_to" => c_sftp_download_to,
    "sftp_upload" => c_sftp_upload,
    "sftp_relay" => c_sftp_relay,
    "sftp_mkdir" => c_sftp_mkdir,
    "sftp_create_file" => c_sftp_create_file,
    "sftp_delete" => c_sftp_delete,
    "sftp_rename" => c_sftp_rename,
    "sftp_export_servers" => c_sftp_export_servers,
    "sftp_import_servers" => c_sftp_import_servers,
    // ---- 比对 / 文本 / 搜索 / 杂项 ----
    "diff_dirs" => c_diff_dirs,
    "cancel_diff" => c_cancel_diff,
    "diff_text_files" => c_diff_text_files,
    "read_text_file" => c_read_text_file,
    "write_text_file" => c_write_text_file,
    "search_content" => c_search_content,
    "find_files" => c_find_files,
    "index_status" => c_index_status,
    "launch_paths_take" => c_launch_paths_take,
    "index_search" => c_index_search,
    "index_rebuild" => c_index_rebuild,
    "index_get_config" => c_index_get_config,
    "index_set_config" => c_index_set_config,
    "file_fingerprints" => c_file_fingerprints,
    "remote_temp_info" => c_remote_temp_info,
    "remote_temp_clear" => c_remote_temp_clear,
    "http_download_to" => c_http_download_to,
    "cancel_http_download" => c_cancel_http_download,
    // ---- 主题管理 / 插件开关 ----
    "theme_install" => c_theme_install,
    "theme_delete" => c_theme_delete,
    "theme_save" => c_theme_save,
    "theme_export" => c_theme_export,
    "set_plugin_enabled" => c_set_plugin_enabled,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dispatch_rejects_unknown_with_coded_error() {
        // 未收录命令 → WEB_UNSUPPORTED 码化错误（terr 剥前缀显示详情）
        let ctx = WebCtx {
            state: crate::AppState::default(),
            sink: crate::events::EventSink::new(Arc::new(test_emitter())),
            emitter: Arc::new(crate::events::WebEmitter::new()),
            config_dir: std::env::temp_dir(),
            data_dir: std::env::temp_dir(),
            token: "t".into(),
            read_only: false,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // 用永远不会成为真实命令的名字：桥表扩容不会再让本用例失效
        let err = rt
            .block_on(dispatch(&ctx, "__no_such_command__", &json!({})))
            .unwrap_err();
        assert!(err.starts_with("WEB_UNSUPPORTED|"), "{err}");
        assert!(err.contains("__no_such_command__"));
    }

    #[test]
    fn read_only_rejects_write_commands_before_handlers() {
        let ctx = WebCtx {
            state: crate::AppState::default(),
            sink: crate::events::EventSink::new(Arc::new(test_emitter())),
            emitter: Arc::new(crate::events::WebEmitter::new()),
            config_dir: std::env::temp_dir(),
            data_dir: std::env::temp_dir(),
            token: "t".into(),
            read_only: true,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // 写类命令（含缺参数形态）：门禁在参数提取前拒绝 → READ_ONLY 码
        for cmd in ["delete_entries", "extract_archive", "create_dir"] {
            let err = rt.block_on(dispatch(&ctx, cmd, &json!({}))).unwrap_err();
            assert!(err.starts_with("READ_ONLY|"), "{cmd}: {err}");
        }
        // 非写命令不受只读影响
        let ok = rt.block_on(dispatch(&ctx, "get_home_dir", &json!({})));
        assert!(ok.is_ok());
        // 写命令清单与分发表登记一致性：WRITE_COMMANDS 的每项都必须已桥接
        // （漏登记 = 拒绝了一个不存在的命令；反向漏登记 = 只读模式出现写通道）
        for w in WRITE_COMMANDS {
            assert!(COMMANDS.contains(w), "WRITE_COMMANDS 含未桥接命令 {w}");
        }
    }

    #[test]
    fn arg_extraction_camel_case_and_errors() {
        let args = json!({ "path": "/tmp", "size": 64 });
        let p: String = arg(&args, "path").unwrap();
        assert_eq!(p, "/tmp");
        let s: u32 = arg(&args, "size").unwrap();
        assert_eq!(s, 64);
        // camelCase 键（newName）与缺失键错误码
        let args2 = json!({ "newName": "b.txt" });
        let n: String = arg(&args2, "newName").unwrap();
        assert_eq!(n, "b.txt");
        let err = arg::<String>(&args, "newName").unwrap_err();
        assert!(err.starts_with("ARG_MISSING|"), "{err}");
        let err = arg::<u32>(&args, "path").unwrap_err();
        assert!(err.starts_with("ARG_TYPE|"), "{err}");
    }

    #[test]
    fn command_list_covers_first_slice() {
        // 首批桥接的锚点命令在场（防手滑改名导致前端静默降级）
        for must in [
            "list_dir",
            "get_volumes",
            "get_home_dir",
            "session_load",
            "prefs_load",
            "favorites_load",
            "themes_list",
            "list_plugins",
            "thumb_get",
            "preview_data",
            "fs_watch_set",
            // 第二批写类锚点
            "copy_entries",
            "move_entries",
            "delete_entries",
            "rename_entry",
            "create_dir",
            "compress_items",
            "extract_archive",
            // 第三批：SFTP / 比对 / 文本 / 搜索锚点
            "sftp_list_servers",
            "sftp_connect",
            "sftp_upload",
            "sftp_relay",
            "sftp_download_to",
            "diff_dirs",
            "diff_text_files",
            "read_text_file",
            "write_text_file",
            "search_content",
            "find_files",
            "index_search",
            "index_status",
            "theme_save",
            "set_plugin_enabled",
        ] {
            assert!(COMMANDS.contains(&must), "缺少桥接命令 {must}");
        }
    }

    #[test]
    fn read_only_keeps_remote_preview_but_blocks_remote_writes() {
        // 只读口径：sftp_download（落临时目录，远程预览前置）不在写清单；
        // 远端写与落用户目录的下载在写清单
        assert!(!WRITE_COMMANDS.contains(&"sftp_download"));
        assert!(!WRITE_COMMANDS.contains(&"read_text_file"));
        assert!(!WRITE_COMMANDS.contains(&"diff_dirs"));
        for w in [
            "sftp_upload",
            "sftp_relay",
            "sftp_delete",
            "sftp_rename",
            "sftp_mkdir",
            "sftp_create_file",
            "sftp_download_to",
            "write_text_file",
            "http_download_to",
        ] {
            assert!(WRITE_COMMANDS.contains(&w), "写清单缺 {w}");
        }
    }

    // ---- 测试辅助 ----

    struct NopEmitter;
    impl crate::events::Emitter for NopEmitter {
        fn emit_json(&self, _event: &str, _payload: Value) {}
    }
    fn test_emitter() -> NopEmitter {
        NopEmitter
    }
}
