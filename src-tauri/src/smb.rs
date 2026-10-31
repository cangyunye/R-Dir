//! SMB 内置插件：smb:// → Windows 原生 UNC 委托（v0.39）。
//!
//! 设计：Windows 的 SMB 客户端在内核，std::fs 对 UNC 路径完全透明——因此不做
//! 协议重实现，`smb://host/share/rest` 仅翻译为 `\\host\share\rest`，一切文件
//! 操作复用本地引擎（fs_ops/ops/搜索/预览/缩略图全量能力）。条目一律以 UNC
//! 本地路径返回，前端按本地条目处理，零额外接线。
//!
//! `smb://host`（无共享段，等价 `\\host`）= 枚举服务器共享列表（NetShareEnum，
//! 仅 Windows）。认证交给 Windows 凭据体系：访问被拒时提示预认证
//! （资源管理器打开一次该共享，或 `net use \\host\IPC$ /user:… `）。

use crate::fs_ops::FileEntry;

/// smb:// 前缀判定
pub fn is_smb_path(p: &str) -> bool {
    p.starts_with("smb://")
}

/// smb:// → UNC。`smb://host/share/a/b` → `\\host\share\a\b`。
/// 允许 user@host 写法（用户信息被忽略，认证走 Windows 凭据体系）。
pub fn to_unc(path: &str) -> Result<String, String> {
    let rest = path
        .strip_prefix("smb://")
        .ok_or_else(|| format!("不是 smb 路径：{path}"))?;
    let rest = match rest.split_once('@') {
        // smb://user@host/... — 用户名不参与 Windows SMB 认证，忽略
        Some((_user, after)) if !after.is_empty() => after,
        _ => rest,
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return Err("smb 路径缺少主机：smb://host/share".into());
    }
    let rest = rest.replace('\\', "/");
    let mut it = rest.splitn(3, '/');
    let host = it.next().unwrap_or_default();
    if host.is_empty() {
        return Err("smb 主机为空：smb://host/share".into());
    }
    let mut unc = format!("\\\\{host}");
    if let Some(share) = it.next().filter(|s| !s.is_empty()) {
        unc.push('\\');
        unc.push_str(share);
        if let Some(tail) = it.next().filter(|s| !s.is_empty()) {
            unc.push('\\');
            unc.push_str(&tail.replace('/', "\\"));
        }
    }
    Ok(unc)
}

/// 本地化路径：smb:// 翻译为 UNC，其余原样（UNC/盘符路径直接用）。
/// stat_path / 文本读写 / 打开方式等「本地兼容」入口统一走这里。
pub fn normalize_for_local(path: &str) -> Result<String, String> {
    if is_smb_path(path) {
        to_unc(path)
    } else {
        Ok(path.to_string())
    }
}

/// UNC 服务器根判定：`\\host`（无共享段）。浏览层级：`\\host` → 共享列表。
pub fn is_unc_server_root(p: &str) -> bool {
    let Some(rest) = p.strip_prefix("\\\\") else {
        return false;
    };
    let rest = rest.trim_end_matches(['\\', '/']);
    match rest.split_once(['\\', '/']) {
        Some((_host, share)) => share.is_empty(),
        None => !rest.is_empty(),
    }
}

/// 从 UNC 服务器根提取主机名（调用方先过 is_unc_server_root）
fn unc_host(p: &str) -> String {
    p.trim_start_matches("\\\\")
        .trim_end_matches(['\\', '/'])
        .split(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_string()
}

/// 列目录（路由入口，同步——调用方须放 blocking 池）。
/// 服务器根（smb://host 或 \\host）列共享；其余翻译 UNC 后委托本地引擎。
pub fn list_dir(path: &str) -> Result<Vec<FileEntry>, String> {
    if is_smb_path(path) {
        let unc = to_unc(path)?;
        if is_unc_server_root(&unc) {
            return list_shares_view(&unc_host(&unc));
        }
        return crate::fs_ops::list_dir(&unc);
    }
    if is_unc_server_root(path) {
        return list_shares_view(&unc_host(path));
    }
    Err(format!("不是 smb/UNC 服务器根路径：{path}"))
}

/// 共享列表视图：条目路径为 UNC（\\host\share），此后导航全走本地机制
#[cfg(windows)]
fn list_shares_view(host: &str) -> Result<Vec<FileEntry>, String> {
    let mut out: Vec<FileEntry> = list_shares(host)?
        .into_iter()
        .map(|name| FileEntry {
            name: name.clone(),
            path: format!("\\\\{host}\\{name}"),
            is_dir: true,
            is_symlink: false,
            size: 0,
            modified: None,
            created: None,
            permissions: String::new(),
            extension: String::new(),
        })
        .collect();
    // 目录优先 + 名称排序（对齐本地 / SFTP）
    out.sort_by(|x, y| {
        y.is_dir
            .cmp(&x.is_dir)
            .then_with(|| x.name.to_lowercase().cmp(&y.name.to_lowercase()))
    });
    Ok(out)
}

#[cfg(not(windows))]
fn list_shares_view(_host: &str) -> Result<Vec<FileEntry>, String> {
    Err("SMB 共享枚举仅支持 Windows（其他平台可先挂载后按本地路径浏览）".into())
}

/// PWSTR → String（读到 NUL；NetShareEnum 缓冲内的 netname/remark 均以 NUL 结尾）
#[cfg(windows)]
fn pwstr_to_string(p: windows::core::PWSTR) -> String {
    unsafe {
        let mut len = 0usize;
        while *p.0.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p.0, len))
    }
}

/// NetShareEnum level 1：返回磁盘类共享名列表（STYPE_DISKTREE，
/// 排除 IPC$/ADMIN$ 等管理共享）。
/// 注：windows 0.62 把 lmshare API 归在 Storage::FileSystem，结构体无 W 后缀。
#[cfg(windows)]
fn list_shares(host: &str) -> Result<Vec<String>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::NetworkManagement::NetManagement::{NetApiBufferFree, NERR_Success};
    use windows::Win32::Storage::FileSystem::{
        NetShareEnum, SHARE_INFO_1, STYPE_DISKTREE, STYPE_MASK,
    };

    // MAX_PREFERRED_LENGTH：让 API 自行分配足量缓冲
    const MAX_PREFERRED_LENGTH: u32 = u32::MAX;
    let server_w: Vec<u16> = format!("\\\\{host}\0").encode_utf16().collect();
    let mut entries_read: u32 = 0;
    let mut total_entries: u32 = 0;
    let mut buf: *mut SHARE_INFO_1 = std::ptr::null_mut();
    let status = unsafe {
        NetShareEnum(
            PCWSTR(server_w.as_ptr()),
            1,
            &mut buf as *mut *mut SHARE_INFO_1 as *mut *mut u8,
            MAX_PREFERRED_LENGTH,
            &mut entries_read,
            &mut total_entries,
            None,
        )
    };
    if status != NERR_Success {
        return Err(match status {
            5 => format!(
                "访问 \\\\{host} 被拒绝（可在资源管理器打开一次完成认证，或 net use 预认证）"
            ),
            53 => format!("找不到网络路径 \\\\{host}（主机不在线或 SMB 服务未开）"),
            code => format!("枚举 \\\\{host} 共享失败（错误码 {code}）"),
        });
    }
    let mut out = Vec::new();
    if !buf.is_null() && entries_read > 0 {
        let slice = unsafe { std::slice::from_raw_parts(buf, entries_read as usize) };
        for info in slice {
            // 只保留磁盘类共享（排除 IPC$/ADMIN$ 等管理共享）
            if info.shi1_type.0 & STYPE_MASK.0 != STYPE_DISKTREE.0 {
                continue;
            }
            let name = pwstr_to_string(info.shi1_netname);
            if !name.is_empty() {
                out.push(name);
            }
        }
    }
    unsafe {
        if !buf.is_null() {
            let _ = NetApiBufferFree(Some(buf as *const _));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_unc_basic_and_edge() {
        assert_eq!(to_unc("smb://192.168.1.5/rdir").unwrap(), "\\\\192.168.1.5\\rdir");
        assert_eq!(
            to_unc("smb://192.168.1.5/rdir/文档/hello.txt").unwrap(),
            "\\\\192.168.1.5\\rdir\\文档\\hello.txt"
        );
        // user@ 被忽略；尾随 /；正斜杠统一
        assert_eq!(to_unc("smb://user@host/share/").unwrap(), "\\\\host\\share");
        assert_eq!(to_unc("smb://host/a/b/c").unwrap(), "\\\\host\\a\\b\\c");
        assert!(to_unc("smb://").is_err());
        assert!(to_unc("smb:///share").is_err());
        assert!(to_unc("nfs://host/a").is_err());
        // 无共享段 = 服务器根
        assert_eq!(to_unc("smb://host").unwrap(), "\\\\host");
    }

    #[test]
    fn to_unc_normalizes_backslashes() {
        assert_eq!(to_unc("smb://host/a\\b").unwrap(), "\\\\host\\a\\b");
    }

    #[test]
    fn unc_server_root_detection() {
        assert!(is_unc_server_root("\\\\host"));
        assert!(is_unc_server_root("\\\\host\\"));
        assert!(is_unc_server_root("\\\\192.168.1.5"));
        assert!(!is_unc_server_root("\\\\host\\share"));
        assert!(!is_unc_server_root("\\\\host\\share\\a"));
        assert!(!is_unc_server_root("C:\\"));
        assert!(!is_unc_server_root("\\\\"));
        assert!(!is_unc_server_root("smb://host"));
    }

    #[test]
    fn normalize_passthrough() {
        assert_eq!(normalize_for_local("C:\\x").unwrap(), "C:\\x");
        assert_eq!(normalize_for_local("\\\\h\\s\\a").unwrap(), "\\\\h\\s\\a");
        assert_eq!(normalize_for_local("smb://h/s/a").unwrap(), "\\\\h\\s\\a");
    }

    /// ---- v0.39 SMB 实机验证（WSL Samba；需外部预认证，未认证时跳过） ----
    /// 前置：`net use \\<host>\rdir /user:rdir rdir123`（错误 5 = 无会话，跳过）。
    /// 主机可用 RDIR_SMB_TEST_HOST 覆盖。
    #[cfg(windows)]
    #[test]
    fn smb_live_share_list() {
        let host = std::env::var("RDIR_SMB_TEST_HOST").unwrap_or_else(|_| "172.20.214.44".into());
        match list_shares(&host) {
            Ok(shares) => {
                assert!(
                    shares.iter().any(|s| s == "rdir"),
                    "共享列表应含 rdir：{shares:?}"
                );
            }
            // 5 = 拒绝访问（无预认证会话）、53 = 主机不可达：环境不具备，跳过
            Err(e) if e.contains("错误码 5") || e.contains("错误码 53") => {
                eprintln!("[skip] SMB 测试环境不可用（{e}）");
            }
            Err(e) => panic!("共享枚举意外失败：{e}"),
        }
    }
}
