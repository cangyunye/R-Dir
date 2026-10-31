//! 主题包（rdir-theme/1）：用户安装的纯数据配色包。
//!
//! 设计约束：包内只有颜色 token，不执行代码、不注入 CSS 文本；本模块只负责
//! 在 app_config_dir()/themes/ 下读写与结构校验，能否安全应用由前端白名单 +
//! CSSOM 赋值兜底。字体 / 圆角 / 行为开关一律不开放。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const THEME_SCHEMA: &str = "rdir-theme/1";
pub const THEMES_DIR: &str = "themes";
/// 64 KiB：纯 token 包远小于此，限制只防误装大文件
pub const MAX_THEME_BYTES: u64 = 64 * 1024;
/// token 数量上限（白名单本身 23 个，留出以后扩展余量）
const MAX_TOKENS: usize = 128;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePack {
    #[serde(rename = "$schema", default)]
    pub schema: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub version: String,
    /// light | dark：只决定 <html> 是否加 .dark（组件的 dark: 变体依赖该信号）
    #[serde(default = "default_base")]
    pub base: String,
    /// token 名 → CSS 值；缺省项回落到 base 对应的内置主题
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
}

fn default_base() -> String {
    "light".into()
}

#[derive(Serialize)]
pub struct ThemeLoadError {
    pub file: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct ThemesList {
    pub packs: Vec<ThemePack>,
    pub errors: Vec<ThemeLoadError>,
}

/// id 同时用作文件名：只允许小写字母/数字/连字符，杜绝路径穿越
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    let first = b[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn validate(pack: &ThemePack) -> Result<(), String> {
    if !pack.schema.is_empty() && pack.schema != THEME_SCHEMA {
        return Err(format!("不支持的主题包版本：{}", pack.schema));
    }
    if !valid_id(&pack.id) {
        return Err("主题包 id 无效（小写字母/数字/连字符，≤64 字符）".into());
    }
    let name = pack.name.trim();
    if name.is_empty() {
        return Err("主题包缺少名称".into());
    }
    if name.chars().count() > 40 {
        return Err("主题包名称超过 40 字".into());
    }
    if pack.base != "light" && pack.base != "dark" {
        return Err("主题包 base 只能是 light 或 dark".into());
    }
    if pack.tokens.len() > MAX_TOKENS {
        return Err(format!("主题包 token 数量超过 {MAX_TOKENS}"));
    }
    for (key, value) in &pack.tokens {
        if !key.starts_with("--") || key.len() > 64 {
            return Err(format!("主题包 token 名无效：{key}"));
        }
        if key
            .bytes()
            .any(|c| c.is_ascii_whitespace() || c == b';' || c == b'{' || c == b'}')
        {
            return Err(format!("主题包 token 名包含非法字符：{key}"));
        }
        if value.len() > 200 || value.contains(';') || value.contains('{') || value.contains('}') {
            return Err(format!("主题包 token 值无效：{key}"));
        }
    }
    Ok(())
}

/// 读取并校验单个包文件（列表与安装共用）
fn read_pack(path: &Path) -> Result<ThemePack, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取主题包失败：{e}"))?;
    if meta.len() > MAX_THEME_BYTES {
        return Err(format!("主题包超过 {} KB", MAX_THEME_BYTES / 1024));
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取主题包失败：{e}"))?;
    let pack: ThemePack =
        serde_json::from_str(&raw).map_err(|e| format!("解析主题包失败：{e}"))?;
    validate(&pack)?;
    Ok(pack)
}

/// 扫描目录：坏包进 errors，不阻塞其他包；目录不存在视为空列表
pub fn list_in(dir: &Path) -> ThemesList {
    let mut packs = Vec::new();
    let mut errors = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return ThemesList { packs, errors };
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or_default()
            .to_string();
        match read_pack(&path) {
            Ok(pack) => packs.push(pack),
            Err(message) => errors.push(ThemeLoadError { file, message }),
        }
    }
    packs.sort_by(|a, b| a.id.cmp(&b.id));
    errors.sort_by(|a, b| a.file.cmp(&b.file));
    ThemesList { packs, errors }
}

/// 安装：读取 → 校验 → 原子写入 themes/<id>.json；同 id 已存在直接报错（不覆盖）
pub fn install_into(dir: &Path, src: &Path) -> Result<ThemePack, String> {
    let mut pack = read_pack(src)?;
    pack.name = pack.name.trim().to_string();
    let dest = dir.join(format!("{}.json", pack.id));
    if dest.exists() {
        return Err(format!("同名主题已安装：{}", pack.id));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建主题目录失败：{e}"))?;
    let body = serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?;
    crate::json_store::write_atomic(&dest, &body, "写入主题包失败", "保存主题包失败")?;
    Ok(pack)
}

/// 删除：id 先过校验再拼路径；文件不存在视为成功
pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("主题包标识无效".into());
    }
    match std::fs::remove_file(dir.join(format!("{id}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除主题包失败：{e}")),
    }
}

fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join(THEMES_DIR))
}

#[tauri::command]
pub async fn themes_list(app: tauri::AppHandle) -> Result<ThemesList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = themes_dir(&app)?;
        Ok(list_in(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn theme_install(app: tauri::AppHandle, path: String) -> Result<ThemePack, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = themes_dir(&app)?;
        install_into(&dir, Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn theme_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = themes_dir(&app)?;
        delete_in(&dir, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rdir-themes-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_pack(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    const GOOD: &str = r#"{
        "$schema": "rdir-theme/1",
        "id": "autumn-gold",
        "name": "  金秋  ",
        "base": "light",
        "tokens": { "--primary": "oklch(0.55 0.14 68)", "--shadow": "0 12px 32px rgb(80 50 10 / 0.18)" }
    }"#;

    #[test]
    fn id_rules() {
        assert!(valid_id("autumn-gold"));
        assert!(valid_id("a1"));
        assert!(!valid_id(""));
        assert!(!valid_id("-a"));
        assert!(!valid_id("Autumn"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a.b"));
        assert!(!valid_id(&"a".repeat(65)));
    }

    #[test]
    fn install_list_delete_roundtrip() {
        let dir = tmp_dir("roundtrip");
        let src_dir = dir.join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = write_pack(&src_dir, "pack.rdtheme.json", GOOD);
        let pack = install_into(&dir, &src).unwrap();
        assert_eq!(pack.name, "金秋");
        assert!(dir.join("autumn-gold.json").exists());

        let list = list_in(&dir);
        assert_eq!(list.packs.len(), 1);
        assert!(list.errors.is_empty());
        assert_eq!(list.packs[0].tokens["--primary"], "oklch(0.55 0.14 68)");

        // 同 id 重复安装报错
        let err = install_into(&dir, &src).unwrap_err();
        assert!(err.contains("同名主题已安装"), "{err}");

        delete_in(&dir, "autumn-gold").unwrap();
        assert!(!dir.join("autumn-gold.json").exists());
        // 不存在视为成功
        delete_in(&dir, "autumn-gold").unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_packs_go_to_errors_without_blocking() {
        let dir = tmp_dir("errors");
        let _ = write_pack(&dir, "autumn-gold.json", GOOD);
        let _ = write_pack(
            &dir,
            "bad-id.json",
            r#"{"id":"Bad Id","name":"x","base":"light"}"#,
        );
        let list = list_in(&dir);
        assert_eq!(list.packs.len(), 1);
        assert_eq!(list.errors.len(), 1);
        assert_eq!(list.errors[0].file, "bad-id.json");
    }

    #[test]
    fn rejects_bad_base_and_empty_name() {
        let dir = tmp_dir("validate");
        let src = write_pack(
            &dir,
            "x.json",
            r#"{"id":"x","name":"","base":"light"}"#,
        );
        assert!(install_into(&dir, &src).unwrap_err().contains("缺少名称"));
        let src = write_pack(&dir, "y.json", r#"{"id":"y","name":"Y","base":"mid"}"#);
        assert!(install_into(&dir, &src).unwrap_err().contains("base"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_file() {
        let dir = tmp_dir("oversize");
        let body = format!(
            r#"{{"id":"big","name":"Big","tokens":{{"--primary":"{}"}}}}"#,
            "x".repeat(MAX_THEME_BYTES as usize)
        );
        let src = write_pack(&dir, "big.json", &body);
        assert!(install_into(&dir, &src).unwrap_err().contains("超过"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_rejects_traversal() {
        let dir = tmp_dir("traversal");
        assert!(delete_in(&dir, "../etc/passwd").is_err());
        assert!(delete_in(&dir, "a/b").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
