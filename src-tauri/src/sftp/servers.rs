//! SFTP 服务器清单持久化：app 配置目录 servers.json。
//! 密码加密存储：用户输入 master-key（仅内存、不落盘），用其 AES-256-GCM 加密密码；
//! 文件里只存密文 + master-key 校验值（SHA-256 前 8 字节，用于验证用户输入）。

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// 认证配置（存盘形式）
/// 注意：rename_all="camelCase" 只作用于 variant 名（tag 值），
/// variant 内字段名不受影响，因此字段显式 rename 为前端 camelCase，
/// 并用 alias 兼容旧版 snake_case 存盘文件。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "auth", rename_all = "camelCase")]
pub enum AuthConfig {
    Password {
        /// 明文密码，或以 "enc:v1:" 开头的 AES-256-GCM 密文（save_password=true 时）
        password: String,
        /// 是否把密码写入 servers.json（false 仅本次会话内存）
        #[serde(rename = "savePassword", alias = "save_password")]
        save_password: bool,
    },
    PublicKey {
        #[serde(rename = "keyPath", alias = "key_path")]
        key_path: String,
        /// 加密私钥口令（save_passphrase=false 时不落盘）
        passphrase: Option<String>,
        #[serde(rename = "savePassphrase", alias = "save_passphrase")]
        save_passphrase: bool,
    },
}

/// 服务器清单条目（存盘形式）
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerConfigFile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 连接后默认进入的远程目录（None = 家目录）
    pub root: Option<String>,
    /// 服务器分组（空 = 默认组）
    #[serde(default)]
    pub group: String,
    #[serde(flatten)]
    pub auth: AuthConfig,
}

/// servers.json 顶层结构
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ServersFile {
    /// master-key 校验值（hex，SHA-256 前 8 字节）；None = 尚未设置 master-key
    #[serde(default)]
    pub master_key_check: Option<String>,
    #[serde(default)]
    pub servers: Vec<ServerConfigFile>,
}

pub const SERVERS_FILE: &str = "servers.json";

/// 密文前缀标记
pub const ENC_PREFIX: &str = "enc:v1:";

/// 读取服务器清单文件（兼容旧版纯数组）
pub fn load_file(path: &PathBuf) -> ServersFile {
    if !path.exists() {
        return ServersFile::default();
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return ServersFile::default();
    };
    // 新版：{ masterKeyCheck, servers }；旧版：纯数组（迁移）
    if let Ok(f) = serde_json::from_str::<ServersFile>(&text) {
        return f;
    }
    if let Ok(servers) = serde_json::from_str::<Vec<ServerConfigFile>>(&text) {
        return ServersFile { servers, ..Default::default() };
    }
    ServersFile::default()
}

/// 保存服务器清单文件
pub fn save_file(path: &PathBuf, file: &ServersFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("写入配置失败：{e}"))
}

/// 稳定 id：user@host:port
pub fn server_id(user: &str, host: &str, port: u16) -> String {
    format!("{user}@{host}:{port}")
}

// ==================== master-key 加密 ====================

/// 计算 master-key 校验值（SHA-256 前 8 字节 hex）；不泄露密钥本身
pub fn master_key_check(key: &[u8]) -> String {
    let d = Sha256::digest(key);
    let mut out = String::with_capacity(16);
    for b in d.iter().take(8) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn derive_key(master: &[u8]) -> [u8; 32] {
    let d = Sha256::digest(master);
    let mut key = [0u8; 32];
    key.copy_from_slice(&d);
    key
}

/// 用 master-key 加密密码 → "enc:v1:<base64(nonce+cipher)>"
pub fn encrypt_password(master: &[u8], plain: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(&derive_key(master)).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|_| "密码加密失败".to_string())?;
    let mut blob = Vec::with_capacity(12 + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(format!("{ENC_PREFIX}{}", B64.encode(blob)))
}

/// 解密密文密码；输入非 enc: 前缀视为明文原样返回
pub fn decrypt_password(master: &[u8], stored: &str) -> Result<String, String> {
    if !stored.starts_with(ENC_PREFIX) {
        return Ok(stored.to_string());
    }
    let b64 = &stored[ENC_PREFIX.len()..];
    let blob = B64.decode(b64).map_err(|_| "密码密文损坏".to_string())?;
    if blob.len() < 12 {
        return Err("密码密文损坏".into());
    }
    let (nonce, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&derive_key(master)).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "密码解密失败（master-key 可能已变化）".to_string())?;
    String::from_utf8(plain).map_err(|_| "解密内容不是有效文本".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pw_cfg(password: &str, save: bool) -> AuthConfig {
        AuthConfig::Password { password: password.into(), save_password: save }
    }

    #[test]
    fn seal_without_master_keeps_plaintext() {
        let mut auth = pw_cfg("secret", true);
        seal_auth_secrets(&mut auth, None).unwrap();
        match auth {
            AuthConfig::Password { password, save_password } => {
                assert_eq!(password, "secret", "未设置主密钥：明文原样保留，不再报 NEED_MASTER_KEY");
                assert!(save_password);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn seal_with_master_encrypts_and_decrypts_back() {
        let mut auth = pw_cfg("secret", true);
        seal_auth_secrets(&mut auth, Some(b"mk")).unwrap();
        match auth {
            AuthConfig::Password { password, .. } => {
                assert!(password.starts_with(ENC_PREFIX));
                assert_eq!(decrypt_password(b"mk", &password).unwrap(), "secret");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn seal_skips_unsaved_and_already_encrypted() {
        let enc = encrypt_password(b"mk", "already").unwrap();
        let mut a = pw_cfg("", true); // 空密码跳过
        seal_auth_secrets(&mut a, Some(b"mk")).unwrap();
        let mut b = pw_cfg("", false); // 未勾选记住跳过
        seal_auth_secrets(&mut b, None).unwrap();
        let mut c = pw_cfg(&enc, true); // 已是密文跳过
        seal_auth_secrets(&mut c, Some(b"mk")).unwrap();
        match c {
            AuthConfig::Password { password, .. } => assert_eq!(password, enc),
            _ => panic!(),
        }
    }

    #[test]
    fn migrate_encrypts_only_plaintext_saved_entries() {
        let mut file = ServersFile {
            master_key_check: None,
            servers: vec![
                ServerConfigFile {
                    id: "a".into(),
                    name: "a".into(),
                    host: "h".into(),
                    port: 22,
                    user: "u".into(),
                    root: None,
                    group: String::new(),
                    auth: pw_cfg("plain1", true),
                },
                ServerConfigFile {
                    id: "b".into(),
                    name: "b".into(),
                    host: "h".into(),
                    port: 22,
                    user: "u".into(),
                    root: None,
                    group: String::new(),
                    auth: pw_cfg("", false),
                },
            ],
        };
        let n = encrypt_all_plaintext(&mut file, b"mk").unwrap();
        assert_eq!(n, 1, "只有勾选记住且有明文的条目被迁移");
        match &file.servers[0].auth {
            AuthConfig::Password { password, .. } => {
                assert!(password.starts_with(ENC_PREFIX));
                assert_eq!(decrypt_password(b"mk", password).unwrap(), "plain1");
            }
            _ => panic!(),
        }
    }

    // ==================== 导出 / 导入 ====================

    fn srv(id: &str, auth: AuthConfig) -> ServerConfigFile {
        ServerConfigFile {
            id: id.into(),
            name: id.into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            root: None,
            group: String::new(),
            auth,
        }
    }

    #[test]
    fn export_rejects_plaintext_secrets() {
        let mut file = ServersFile::default();
        file.servers.push(srv("a", pw_cfg("plain", true)));
        assert!(has_plaintext_secrets(&file), "明文密码必须先设主密钥再导出");
        let enc = encrypt_password(b"mk", "secret").unwrap();
        file.servers[0] = srv("a", pw_cfg(&enc, true));
        assert!(!has_plaintext_secrets(&file), "密文可导出");
        file.servers[0] = srv("a", pw_cfg("", false));
        assert!(!has_plaintext_secrets(&file), "未勾选记住的空密码不算明文泄漏");
    }

    #[test]
    fn import_requires_master_password_and_verifies_check() {
        let enc = encrypt_password(b"mk", "secret").unwrap();
        let export = ExportFile {
            version: 1,
            exported_at: "2026-10-19T00:00:00Z".into(),
            master_key_check: Some(master_key_check(b"mk")),
            servers: vec![srv("a", pw_cfg(&enc, true))],
        };
        let mut local = ServersFile::default();
        // 含密文但没给主密码 → NEED_MASTER_KEY（前端据此弹主密码框）
        let err = import_merge(&mut local, &export, None, None).unwrap_err();
        assert!(err.contains("NEED_MASTER_KEY"));
        // 错误主密码：先过校验值拦截
        let err = import_merge(&mut local, &export, Some(b"wrong"), None).unwrap_err();
        assert!(err.contains("主密码不正确"), "masterKeyCheck 必须先拦截错误密码");
        // 正确主密码：解密导入，跳过数 0
        let out = import_merge(&mut local, &export, Some(b"mk"), None).unwrap();
        assert_eq!((out.imported, out.skipped), (1, 0));
        match &local.servers[0].auth {
            AuthConfig::Password { password, .. } => {
                assert_eq!(password, "secret", "本机未设主密钥 → 明文落盘（与首存策略一致）");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn import_reseals_with_local_master_and_skips_existing() {
        let enc = encrypt_password(b"export-mk", "secret").unwrap();
        let export = ExportFile {
            version: 1,
            exported_at: String::new(),
            master_key_check: Some(master_key_check(b"export-mk")),
            servers: vec![srv("a", pw_cfg(&enc, true)), srv("b", pw_cfg("plain-b", true))],
        };
        let mut local = ServersFile::default();
        local.servers.push(srv("a", pw_cfg("local-keep", true)));
        // 本机主密钥已解锁：解密后回填加密；id 冲突的 a 跳过
        let out = import_merge(&mut local, &export, Some(b"export-mk"), Some(b"local-mk")).unwrap();
        assert_eq!((out.imported, out.skipped), (1, 1), "同 id 跳过，不覆盖本机配置");
        assert_eq!(local.servers.len(), 2);
        match &local.servers[0].auth {
            AuthConfig::Password { password, .. } => {
                assert_eq!(password, "local-keep", "本机已有条目不被导入覆盖");
            }
            _ => panic!(),
        }
        match &local.servers[1].auth {
            AuthConfig::Password { password, .. } => {
                assert!(password.starts_with(ENC_PREFIX), "导入后按本机主密钥加密");
                assert_eq!(decrypt_password(b"local-mk", password).unwrap(), "plain-b");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_export_accepts_full_and_bare_array() {
        let enc = encrypt_password(b"mk", "s").unwrap();
        let export = ExportFile {
            version: 1,
            exported_at: "t".into(),
            master_key_check: Some(master_key_check(b"mk")),
            servers: vec![srv("a", pw_cfg(&enc, true))],
        };
        let text = serde_json::to_string(&export).unwrap();
        let parsed = parse_export(&text).unwrap();
        assert_eq!(parsed.servers.len(), 1);
        assert_eq!(parsed.master_key_check.as_deref(), export.master_key_check.as_deref());
        // 裸数组兼容（无校验值 → 导入时按逐条解密对账）
        let bare = serde_json::to_string(&export.servers).unwrap();
        let parsed = parse_export(&bare).unwrap();
        assert_eq!(parsed.servers.len(), 1);
        assert!(parsed.master_key_check.is_none());
        assert!(parse_export("not json").is_err());
    }
}

// ==================== 主密钥策略（v0.22.2） ====================
// 主密码只用于解锁既有密文；首次创建服务器不强制设置——未设置主密钥时
// "记住的密码"以明文存盘（本机配置文件），设置主密钥时回填加密为密文。

/// 落盘前处理认证密钥材料：需要记住的密码/口令，有 master-key → 加密为 enc:v1:，
/// 未设置 → 保持明文原样存盘（不再返回 NEED_MASTER_KEY）。
pub fn seal_auth_secrets(auth: &mut AuthConfig, master: Option<&[u8]>) -> Result<(), String> {
    match auth {
        AuthConfig::Password { password, save_password } => {
            if *save_password
                && !password.is_empty()
                && !password.starts_with(ENC_PREFIX)
            {
                if let Some(mk) = master {
                    *password = encrypt_password(mk, password)?;
                }
            }
        }
        AuthConfig::PublicKey { passphrase, save_passphrase, .. } => {
            if *save_passphrase {
                if let Some(p) = passphrase.as_deref() {
                    if !p.is_empty() && !p.starts_with(ENC_PREFIX) {
                        if let Some(mk) = master {
                            *passphrase = Some(encrypt_password(mk, p)?);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// 把清单中所有明文密码/口令加密为密文（设置主密钥时的回填迁移）；返回迁移条数。
/// 已是密文（enc:v1:）或未勾选记住的条目跳过。
pub fn encrypt_all_plaintext(file: &mut ServersFile, master: &[u8]) -> Result<usize, String> {
    let mut n = 0;
    for srv in file.servers.iter_mut() {
        n += encrypt_entry_plaintext(&mut srv.auth, master)?;
    }
    Ok(n)
}

fn encrypt_entry_plaintext(auth: &mut AuthConfig, master: &[u8]) -> Result<usize, String> {
    let mut n = 0;
    match auth {
        AuthConfig::Password { password, save_password } => {
            if *save_password && !password.is_empty() && !password.starts_with(ENC_PREFIX) {
                *password = encrypt_password(master, password)?;
                n += 1;
            }
        }
        AuthConfig::PublicKey { passphrase, save_passphrase, .. } => {
            if *save_passphrase {
                if let Some(p) = passphrase.as_mut() {
                    if !p.is_empty() && !p.starts_with(ENC_PREFIX) {
                        *p = encrypt_password(master, p)?;
                        n += 1;
                    }
                }
            }
        }
    }
    Ok(n)
}

// ==================== 服务器清单导出 / 导入 ====================

/// 导出文件顶层结构：servers.json 的可迁移子集。
/// 已保存的密码/口令以密文（enc:v1:）原样带走；masterKeyCheck 一并导出，
/// 导入端先用它校验主密码、再解密，避免拿错误密码逐条硬试。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExportFile {
    pub version: u32,
    /// RFC3339 导出时间（前端生成传入）
    #[serde(rename = "exportedAt")]
    pub exported_at: String,
    /// 导出方 master-key 校验值（明文清单没有）
    #[serde(rename = "masterKeyCheck", skip_serializing_if = "Option::is_none")]
    pub master_key_check: Option<String>,
    pub servers: Vec<ServerConfigFile>,
}

/// 导入结果摘要（跳过 = 本机已有同 id 服务器）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: usize,
    pub skipped: usize,
}

/// 单条目是否带有 enc: 密文密码/口令
fn entry_has_ciphertext(auth: &AuthConfig) -> bool {
    match auth {
        AuthConfig::Password { password, .. } => password.starts_with(ENC_PREFIX),
        AuthConfig::PublicKey { passphrase, .. } => passphrase
            .as_deref()
            .map(|p| p.starts_with(ENC_PREFIX))
            .unwrap_or(false),
    }
}

/// 清单中是否存在「勾选记住但仍是明文」的密码/口令（导出前的安全门：
/// 明文进导出文件会随文件外流，必须先设主密钥加密）
pub fn has_plaintext_secrets(file: &ServersFile) -> bool {
    file.servers.iter().any(|srv| match &srv.auth {
        AuthConfig::Password { password, save_password } => {
            *save_password && !password.is_empty() && !password.starts_with(ENC_PREFIX)
        }
        AuthConfig::PublicKey {
            passphrase,
            save_passphrase,
            ..
        } => {
            *save_passphrase
                && passphrase
                    .as_deref()
                    .map(|p| !p.is_empty() && !p.starts_with(ENC_PREFIX))
                    .unwrap_or(false)
        }
    })
}

/// 解析导出文件文本：标准 ExportFile；兼容裸服务器数组（旧版/手工编辑）
pub fn parse_export(text: &str) -> Result<ExportFile, String> {
    if let Ok(f) = serde_json::from_str::<ExportFile>(text) {
        return Ok(f);
    }
    if let Ok(servers) = serde_json::from_str::<Vec<ServerConfigFile>>(text) {
        return Ok(ExportFile {
            version: 1,
            exported_at: String::new(),
            master_key_check: None,
            servers,
        });
    }
    Err("不是有效的服务器导出文件".into())
}

/// 用导入主密码解密条目中的密文（无密码或解不开 → Err）
fn decrypt_entry_secrets(auth: &mut AuthConfig, master: Option<&[u8]>) -> Result<(), String> {
    let Some(mk) = master else {
        return Err("NEED_MASTER_KEY: 导入文件包含加密密码，需要输入导出时使用的主密码".into());
    };
    match auth {
        AuthConfig::Password { password, .. } => {
            if password.starts_with(ENC_PREFIX) {
                *password = decrypt_password(mk, password)?;
            }
        }
        AuthConfig::PublicKey { passphrase: Some(p), .. } => {
            if p.starts_with(ENC_PREFIX) {
                *p = decrypt_password(mk, p)?;
            }
        }
        AuthConfig::PublicKey { passphrase: None, .. } => {}
    }
    Ok(())
}

/// 合并导入：密文经导入主密码解密 → 本机主密钥回填加密 → 按 id 去重（已存在跳过）。
/// 导入不覆盖本机同 id 条目（本机的连接状态/凭据改动不因导入被回滚）。
/// 返回 (导入数, 跳过数)；文件带 masterKeyCheck 时先校验主密码再动手。
pub fn import_merge(
    local: &mut ServersFile,
    export: &ExportFile,
    master: Option<&[u8]>,
    local_master: Option<&[u8]>,
) -> Result<ImportOutcome, String> {
    let has_ct = export.servers.iter().any(|s| entry_has_ciphertext(&s.auth));
    if has_ct {
        let mk = master.ok_or_else(|| {
            "NEED_MASTER_KEY: 导入文件包含加密密码，需要输入导出时使用的主密码".to_string()
        })?;
        if let Some(check) = &export.master_key_check {
            if *check != master_key_check(mk) {
                return Err("主密码不正确".into());
            }
        }
    }
    let mut imported = 0usize;
    let mut skipped = 0usize;
    for srv in &export.servers {
        if local.servers.iter().any(|s| s.id == srv.id) {
            skipped += 1;
            continue;
        }
        let mut entry = srv.clone();
        if entry_has_ciphertext(&entry.auth) {
            decrypt_entry_secrets(&mut entry.auth, master)?;
        }
        // 本机已解锁主密钥 → 按本机策略回填加密；未设置则与首存一致明文落盘
        if let Some(lm) = local_master {
            encrypt_entry_plaintext(&mut entry.auth, lm)?;
        }
        local.servers.push(entry);
        imported += 1;
    }
    Ok(ImportOutcome { imported, skipped })
}
