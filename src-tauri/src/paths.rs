//! 应用数据目录解析（v0.43 收敛 + 便携模式）。
//!
//! 此前 session/prefs/servers/themes/plugins/openers/cmd-index/iconpos/thumbs
//! 十余处各自调 `app.path().app_config_dir()` / `app_data_dir()`，便携版（绿色版）
//! 无处落脚。收敛后统一走 [`config_dir`] / [`data_dir`]：
//!
//! - 安装版：行为不变，走 Tauri dirs（Windows `%APPDATA%\com.rfm.app` 等）
//! - 便携版：主程序同目录存在 `R-Dir.portable` 标记文件时，全部数据落到
//!   `exe_dir/data/{config,data}`——免安装、随目录整体搬迁、卸载即净
//!
//! 便携目录在此处确保存在（write_atomic 不建父目录，安装版首写的目录由
//! 系统侧既有行为保证，此处仅在便携分支兜底）。未来 `rdir-web` 无窗口运行时
//! 也复用本模块（AppHandle 以外的解析不依赖 Tauri 运行时）。

use std::path::{Path, PathBuf};
use tauri::Manager;

/// 便携模式标记文件名（与主程序同目录；存在且为文件即启用便携模式）
pub const PORTABLE_MARKER: &str = "R-Dir.portable";

/// 便携模式数据根：exe 旁有 `R-Dir.portable` 标记 → `exe_dir/data`，否则 None。
/// 纯路径推演不触磁盘（标记存在性判断除外），供测试注入 exe 路径。
fn portable_root_for(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    if dir.join(PORTABLE_MARKER).is_file() {
        Some(dir.join("data"))
    } else {
        None
    }
}

/// 当前进程的便携数据根（AppHandle 无关；rdir-web bin 与诊断用）。
/// 便携模式 → `exe_dir/data`；安装模式 → None。
pub fn portable_data_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    portable_root_for(&exe)
}

/// 配置目录（session.json / prefs.json / servers.json / themes/ / plugins/ 等）。
/// 便携模式 → `data/config`（确保存在）；安装版 → Tauri app_config_dir。
pub fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::current_exe().ok().and_then(|exe| portable_root_for(&exe)) {
        let dir = root.join("config");
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建便携配置目录：{e}"))?;
        return Ok(dir);
    }
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))
}

/// 应用数据目录（缓存性质：thumbs/、icon-positions.json）。
/// 便携模式 → `data/data`（确保存在）；安装版 → Tauri app_data_dir。
pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::current_exe().ok().and_then(|exe| portable_root_for(&exe)) {
        let dir = root.join("data");
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建便携数据目录：{e}"))?;
        return Ok(dir);
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rdir-paths-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn portable_root_requires_marker_file() {
        let dir = tmp_dir("marker");
        let exe = dir.join("R-Dir.exe");
        // 无标记 → 非便携
        assert_eq!(portable_root_for(&exe), None);
        // 标记为目录 → 不算（is_file 校验，防误判同名文件夹）
        std::fs::create_dir(dir.join(PORTABLE_MARKER)).unwrap();
        assert_eq!(portable_root_for(&exe), None);
        std::fs::remove_dir(dir.join(PORTABLE_MARKER)).unwrap();
        // 标记文件 → 便携，数据根 = exe 旁 data/
        std::fs::write(dir.join(PORTABLE_MARKER), b"").unwrap();
        assert_eq!(portable_root_for(&exe), Some(dir.join("data")));
        // exe 移入更深层级（macOS .app/Contents/MacOS 形态）→ 只认直接父目录，
        // 祖先目录的标记不生效（防上层无关目录的标记误伤嵌套安装）
        let nested = dir.join("Contents").join("MacOS").join("R-Dir");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        assert_eq!(portable_root_for(&nested), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn portable_root_none_for_exe_without_parent() {
        // 单段路径无父目录 → None（防御 current_exe 的极端形态）
        assert_eq!(portable_root_for(Path::new("R-Dir.exe")), None);
    }
}
