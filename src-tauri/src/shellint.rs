//! 系统外壳右键集成（v0.46）：Explorer / Finder 打开入口的注册与注销。
//!
//! - Windows：写 HKCU `Software\Classes`（免管理员），目录 / 目录空白处 / 文件三处
//!   右键各注册一个 `OpenWithRDir` 动词，命令形如 `"R-Dir.exe" "%V"` —— 二次启动经
//!   single-instance 转发进已运行实例（新建标签）。安装版由 NSIS 钩子预注册
//!   （nsis/hooks.nsi），便携版 / 手动开关走本模块的命令（设置 → 系统集成）。
//! - macOS：Finder 集成走 Info.plist 文档类型（打包期合并，见 tauri.conf.json
//!   `bundle.macOS.infoPlist`），文件右键「打开方式 → R-Dir」、文件夹/文件拖 Dock 图标
//!   均以 odoc 事件送达（RunEvent::Opened）；注册表类运行时开关不存在，状态恒为不支持。
//! - Linux：右键集成走 `.desktop` 文件（未实现，状态恒为不支持）。

use serde::Serialize;

/// 三处右键的注册状态（camelCase 直出前端）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellIntegrationStatus {
    /// 平台是否支持运行时注册（仅 Windows）
    pub supported: bool,
    pub directory: bool,
    pub background: bool,
    pub files: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::ShellIntegrationStatus;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    /// 三处动词键（`*` 是字面键名 = 所有文件类型）
    const VERB_KEYS: [(&str, &str); 3] = [
        (
            r"Software\Classes\Directory\shell\OpenWithRDir",
            "%V",
        ),
        (
            r"Software\Classes\Directory\Background\shell\OpenWithRDir",
            "%V",
        ),
        (r"Software\Classes\*\shell\OpenWithRDir", "%1"),
    ];

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    /// 单处注册状态：动词键存在且 command 默认值非空即视为已注册
    fn registered(path: &str) -> bool {
        let root = hkcu();
        root.open_subkey(format!("{path}\\command"))
            .and_then(|k| k.get_value::<String, _>(""))
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }

    pub fn status() -> ShellIntegrationStatus {
        ShellIntegrationStatus {
            supported: true,
            directory: registered(VERB_KEYS[0].0),
            background: registered(VERB_KEYS[1].0),
            files: registered(VERB_KEYS[2].0),
        }
    }

    pub fn register(exe: &str, label: &str) -> Result<(), String> {
        if label.trim().is_empty() {
            return Err("标签为空".into());
        }
        let root = hkcu();
        for (path, arg) in VERB_KEYS {
            let key = root
                .create_subkey(path)
                .map_err(|e| format!("{}: {e}", path))?
                .0;
            key.set_value("", &label)
                .map_err(|e| format!("{} 默认值: {e}", path))?;
            key.set_value("Icon", &exe)
                .map_err(|e| format!("{} Icon: {e}", path))?;
            let cmd = key
                .create_subkey("command")
                .map_err(|e| format!("{}\\command: {e}", path))?
                .0;
            cmd.set_value("", &format!("\"{}\" \"{}\"", exe, arg))
                .map_err(|e| format!("{}\\command 默认值: {e}", path))?;
        }
        Ok(())
    }

    pub fn unregister() -> Result<(), String> {
        let root = hkcu();
        for (path, _) in VERB_KEYS {
            // 不存在时删除报错属正常，跳过不阻断
            root.delete_subkey_all(path).ok();
        }
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::ShellIntegrationStatus;

    pub fn status() -> ShellIntegrationStatus {
        ShellIntegrationStatus {
            supported: false,
            directory: false,
            background: false,
            files: false,
        }
    }

    pub fn register(_exe: &str, _label: &str) -> Result<(), String> {
        Err("当前平台无需运行时注册（macOS 经 Info.plist 打包期声明，Linux 暂未实现）".into())
    }

    pub fn unregister() -> Result<(), String> {
        Err("当前平台无需运行时注销".into())
    }
}

pub use imp::{register, status, unregister};

#[cfg(test)]
mod tests {
    use super::*;

    /// 非平台测试只验证状态结构可序列化（Windows 分支的真值需在真机上人工验证：
    /// 设置 → 系统集成 → 注册后 HKCU 出现三处 OpenWithRDir 键）
    #[test]
    fn status_serializes() {
        let s = status();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("supported"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn register_unregister_roundtrip() {
        let label = "R-Dir（测试）";
        register("C:\\nonexistent\\R-Dir.exe", label).unwrap();
        let s = status();
        assert!(s.directory && s.background && s.files);
        unregister().unwrap();
        let s = status();
        assert!(!s.directory && !s.background && !s.files);
    }
}
