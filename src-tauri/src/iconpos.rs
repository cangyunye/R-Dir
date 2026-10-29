//! 大图标模式「图标自由摆放」位置存储（v0.27.0）。
//!
//! 访达用目录内 .DS_Store 记录图标摆放；R-Dir 选择集中存储——应用数据目录下
//! 一份 `icon-positions.json`，按「目录路径 → 条目名 → 槽位 [列, 行]」索引。
//! 好处：不往被浏览的目录写任何文件、SFTP 远程目录同样生效。代价：目录改名/
//! 移动后位置记录失效（按失效记录布局会自动退回自动排列，无副作用）。
//!
//! 结构（与前端 api.ts 的 IconPositionMap 对齐，serde 默认驼峰无字段名差异）：
//! `{ "/Users/x/Desktop": { "a.zip": [2, 0] }, "sftp://host/data": { ... } }`

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use tauri::Manager;

/// 位置文件路径（app_data_dir/icon-positions.json）。
fn positions_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir.join("icon-positions.json"))
}

/// 全量读取位置表；文件缺失/损坏返回空表（静默降级，不弹错）。
#[tauri::command]
pub fn icon_positions_load(app: tauri::AppHandle) -> Result<Value, String> {
    let path = positions_file(&app)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(Value::Object(serde_json::Map::new())),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(v @ Value::Object(_)) => Ok(v),
        _ => Ok(Value::Object(serde_json::Map::new())),
    }
}

/// 全量写回位置表（前端整体持有该表，防冲突用「读-改-写整表」而非增量）。
/// 先写临时文件再原子改名，避免写一半崩溃损坏数据。
#[tauri::command]
pub fn icon_positions_save(app: tauri::AppHandle, positions: Value) -> Result<(), String> {
    if !positions.is_object() {
        return Err("位置表格式错误".to_string());
    }
    let path = positions_file(&app)?;
    let body = serde_json::to_string_pretty(&positions).map_err(|e| e.to_string())?;
    crate::json_store::write_atomic(&path, &body, "写入失败", "保存失败")
}

/// 目录维度上限防御：异常大的表（历史脏数据）在读取侧不截断（避免丢数据），
/// 仅在文档中说明；写侧压缩为 BTreeMap 顺序保证 diff 稳定。
pub type Positions = BTreeMap<String, BTreeMap<String, [i64; 2]>>;
