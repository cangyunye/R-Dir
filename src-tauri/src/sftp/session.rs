//! SFTP 会话：基于 russh（SSH 传输）+ 自实现 SFTP v3 子协议。
//! 支持密码 / OpenSSH 私钥（含 passphrase）认证；列目录、stat、下载、上传、建删改。

#![allow(dead_code)] // 部分会话操作在写操作接入前未使用

use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use russh::client;
use russh_keys::key::PublicKey;
use russh::{Channel, ChannelMsg};

use super::proto::{self, Buf, SftpAttrs};

/// 认证方式
#[derive(Debug, Clone)]
pub enum AuthMethod {
    /// 密码（存 app 配置目录）
    Password(String),
    /// OpenSSH 私钥（~/.ssh 常规方案），passphrase 为加密私钥口令
    PublicKey { key_path: String, passphrase: Option<String> },
}

/// 远程服务器配置
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    /// 连接后默认进入的远程目录（None = 家目录）
    pub root: Option<String>,
    /// 是否保存密码/口令到配置目录（密钥路径总是保存）
    pub save_secret: bool,
}

/// host key 处理器：v0.2 先接受全部并记录指纹（known_hosts 校验在 v0.2 后期强化）
#[derive(Clone, Default)]
struct SshHandler;

#[async_trait::async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// SFTP 会话：持有已认证并进入 sftp 子系统的 channel
pub struct SftpSession {
    channel: Channel<client::Msg>,
    next_id: u32,
    buf: Vec<u8>,
    /// 认证后默认目录（通常是用户 home，供空 root 时导航）
    pub home: String,
}

impl SftpSession {
    /// 建立 SSH 连接 + 认证 + 打开 sftp 子系统
    pub async fn connect(cfg: &ServerConfig) -> Result<Self, String> {
        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config.clone(), (cfg.host.as_str(), cfg.port), SshHandler)
            .await
            .map_err(|e| format!("连接 {}:{} 失败：{}", cfg.host, cfg.port, e))?;

        let authed = match &cfg.auth {
            AuthMethod::Password(pw) => {
                session
                    .authenticate_password(&cfg.user, pw.as_str())
                    .await
                    .map_err(|e| format!("密码认证失败：{e}"))?
            }
            AuthMethod::PublicKey { key_path, passphrase } => {
                let mut authed = false;
                for p in key_candidates(key_path) {
                    let Ok(key) = load_key(&p, passphrase.as_deref()) else {
                        continue;
                    };
                    match session.authenticate_publickey(&cfg.user, key.clone()).await {
                        Ok(true) => {
                            authed = true;
                            break;
                        }
                        _ => continue,
                    }
                }
                authed
            }
        };
        if !authed {
            return Err(format!("认证失败：用户名 {} 被拒绝", cfg.user));
        }

        let channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("打开会话失败：{e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("sftp 子系统失败：{e}"))?;

        // SFTP 握手：INIT → VERSION
        let mut s = Self {
            channel,
            next_id: 0,
            buf: Vec::new(),
            home: String::new(),
        };
        let mut b = Buf::new();
        b.u8(proto::INIT);
        b.u32(3);
        let (ty, body) = s.exchange(&b.finalize()).await?;
        if ty != proto::VERSION {
            return Err("sftp 握手失败：未收到 VERSION".into());
        }
        let _ver = proto::parse_version(&body)?;
        // 默认目录：会话 cwd（通常为 home）
        s.home = s.realpath(".").await.unwrap_or_else(|_| "/".into());
        Ok(s)
    }

    fn next_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    /// 发送一个请求并等待对应 id 的回复，返回 (type, body)
    async fn exchange(&mut self, packet: &[u8]) -> Result<(u8, Vec<u8>), String> {
        self.channel
            .data(&packet[..])
            .await
            .map_err(|e| format!("发送失败：{e}"))?;
        loop {
            let (ty, body) = self.receive_packet().await?;
            if ty == proto::STATUS {
                let mut r = proto::Reader::new(&body);
                let code = r.u32()?;
                if code == 0 || code == proto::err::EOF {
                    // 成功或 EOF：都是该请求的最终应答，交给调用方判断
                    return Ok((proto::STATUS, body));
                }
                let msg = proto::parse_status(&body)?.unwrap_or_default();
                return Err(msg);
            }
            return Ok((ty, body));
        }
    }

    /// 接收并组装一个完整 SFTP 包（处理跨 Data 报文），返回 (type, body owned)
    async fn receive_packet(&mut self) -> Result<(u8, Vec<u8>), String> {
        loop {
            if self.buf.len() >= 4 {
                let len = u32::from_be_bytes(self.buf[0..4].try_into().unwrap()) as usize;
                if self.buf.len() >= 4 + len {
                    let packet: Vec<u8> = self.buf[4..4 + len].to_vec();
                    self.buf.drain(..4 + len);
                    if packet.len() < 5 {
                        return Err("SFTP 包过短".into());
                    }
                    let ty = packet[0];
                    let body = packet[5..].to_vec();
                    return Ok((ty, body));
                }
            }
            match self.channel.wait().await {
                Some(ChannelMsg::Data { data }) => self.buf.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    return Err("远程连接已关闭".into())
                }
                _ => {}
            }
        }
    }

    /// 构造请求并等待回复（自动 id）
    async fn request(&mut self, type_: u8, build: impl FnOnce(&mut Buf)) -> Result<(u8, Vec<u8>), String> {
        let id = self.next_id();
        let mut b = Buf::new();
        b.u8(type_);
        b.u32(id);
        build(&mut b);
        let (ty, body) = self.exchange(&b.finalize()).await?;
        let _ = id;
        Ok((ty, body.to_vec()))
    }

    /// 解析路径（服务端 realpath），用于展开 ~ 与相对路径
    pub async fn realpath(&mut self, path: &str) -> Result<String, String> {
        let (_ty, body) = self
            .request(proto::REALPATH, |b| b.str(path))
            .await?;
        let names = proto::parse_name(&body)?;
        names
            .first()
            .map(|(n, _)| n.clone())
            .ok_or_else(|| "realpath 无结果".into())
    }

    /// 列目录：opendir + readdir 直至 EOF；跳过 "." 与 ".."
    pub async fn list_dir(&mut self, path: &str) -> Result<Vec<(String, SftpAttrs)>, String> {
        let (_ty, body) = self.request(proto::OPENDIR, |b| b.str(path)).await?;
        let handle = read_handle(&body)?;
        let mut out = Vec::new();
        loop {
            let (ty, body) = self
                .request(proto::READDIR, |b| b.str(&handle))
                .await?;
            match ty {
                proto::NAME => {
                    for (name, attrs) in proto::parse_name(&body)? {
                        if name == "." || name == ".." {
                            continue;
                        }
                        out.push((name, attrs));
                    }
                }
                proto::STATUS => break, // EOF：目录读取结束
                _ => return Err("readdir 意外回复".into()),
            }
        }
        self.request(proto::CLOSE, |b| b.str(&handle)).await?;
        Ok(out)
    }

    /// stat（不跟随符号链接）
    pub async fn stat(&mut self, path: &str) -> Result<SftpAttrs, String> {
        let (_ty, body) = self
            .request(proto::STAT, |b| b.str(path))
            .await?;
        let mut r = proto::Reader::new(&body);
        proto::parse_attrs(&mut r)
    }

    /// 打开远程文件并下载到本地路径（dest 为临时目录内的目标文件）
    /// cb(done, total)：已下载字节 / 远程文件总字节
    pub async fn download(
        &mut self,
        remote: &str,
        dest: &Path,
        mut cb: impl FnMut(u64, u64),
    ) -> Result<u64, String> {
        let total = self.stat(remote).await?.size;
        let (_ty, body) = self
            .request(proto::OPEN, |b| {
                b.str(remote);
                b.u32(proto::FXF_READ);
                b.u32(0); // attrs: 无
            })
            .await?;
        let handle = read_handle(&body)?;
        let mut f = std::fs::File::create(dest).map_err(|e| format!("本地写入失败：{e}"))?;
        let mut offset: u64 = 0;
        let mut total_done: u64 = 0;
        loop {
            let (ty, body) = self
                .request(proto::READ, |b| {
                    b.str(&handle);
                    b.u64(offset);
                    b.u32(64 * 1024);
                })
                .await?;
            match ty {
                proto::DATA => {
                    let mut r = proto::Reader::new(&body);
                    let _len = r.u32()?;
                    let chunk = r.remaining();
                    std::io::Write::write_all(&mut f, &body[r.pos..])
                        .map_err(|e| format!("本地写入失败：{e}"))?;
                    offset += chunk as u64;
                    total_done += chunk as u64;
                    cb(total_done, total);
                }
                proto::STATUS => break, // EOF：文件读取结束
                _ => return Err("read 意外回复".into()),
            }
        }
        self.request(proto::CLOSE, |b| b.str(&handle)).await?;
        Ok(total_done)
    }

    /// 上传本地文件到远程路径（覆盖）
    /// cb(done, total)：已上传字节 / 本地文件总字节
    pub async fn upload(
        &mut self,
        local: &Path,
        remote: &str,
        mut cb: impl FnMut(u64, u64),
    ) -> Result<u64, String> {
        let total = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
        let mut f = std::fs::File::open(local).map_err(|e| format!("读取本地失败：{e}"))?;
        let (_ty, body) = self
            .request(proto::OPEN, |b| {
                b.str(remote);
                b.u32(proto::FXF_WRITE | proto::FXF_CREAT | proto::FXF_TRUNC);
                b.u32(proto::ATTR_PERMISSIONS);
                b.u32(proto::DEFAULT_FILE_PERM);
            })
            .await?;
        let handle = read_handle(&body)?;
        let mut offset: u64 = 0;
        let mut buf = vec![0u8; 32 * 1024];
        let mut total_done: u64 = 0;
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("读取本地失败：{e}"))?;
            if n == 0 {
                break;
            }
            let chunk = buf[..n].to_vec();
            self.request(proto::WRITE, |b| {
                b.str(&handle);
                b.u64(offset);
                b.u32(chunk.len() as u32);
                b.raw(&chunk);
            })
            .await?;
            offset += n as u64;
            total_done += n as u64;
            cb(total_done, total);
        }
        self.request(proto::CLOSE, |b| b.str(&handle)).await?;
        Ok(total_done)
    }

    /// 新建空文件（open write+creat 后立即关闭）
    pub async fn touch(&mut self, path: &str) -> Result<(), String> {
        let (_ty, body) = self
            .request(proto::OPEN, |b| {
                b.str(path);
                b.u32(proto::FXF_WRITE | proto::FXF_CREAT);
                b.u32(proto::ATTR_PERMISSIONS);
                b.u32(proto::DEFAULT_FILE_PERM);
            })
            .await?;
        let handle = read_handle(&body)?;
        self.request(proto::CLOSE, |b| b.str(&handle)).await?;
        Ok(())
    }

    /// 新建目录（0755）
    pub async fn mkdir(&mut self, path: &str) -> Result<(), String> {
        self.request(proto::MKDIR, |b| {
            b.str(path);
            b.u32(proto::ATTR_PERMISSIONS);
            b.u32(proto::DEFAULT_DIR_PERM);
        })
        .await?;
        Ok(())
    }

    /// 删除文件
    pub async fn remove(&mut self, path: &str) -> Result<(), String> {
        self.request(proto::REMOVE, |b| b.str(path)).await?;
        Ok(())
    }

    /// 删除目录（仅空目录）
    pub async fn rmdir(&mut self, path: &str) -> Result<(), String> {
        self.request(proto::RMDIR, |b| b.str(path)).await?;
        Ok(())
    }

    /// 递归删除目录（先删内容再删目录本身，支持非空目录）
    pub async fn remove_recursive(&mut self, remote: &str) -> Result<(), String> {
        self.remove_recursive_boxed(remote).await
    }

    fn remove_recursive_boxed<'a>(
        &'a mut self,
        remote: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let entries = self.list_dir(remote).await?;
            for (name, attrs) in entries {
                let child = format!("{}/{}", remote.trim_end_matches('/'), name);
                if attrs.is_dir {
                    self.remove_recursive_boxed(&child).await?;
                } else {
                    self.remove(&child).await?;
                }
            }
            self.rmdir(remote).await?;
            Ok(())
        })
    }

    /// 重命名/移动
    pub async fn rename(&mut self, old: &str, new: &str) -> Result<(), String> {
        self.request(proto::RENAME, |b| {
            b.str(old);
            b.str(new);
        })
        .await?;
        Ok(())
    }

    /// 断开
    pub async fn close(&mut self) {
        let _ = self.channel.eof().await;
    }
}

fn read_handle(body: &[u8]) -> Result<String, String> {
    let mut r = proto::Reader::new(body);
    r.str()
}

/// 密钥候选：指定路径优先，随后按 .ssh 常规方案探测常见私钥
fn key_candidates(specified: &str) -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let common = ["id_ed25519", "id_rsa", "id_ecdsa", "id_ed25519_sk"];
    let mut out = Vec::new();
    if !specified.is_empty() {
        out.push(expand_home(specified));
    }
    for name in common {
        let p = home.join(".ssh").join(name).to_string_lossy().to_string();
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

fn expand_home(path: &str) -> String {
    if path == "~" {
        dirs::home_dir().unwrap_or_default().to_string_lossy().to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .map(|h| h.join(rest).to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    }
}

/// 加载 OpenSSH 私钥（自动探测常见路径）
fn load_key(path: &str, passphrase: Option<&str>) -> Result<Arc<russh::keys::key::KeyPair>, String> {
    let expanded = expand_home(path);
    let p = Path::new(&expanded);
    if !p.exists() {
        return Err(format!("私钥不存在：{expanded}"));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取私钥失败：{e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    russh::keys::decode_secret_key(&text, passphrase)
        .map(Arc::new)
        .map_err(|e| format!("解析私钥失败（如需口令请填写 passphrase）：{e}"))
}
