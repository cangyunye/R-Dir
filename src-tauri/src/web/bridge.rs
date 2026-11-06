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

/// Result → Value（None → null；与 tauri invoke 的 Option 序列化一致）
fn val<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 声明式分发表：单一 match 生成 dispatch + 命令清单。
/// 新增桥接命令 = 加一行 `名称 => 处理函数`。
macro_rules! web_commands {
    ( $( $name:literal => $handler:ident ),* $(,)? ) => {
        pub async fn dispatch(
            ctx: &WebCtx,
            cmd: &str,
            args: &Value,
        ) -> Result<Value, String> {
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

async fn c_list_dir(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    tokio::task::spawn_blocking(move || crate::fs_ops::list_dir(&path))
        .await
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
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

/// 条目类型探测：web 首批仅本地路径（远程后端路由未桥接，明确报错）
async fn c_stat_path(_ctx: &WebCtx, args: &Value) -> Result<Value, String> {
    let path: String = arg(args, "path")?;
    if crate::fs_ops::is_scheme_path(&path) {
        return Err("WEB_UNSUPPORTED|web 模式暂不支持远程路径探测".into());
    }
    let kind = match std::fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_symlink() => "symlink",
        Ok(m) if m.is_dir() => "dir",
        Ok(_) => "file",
        Err(e) => return Err(format!("路径不可访问：{e}")),
    };
    val(Ok(kind))
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

// ==================== 分发表（首批：浏览/持久化/缩略图/预览/属性统计） ====================

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
        let err = rt
            .block_on(dispatch(&ctx, "copy_entries", &json!({})))
            .unwrap_err();
        assert!(err.starts_with("WEB_UNSUPPORTED|"), "{err}");
        assert!(err.contains("copy_entries"));
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
        ] {
            assert!(COMMANDS.contains(&must), "缺少桥接命令 {must}");
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
