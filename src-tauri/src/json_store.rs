//! JSON 配置文件持久化工具（v0.34.1 收敛）：原子写与读取的公共实现。
//! 此前 session/favorites/prefs/plugins/iconpos/cmd-index/openers 七处
//! 各自复制了一份「写临时文件 + rename」样板（及三处 read+parse）。

use std::path::Path;
use serde::de::DeserializeOwned;

/// 原子写文本文件：先写同目录临时文件（`with_extension("json.tmp")`），成功后
/// rename 覆盖目标——写一半崩溃不会损坏旧数据。write_msg / rename_msg 为失败时
/// 的用户可见文案前缀（各调用方沿用原文案，如「写入会话失败」/「保存会话失败」）。
pub fn write_atomic(path: &Path, body: &str, write_msg: &str, rename_msg: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("{write_msg}：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{rename_msg}：{e}"))?;
    Ok(())
}

/// 读取 JSON 文件；文件不存在返回 None。read_msg / parse_msg 为失败文案前缀。
pub fn read_json<T: DeserializeOwned>(path: &Path, read_msg: &str, parse_msg: &str) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{read_msg}：{e}"))?;
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("{parse_msg}：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("rdir-jsonstore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.json");

        write_atomic(&path, "{\"a\":1}", "写失败", "存失败").unwrap();
        let v: Option<serde_json::Value> = read_json(&path, "读失败", "解析失败").unwrap();
        assert_eq!(v, Some(serde_json::json!({"a": 1})));

        // 覆盖写 + 残留临时文件被清理（rename 后 tmp 不存在）
        write_atomic(&path, "{\"a\":2}", "写失败", "存失败").unwrap();
        let v: Option<serde_json::Value> = read_json(&path, "读失败", "解析失败").unwrap();
        assert_eq!(v, Some(serde_json::json!({"a": 2})));
        assert!(!path.with_extension("json.tmp").exists());

        // 错误文案透传
        let err = write_atomic(&dir.join("no/such/dir/x.json"), "{}", "写入X失败", "保存X失败").unwrap_err();
        assert!(err.starts_with("写入X失败"), "{err}");

        // 缺文件 → None
        let none: Option<serde_json::Value> = read_json(&dir.join("missing.json"), "读失败", "解析失败").unwrap();
        assert_eq!(none, None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
