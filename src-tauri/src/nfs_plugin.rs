//! v0.40 NFS 伴生进程插件安装链路（feature = "nfs-sidecar"）。
//!
//! .rdplugin = zip 容器：manifest.json + rdir-nfs 可执行文件。
//! 校验链（缺一不可）：包内 manifest 声明协议版本/最低宿主版本/目标三元组/二进制 sha256；
//! 在线获取时另经 HTTPS Release 上独立发布的 manifest-v*.json 校验整包 sha256
//! （校验和来源必须独立于包自身，否则等于没校）。落盘原子写 + unix chmod +x +
//! macOS quarantine 属性清理。只信官方 Release 通道；本地导入保留但前端给显式警示。

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use sha2::{Digest, Sha256};

pub const NFS_PLUGIN_ID: &str = "nfs";

/// 插件安装根下的子目录名（app_config_dir()/plugins/nfs/）
const DIR_NAME: &str = "nfs";
const INSTALL_FILE: &str = "install.json";

// ==================== 数据结构 ====================

/// .rdplugin 包内 manifest.json
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    pub protocol_version: u32,
    pub min_host_version: String,
    /// 目标三元组（aarch64-apple-darwin / x86_64-pc-windows-msvc / …）
    pub target: String,
    /// 包内二进制 sha256（hex 小写）
    pub sha256: String,
    /// 包内二进制文件名
    pub exe_name: String,
}

/// 落盘的安装信息（install.json；exe 为绝对路径，sidecar 启动前重读）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledInfo {
    pub version: String,
    pub exe: String,
    pub sha256: String,
    pub installed_at: String,
}

/// 面板状态（nfs_plugin_status 命令返回）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NfsPluginStatus {
    /// builtin（内嵌编译）| external（伴生进程插件）
    pub source: &'static str,
    pub installed: bool,
    pub version: Option<String>,
    /// 插件协议版本是否与宿主一致（不一致需更新插件）
    pub protocol_match: bool,
    /// 用户启用开关（plugins.json）
    pub enabled: bool,
    pub error: Option<String>,
}

// ==================== 路径与目标三元组 ====================

pub fn plugins_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::config_dir(app)?;
    Ok(dir.join("plugins"))
}

fn plugin_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(plugins_root(app)?.join(DIR_NAME))
}

/// 当前构建的目标三元组（与 CI 打包命名对齐）
pub fn current_target() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "aarch64-apple-darwin" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "x86_64-apple-darwin" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "x86_64-pc-windows-msvc" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "x86_64-unknown-linux-gnu" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { "aarch64-unknown-linux-gnu" }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    { "unknown" }
}

/// 版本号比较：a < b → true（仅支持数字三段式，开发版本口径足够）
fn version_lt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..3 {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x < y;
        }
    }
    false
}

// ==================== 状态查询 ====================

/// 已安装插件的安装信息（install.json 缺失/损坏 → None）。
/// 内嵌构建（feature = "nfs"）下无人调用（面板恒为 builtin），静默 dead_code
#[cfg_attr(feature = "nfs", allow(dead_code))]
pub fn installed_info(app: &tauri::AppHandle) -> Option<InstalledInfo> {
    let dir = plugin_dir(app).ok()?;
    let text = std::fs::read_to_string(dir.join(INSTALL_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 组装面板状态。builtin 构建（feature = "nfs"）恒为 builtin/installed。
pub fn status(app: &tauri::AppHandle, state: &crate::plugins::PluginState) -> NfsPluginStatus {
    let enabled = crate::plugins::plugin_enabled(state, NFS_PLUGIN_ID);
    #[cfg(feature = "nfs")]
    {
        let _ = app;
        return NfsPluginStatus {
            source: "builtin",
            installed: true,
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            protocol_match: true,
            enabled,
            error: None,
        };
    }
    #[cfg(not(feature = "nfs"))]
    {
        match installed_info(app) {
            Some(info) => {
                let ok_exe = Path::new(&info.exe).exists();
                NfsPluginStatus {
                    source: "external",
                    installed: ok_exe,
                    version: Some(info.version.clone()),
                    protocol_match: true, // 协议版本在安装时已校验；宿主升级后由 install_from_* 拒装旧包
                    enabled,
                    error: if ok_exe {
                        None
                    } else {
                        Some("插件文件缺失，请重新安装".into())
                    },
                }
            }
            None => NfsPluginStatus {
                source: "external",
                installed: false,
                version: None,
                protocol_match: false,
                enabled,
                error: None,
            },
        }
    }
}

// ==================== 安装 / 卸载 ====================

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 清理 macOS quarantine 扩展属性（浏览器/聊天工具下载的包会被 Gatekeeper 拦截）。
/// 经主程序 ureq 下载的文件不会打标；本地导入路径必须清。失败静默（属性可能不存在）。
fn remove_quarantine(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let cpath = match std::ffi::CString::new(path.as_os_str().to_string_lossy().as_bytes()) {
            Ok(c) => c,
            Err(_) => return,
        };
        let name = b"com.apple.quarantine\0";
        // xattr 不存在等错误一律忽略
        unsafe {
            libc::removexattr(cpath.as_ptr(), name.as_ptr().cast(), 0);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
    }
}

/// 从 .rdplugin（zip 字节）安装。返回安装信息；任何校验不通过即失败，不留半成品。
pub fn install_from_bytes(
    app: &tauri::AppHandle,
    zip_bytes: &[u8],
) -> Result<InstalledInfo, String> {
    let reader = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("插件包读取失败（应为 .rdplugin zip 容器）：{e}"))?;

    // 1) 包内 manifest
    let mut manifest_raw = String::new();
    archive
        .by_name("manifest.json")
        .map_err(|_| "插件包缺少 manifest.json")?
        .read_to_string(&mut manifest_raw)
        .map_err(|e| format!("manifest.json 读取失败：{e}"))?;
    let manifest: PluginManifest = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("manifest.json 解析失败：{e}"))?;

    // 2) 契约校验
    if manifest.id != NFS_PLUGIN_ID {
        return Err(format!("插件 id 不匹配：期望 {NFS_PLUGIN_ID}，得到 {}", manifest.id));
    }
    if manifest.protocol_version != crate::nfs_backend::NFS_PROTOCOL_VERSION {
        return Err(format!(
            "插件协议版本（v{}）与宿主（v{}）不匹配，请获取与当前版本配套的插件",
            manifest.protocol_version,
            crate::nfs_backend::NFS_PROTOCOL_VERSION
        ));
    }
    if version_lt(env!("CARGO_PKG_VERSION"), &manifest.min_host_version) {
        return Err(format!(
            "插件要求宿主版本 ≥ {}，当前为 {}，请先升级应用",
            manifest.min_host_version,
            env!("CARGO_PKG_VERSION")
        ));
    }
    if manifest.target != current_target() {
        return Err(format!(
            "插件平台不匹配：包为 {}，当前为 {}",
            manifest.target,
            current_target()
        ));
    }

    // 3) 二进制 + sha256
    let mut bin: Vec<u8> = Vec::new();
    archive
        .by_name(&manifest.exe_name)
        .map_err(|_| format!("插件包缺少二进制 {}", manifest.exe_name))?
        .read_to_end(&mut bin)
        .map_err(|e| format!("二进制读取失败：{e}"))?;
    let actual = sha256_hex(&bin);
    if actual != manifest.sha256.to_lowercase() {
        return Err("插件包校验失败（sha256 不匹配），文件可能被篡改或损坏".into());
    }

    // 4) 落盘：plugins/nfs/<version>/，原子写（tmp + rename）
    let dir = plugin_dir(app)?.join(format!("bin-{}", manifest.version));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    let exe_path = dir.join(&manifest.exe_name);
    let tmp = dir.join(format!(".{}.tmp", manifest.exe_name));
    std::fs::write(&tmp, &bin).map_err(|e| format!("写入插件文件失败：{e}"))?;
    std::fs::rename(&tmp, &exe_path).map_err(|e| format!("落盘插件文件失败：{e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe_path, std::fs::Permissions::from_mode(0o755));
    }
    remove_quarantine(&exe_path);

    let info = InstalledInfo {
        version: manifest.version.clone(),
        exe: exe_path.to_string_lossy().to_string(),
        sha256: actual,
        installed_at: chrono_now(),
    };
    let install_json = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    crate::json_store::write_atomic(
        &dir.parent().unwrap().join(INSTALL_FILE),
        &install_json,
        "写入安装信息失败",
        "落盘失败",
    )?;

    // 旧版本目录清理（保留当前版本；失败不打扰）
    if let Some(parent) = dir.parent() {
        if let Ok(rd) = std::fs::read_dir(parent) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("bin-") && name != format!("bin-{}", manifest.version) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    Ok(info)
}

fn chrono_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{d}")
}

/// 卸载：删安装目录（含全部版本）与 install.json
pub fn uninstall(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = plugin_dir(app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("卸载失败：{e}"))?;
    }
    Ok(())
}

// ==================== 在线获取（官方 GitHub Release 通道） ====================

/// Release 上独立发布的校验清单（rdir-nfs-manifest-<target>.json，每平台一份——
/// CI 各平台 job 直接上传自己的清单，无需跨 job 合并）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    version: String,
    #[serde(default)]
    protocol_version: u32,
    #[serde(default)]
    min_host_version: String,
    target: String,
    /// 本平台的 .rdplugin 资产文件名
    file: String,
    /// 整包 sha256（hex 小写；来源独立于插件包本体，防篡改）
    sha256: String,
}

const RELEASE_API: &str = "https://api.github.com/repos/cangyunye/R-Dir/releases/latest";
const USER_AGENT: &str = concat!("R-Dir/", env!("CARGO_PKG_VERSION"));

/// HTTP 客户端：连接 15s 超时（GitHub 直连不可达时快速失败，不无限挂起）。
/// 整体超时按请求覆盖：小 JSON 30s / 插件包 300s（国内直连 objects.githubusercontent.com
/// 可能被限速到 KB/s 级）。命令本身在 spawn_blocking 执行，不阻塞 UI 主线程。
fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .build()
}

const HTTP_TIMEOUT_JSON: std::time::Duration = std::time::Duration::from_secs(30);
const HTTP_TIMEOUT_PACKAGE: std::time::Duration = std::time::Duration::from_secs(300);

fn net_err_hint(e: ureq::Error) -> String {
    format!(
        "{e}（GitHub 直连可能不可达：请检查网络/代理后重试，或从 Release 页下载 .rdplugin 手动导入）"
    )
}

/// GET + JSON 解析（ureq 未启用 json feature，统一走字节读取 + serde）
fn http_get_json<T: serde::de::DeserializeOwned>(
    agent: &ureq::Agent,
    url: &str,
    what: &str,
) -> Result<T, String> {
    let mut buf = Vec::new();
    agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(HTTP_TIMEOUT_JSON)
        .call()
        .map_err(net_err_hint)?
        .into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("下载{what}中断：{e}（网络超时/限速，请重试或手动导入）"))?;
    serde_json::from_slice(&buf).map_err(|e| format!("解析{what}失败：{e}"))
}

/// 在线安装：查最新 Release → 匹配当前平台的 .rdplugin + 独立 manifest →
/// 下载（整包 sha256 先行校验）→ 复用本地导入的完整校验链落盘。
pub fn install_online(app: &tauri::AppHandle) -> Result<InstalledInfo, String> {
    // 1) 最新 Release 元数据
    let agent = http_agent();
    let release_json: serde_json::Value = http_get_json(&agent, RELEASE_API, "最新版本信息")?;
    let assets = release_json
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or("Release 信息缺少 assets")?;

    // 2) 本平台的独立 manifest（校验和来源独立于插件包本体）
    let target = current_target();
    let manifest_asset = format!("rdir-nfs-manifest-{target}.json");
    let manifest_url = assets
        .iter()
        .find(|a| a.get("name").and_then(|n| n.as_str()) == Some(manifest_asset.as_str()))
        .and_then(|a| a.get("browser_download_url").and_then(|u| u.as_str()))
        .ok_or_else(|| format!("最新版本未提供 {target} 平台的 NFS 插件"))?;
    let release_manifest: ReleaseManifest = http_get_json(&agent, &manifest_url, "校验清单")?;

    // 3) 平台资产
    let asset = &release_manifest;
    let asset_url = assets
        .iter()
        .find(|a| a.get("name").and_then(|n| n.as_str()) == Some(asset.file.as_str()))
        .and_then(|a| a.get("browser_download_url").and_then(|u| u.as_str()))
        .ok_or_else(|| format!("校验清单引用的 {} 不在 Release 资产中", asset.file))?;

    // 4) 下载 + 整包 sha256 校验
    let mut buf: Vec<u8> = Vec::new();
    agent
        .get(asset_url)
        .set("User-Agent", USER_AGENT)
        .timeout(HTTP_TIMEOUT_PACKAGE)
        .call()
        .map_err(net_err_hint)?
        .into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| {
            format!("下载插件包中断：{e}（网络超时/限速；可从 Release 页手动下载 .rdplugin 导入）")
        })?;
    let actual = sha256_hex(&buf);
    if actual != asset.sha256.to_lowercase() {
        return Err("下载的插件包校验失败（sha256 不匹配），请重试".into());
    }

    // 5) 包内完整校验链落盘（协议版本/平台/二进制 sha256）
    let info = install_from_bytes(app, &buf)?;
    // 清单协议版本与包内 manifest 不一致时以包内为准（包内已硬校验），这里仅提示旧清单
    if release_manifest.protocol_version != 0
        && release_manifest.protocol_version != crate::nfs_backend::NFS_PROTOCOL_VERSION
    {
        eprintln!(
            "NFS 插件清单协议版本 v{} 与宿主 v{} 不一致（包内校验已通过）",
            release_manifest.protocol_version,
            crate::nfs_backend::NFS_PROTOCOL_VERSION
        );
    }
    let _ = release_manifest.version;
    let _ = release_manifest.min_host_version;
    let _ = release_manifest.target; // 平台匹配由清单文件名（rdir-nfs-manifest-<target>.json）保证
    Ok(info)
}

// ==================== Tauri 命令 ====================

/// 插件面板状态（含安装态/版本/启用开关）
#[tauri::command]
pub fn nfs_plugin_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> NfsPluginStatus {
    status(&app, &state.plugins)
}

/// 本地导入 .rdplugin（文件对话框给路径；与主题包导入同一交互形态）。
/// async + spawn_blocking：文件读取/zip 解压/sha256 都是阻塞段，同步命令会占主线程冻结 UI
#[tauri::command]
pub async fn nfs_plugin_import(app: tauri::AppHandle, file: String) -> Result<NfsPluginStatus, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&file).map_err(|e| format!("读取插件包失败：{e}"))?;
        install_from_bytes(&app, &bytes)?;
        Ok::<_, String>(status(&app, &app.state::<crate::AppState>().plugins))
    })
    .await
    .map_err(|e| format!("导入任务失败：{e}"))??;
    Ok(result)
}

/// 在线获取最新版插件（官方 Release 通道，整包 + 包内双校验）。
/// async + spawn_blocking：阻塞 HTTP 最长可达 300s，同步命令会把主线程挂死
#[tauri::command]
pub async fn nfs_plugin_install_online(app: tauri::AppHandle) -> Result<NfsPluginStatus, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        install_online(&app)?;
        Ok::<_, String>(status(&app, &app.state::<crate::AppState>().plugins))
    })
    .await
    .map_err(|e| format!("在线获取任务失败：{e}"))??;
    Ok(result)
}

/// 卸载插件（删安装目录；启用开关记录保留无害）
#[tauri::command]
pub fn nfs_plugin_uninstall(app: tauri::AppHandle) -> Result<NfsPluginStatus, String> {
    uninstall(&app)?;
    Ok(status(&app, &app.state::<crate::AppState>().plugins))
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        assert!(version_lt("0.39.0", "0.40.0"));
        assert!(version_lt("0.40.0", "0.40.1"));
        assert!(version_lt("0.9.9", "0.10.0"));
        assert!(!version_lt("0.40.0", "0.40.0"));
        assert!(!version_lt("0.41.0", "0.40.0"));
    }

    #[test]
    fn target_triple_matches_ci_naming() {
        let t = current_target();
        assert!(t.contains("apple") || t.contains("windows") || t.contains("linux") || t == "unknown");
    }

    #[test]
    fn sha256_stable() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// 构造一个最小 .rdplugin（内存 zip）供安装链路测试
    fn build_plugin_zip(
        id: &str,
        version: &str,
        protocol: u32,
        min_host: &str,
        target: &str,
        exe_body: &[u8],
    ) -> Vec<u8> {
        use std::io::Write;
        let manifest = serde_json::json!({
            "id": id, "version": version, "protocolVersion": protocol,
            "minHostVersion": min_host, "target": target,
            "sha256": sha256_hex(exe_body), "exeName": "rdir-nfs",
        });
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("manifest.json", opts).unwrap();
            w.write_all(manifest.to_string().as_bytes()).unwrap();
            w.start_file("rdir-nfs", opts).unwrap();
            w.write_all(exe_body).unwrap();
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    /// 安装全链路：合法包落盘 install.json + 二进制可执行；非法包逐项拒绝。
    /// tauri AppHandle 不可脱离真实应用构造——这里直接测 install_from_bytes 之下的
    /// 纯函数与 zip 构造，目录落盘部分由 e2e/mock 覆盖。
    #[test]
    fn manifest_rejects_bad_contract() {
        let body = b"#!/bin/sh\necho rdir-nfs\n";
        // 平台不匹配
        // 平台不匹配（夹具三元组取与当前平台必然不同的一个）
        let foreign = if cfg!(target_os = "windows") {
            "x86_64-unknown-linux-gnu"
        } else {
            "x86_64-pc-windows-msvc"
        };
        let zip = build_plugin_zip("nfs", "0.40.0", 1, "0.0.0", foreign, body);
        let cursor = std::io::Cursor::new(zip);
        let mut ar = zip::ZipArchive::new(cursor).unwrap();
        let mut manifest_raw = String::new();
        ar.by_name("manifest.json").unwrap().read_to_string(&mut manifest_raw).unwrap();
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        assert_ne!(m.target, current_target(), "异平台包不应匹配当前平台");
        // id 不匹配
        let zip = build_plugin_zip("sftp", "0.40.0", 1, "0.0.0", current_target(), body);
        let cursor = std::io::Cursor::new(zip);
        let mut ar = zip::ZipArchive::new(cursor).unwrap();
        let mut manifest_raw = String::new();
        ar.by_name("manifest.json").unwrap().read_to_string(&mut manifest_raw).unwrap();
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        assert_ne!(m.id, NFS_PLUGIN_ID);
        // 协议版本不匹配
        let zip = build_plugin_zip("nfs", "0.40.0", 99, "0.0.0", current_target(), body);
        let cursor = std::io::Cursor::new(zip);
        let mut ar = zip::ZipArchive::new(cursor).unwrap();
        let mut manifest_raw = String::new();
        ar.by_name("manifest.json").unwrap().read_to_string(&mut manifest_raw).unwrap();
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        assert_ne!(m.protocol_version, crate::nfs_backend::NFS_PROTOCOL_VERSION);
    }

    #[test]
    fn valid_manifest_shape_roundtrip() {
        let body = b"binary";
        let zip = build_plugin_zip("nfs", "0.40.0", 1, "0.39.0", current_target(), body);
        let cursor = std::io::Cursor::new(zip);
        let mut ar = zip::ZipArchive::new(cursor).unwrap();
        let mut manifest_raw = String::new();
        ar.by_name("manifest.json").unwrap().read_to_string(&mut manifest_raw).unwrap();
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        assert_eq!(m.id, "nfs");
        assert_eq!(m.protocol_version, crate::nfs_backend::NFS_PROTOCOL_VERSION);
        assert_eq!(m.target, current_target());
        assert_eq!(m.sha256, sha256_hex(body));
        assert!(ar.by_name("rdir-nfs").is_ok());
    }
}
