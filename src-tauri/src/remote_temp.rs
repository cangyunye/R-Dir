//! 远程文件「打开」临时目录（后端无关：SFTP / HTTP 及未来远程存储共用）。
//! 双击/右键打开远程文件都先下载到这里再交给系统应用；默认 <temp>/r-dir-remote，
//! 可在设置中改为自定义目录；路径确定，程序可整体统计与清空。
//! 独立于 sftp feature（只碰文件系统），服务所有远程后端。

use std::path::{Path, PathBuf};

/// 默认临时目录：<temp>/r-dir-remote
pub fn open_temp_dir() -> PathBuf {
    std::env::temp_dir().join("r-dir-remote")
}

/// 解析生效的打开临时目录：未配置（None / 空串 / 纯空白）回退默认，否则原样使用自定义路径
pub fn resolve_temp_dir(custom: Option<&str>) -> PathBuf {
    match custom.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => open_temp_dir(),
    }
}

/// 统计临时目录占用（文件数与总字节；目录不存在按空计）
pub fn temp_usage(dir: &Path) -> (u64, u32) {
    let mut bytes = 0u64;
    let mut files = 0u32;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    bytes += m.len();
                    files += 1;
                }
            }
        }
    }
    (bytes, files)
}

/// 清空临时目录，返回释放的字节数（目录不存在视为已空）
pub fn clear_temp(dir: &Path) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let (bytes, _) = temp_usage(dir);
    std::fs::remove_dir_all(dir).map_err(|e| format!("清理临时目录失败：{e}"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未配置（None / 空串 / 纯空白）回退默认目录，配置了原样使用
    #[test]
    fn resolve_temp_dir_fallback_and_custom() {
        assert_eq!(resolve_temp_dir(None), open_temp_dir());
        assert_eq!(resolve_temp_dir(Some("")), open_temp_dir());
        assert_eq!(resolve_temp_dir(Some("   ")), open_temp_dir());
        let custom = std::env::temp_dir().join("rdir-test-custom-temp");
        assert_eq!(
            resolve_temp_dir(Some(custom.to_str().unwrap())),
            custom,
            "自定义目录原样使用（不自动补建）"
        );
    }

    /// 打开临时目录：占用统计与整体清理（目录不存在按空计，清理后自动消失）
    #[test]
    fn open_temp_dir_usage_and_clear() {
        let dir = std::env::temp_dir().join("rdir-test-open-temp");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(temp_usage(&dir), (0, 0), "目录不存在按空计");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.bin"), [0u8; 12]).unwrap();
        std::fs::write(dir.join("b.bin"), [0u8; 8]).unwrap();
        assert_eq!(temp_usage(&dir), (20, 2));
        assert_eq!(clear_temp(&dir).unwrap(), 20);
        assert!(!dir.exists(), "清理后目录整个移除（下次打开自动重建）");
        assert_eq!(clear_temp(&dir).unwrap(), 0, "重复清理安全无副作用");
    }
}
