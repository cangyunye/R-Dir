//! NFS 会话：基于 nfs-rs（纯 Rust NFSv3 客户端，RPC 直连不经 OS mount）。
//! 一个会话 = 一个已挂载的导出（Mount）；所有操作路径相对挂载根。
//! 虚拟路径中的子路径（如 /export/sub/dir）按挂载根 + 相对路径组合。

use std::path::Path;

use bytes::Bytes;
use nfs_rs::{Attr as NfsAttrRaw, Mount, OPEN_READ};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

use crate::client::ERR_CANCELLED;

/// URL path 段编码集：除 unreserved 外全编码（中文/空格/#/?/% 等），
/// '/' 恒为分隔符不编码——nfs-rs 按段解码且拒绝段内含 '/'。
const SEG: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// 连接/请求超时：rpcbind 不可达或服务器无响应时不无限挂起
const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 条目属性（nfs-rs Attr 的精简视图，供 FileEntry 组装）
#[derive(Debug, Clone, Default)]
pub struct NfsAttrs {
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// 毫秒时间戳（None = 服务器未提供）
    pub mtime: Option<i64>,
    /// POSIX 权限位（file_mode 低 12 位）
    pub mode: u32,
}

impl NfsAttrs {
    pub fn from_raw(a: &NfsAttrRaw) -> Self {
        // type_：NF3REG=1 / NF3DIR=2 / NF3LNK=3；以 mode 位为主、type_ 兜底
        let fmt = a.file_mode & 0o170000;
        let is_dir = fmt == 0o040000 || a.type_ == 2;
        let is_symlink = fmt == 0o120000 || a.type_ == 3;
        let mtime = if a.mtime.seconds > 0 || a.mtime.nseconds > 0 {
            Some(a.mtime.seconds as i64 * 1000 + (a.mtime.nseconds as i64 / 1_000_000))
        } else {
            None
        };
        Self {
            is_dir,
            is_symlink,
            size: a.filesize,
            mtime,
            mode: a.file_mode & 0o7777,
        }
    }

    /// 权限串（对齐 sftp proto::SftpAttrs::perm_string）
    pub fn perm_string(&self) -> String {
        let mut s = String::with_capacity(10);
        s.push(if self.is_dir {
            'd'
        } else if self.is_symlink {
            'l'
        } else {
            '-'
        });
        for shift in [6usize, 3, 0] {
            let bits = (self.mode >> shift) & 0o7;
            s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
            s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
            s.push(if bits & 0o1 != 0 { 'x' } else { '-' });
        }
        s
    }
}

/// 已挂载的 NFS 导出会话
pub struct NfsSession {
    mount: Box<dyn Mount>,
    /// 已挂载的导出路径（含前导 /）
    pub export: String,
    pub host: String,
    pub port: Option<u16>,
}

/// 段编码后拼挂载 URL（NFSv3；uid/gid 走 nfs-rs 平台默认——Windows 为 65534）
fn mount_url(host: &str, port: Option<u16>, export: &str) -> String {
    let auth = match port {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    let enc: Vec<String> = export
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| utf8_percent_encode(s, SEG).to_string())
        .collect();
    if enc.is_empty() {
        format!("nfs://{auth}/?version=3")
    } else {
        format!("nfs://{auth}/{}?version=3", enc.join("/"))
    }
}

/// 直接挂载指定导出（不做渐进探测）
async fn try_mount(host: &str, port: Option<u16>, export: &str) -> Result<Box<dyn Mount>, String> {
    let url = mount_url(host, port, export);
    let fut = nfs_rs::parse_url_and_mount(&url);
    match tokio::time::timeout(RPC_TIMEOUT, fut).await {
        Ok(Ok(m)) => Ok(m),
        Ok(Err(e)) => Err(format!("挂载 {export} 失败：{e}")),
        Err(_) => Err(format!("挂载 {export} 超时（15s，rpcbind/mountd 无响应）")),
    }
}

/// 连接并挂载导出：渐进导出探测——从最短前缀到完整路径逐个尝试挂载，
/// 第一个挂载成功的前缀即导出根（余下部分为会话内相对路径）。
/// 例：/srv/nfs-share → 先试 /srv 再试 /srv/nfs-share。
pub async fn connect(host: &str, port: Option<u16>, full: &str) -> Result<NfsSession, String> {
    let segs: Vec<&str> = full.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return Err("nfs 路径需要指定导出路径：nfs://host/export".into());
    }
    let mut last = String::from("未知错误");
    for k in 1..=segs.len() {
        let cand = format!("/{}", segs[..k].join("/"));
        match try_mount(host, port, &cand).await {
            Ok(m) => {
                return Ok(NfsSession {
                    mount: m,
                    export: cand,
                    host: host.to_string(),
                    port,
                });
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// 相对路径归一：确保以 / 开头（挂载根下）
pub fn normalize_sub(p: &str) -> String {
    if p.is_empty() || p == "/" {
        String::new()
    } else if p.starts_with('/') {
        p.trim_end_matches('/').to_string()
    } else {
        format!("/{p}")
    }
}

/// 拼接挂载根下的相对路径
pub fn join_sub(dir: &str, name: &str) -> String {
    let base = normalize_sub(dir);
    if base.is_empty() {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

impl NfsSession {
    /// 列目录（readdirplus 一次拿名字 + 属性；流式分页收集）
    pub async fn list_dir(&mut self, sub: &str) -> Result<Vec<(String, NfsAttrs)>, String> {
        use futures_util::StreamExt;
        // 挂载根本身（空相对路径）：path 式接口不接受 ""，走 getfh + fh 版 readdirplus
        let mut stream = if normalize_sub(sub).is_empty() {
            let fh = self.mount.getfh().await;
            self.mount.readdirplus(fh).await
        } else {
            match self.mount.readdirplus_path(&normalize_sub(sub)).await {
                Ok(s) => s,
                Err(e) => return Err(format!("列目录失败：{e}")),
            }
        };
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            match item {
                Ok(e) => {
                    let a = e.attr.unwrap_or_default();
                    out.push((e.file_name, NfsAttrs::from_raw(&a)));
                }
                Err(err) => return Err(format!("列目录失败：{err}")),
            }
        }
        Ok(out)
    }

    /// stat（getattr；服务器返回的属性缺省时按 size/type 兜底）
    pub async fn stat(&mut self, sub: &str) -> Result<NfsAttrs, String> {
        let path = normalize_sub(sub);
        let a = if path.is_empty() {
            let fh = self.mount.getfh().await;
            self.mount
                .getattr(fh)
                .await
                .map_err(|e| format!("读取属性失败：{e}"))?
        } else {
            self.mount
                .getattr_path(&path)
                .await
                .map_err(|e| format!("读取属性失败：{e}"))?
        };
        Ok(NfsAttrs::from_raw(&a))
    }

    /// 下载文件到本地路径。cb(done, total) 返回 false 中止：
    /// 关闭句柄、删除本地半成品，返回「已取消」。
    pub async fn download(
        &mut self,
        sub: &str,
        dest: &Path,
        mut cb: impl FnMut(u64, u64) -> bool,
    ) -> Result<u64, String> {
        let path = normalize_sub(sub);
        let total = self.stat(&path).await?.size;
        let opened = self
            .mount
            .open_path(&path, OPEN_READ)
            .await
            .map_err(|e| format!("打开远程文件失败：{e}"))?;
        let fh = opened.fh.clone();
        let chunk = (self.mount.get_max_read_size().max(64 * 1024)) as usize;
        let mut f = std::fs::File::create(dest).map_err(|e| format!("本地写入失败：{e}"))?;
        use std::io::Write;
        let mut done: u64 = 0;
        loop {
            let bytes = match self.mount.read(fh.clone(), done, chunk as u32).await {
                Ok(b) => b,
                Err(e) => {
                    let _ = self.mount.close(fh).await;
                    return Err(format!("读取远程失败：{e}"));
                }
            };
            if bytes.is_empty() {
                break;
            }
            if let Err(e) = f.write_all(&bytes) {
                let _ = self.mount.close(fh).await;
                return Err(format!("本地写入失败：{e}"));
            }
            done += bytes.len() as u64;
            if !cb(done, total) {
                let _ = self.mount.close(fh).await;
                drop(f);
                let _ = std::fs::remove_file(dest);
                return Err(ERR_CANCELLED.into());
            }
        }
        let _ = self.mount.close(fh).await;
        Ok(done)
    }

    /// 上传本地文件到远程路径（覆盖：已存在则先删后建，对齐 SFTP FXF_TRUNC 语义）。
    /// 逐块 write（块长取服务器协商上限），每块确认后推进度；取消时关闭句柄
    /// 并删除远端半成品。写为同步落盘（nfs-rs 写返回即已 commit），无需流水线。
    pub async fn upload(
        &mut self,
        local: &Path,
        sub: &str,
        mut cb: impl FnMut(u64, u64) -> bool,
    ) -> Result<u64, String> {
        use std::io::Read;
        let path = normalize_sub(sub);
        let total = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
        // 覆盖语义：已存在先删（rm 失败多半因权限，create 会原样报错）
        if self.mount.lookup_path(&path).await.is_ok() {
            self.mount
                .remove_path(&path)
                .await
                .map_err(|e| format!("覆盖前删除旧文件失败：{e}"))?;
        }
        let created = self
            .mount
            .create_path(&path, Some(0o644))
            .await
            .map_err(|e| format!("创建远程文件失败：{e}"))?;
        let fh = created.fh.clone();
        let wsize = (self.mount.get_max_write_size().max(32 * 1024)) as usize;
        let mut f = std::fs::File::open(local).map_err(|e| format!("读取本地失败：{e}"))?;
        let mut buf = vec![0u8; wsize];
        let mut acked: u64 = 0;
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("读取本地失败：{e}"))?;
            if n == 0 {
                break;
            }
            let mut pending = &buf[..n];
            // 短写重试：从上次确认偏移续写剩余部分
            while !pending.is_empty() {
                let out = match self
                    .mount
                    .write(fh.clone(), acked, Bytes::copy_from_slice(pending))
                    .await
                {
                    Ok(o) if o.count > 0 => o,
                    Ok(_) => {
                        let _ = self.mount.close(fh.clone()).await;
                        let _ = self.mount.remove_path(&path).await;
                        return Err("远程写入停滞（服务器接受了 0 字节）".into());
                    }
                    Err(e) => {
                        let _ = self.mount.close(fh.clone()).await;
                        let _ = self.mount.remove_path(&path).await;
                        return Err(format!("写入远程失败：{e}"));
                    }
                };
                acked += out.count as u64;
                pending = &pending[out.count as usize..];
                if !cb(acked, total) {
                    let _ = self.mount.close(fh.clone()).await;
                    let _ = self.mount.remove_path(&path).await;
                    return Err(ERR_CANCELLED.into());
                }
            }
        }
        let _ = self.mount.close(fh).await;
        Ok(acked)
    }

    /// 新建空文件（已存在则成功，对齐 SFTP open creat-no-trunc）
    pub async fn touch(&mut self, sub: &str) -> Result<(), String> {
        let path = normalize_sub(sub);
        match self.mount.create_path(&path, Some(0o644)).await {
            Ok(_) => Ok(()),
            Err(e) => {
                if self.mount.lookup_path(&path).await.is_ok() {
                    Ok(())
                } else {
                    Err(format!("创建文件失败：{e}"))
                }
            }
        }
    }

    /// 新建目录（0755）
    pub async fn mkdir(&mut self, sub: &str) -> Result<(), String> {
        let path = normalize_sub(sub);
        self.mount
            .mkdir_path(&path, 0o755)
            .await
            .map_err(|e| format!("创建目录失败：{e}"))?;
        Ok(())
    }

    /// 删除文件
    pub async fn remove(&mut self, sub: &str) -> Result<(), String> {
        let path = normalize_sub(sub);
        self.mount
            .remove_path(&path)
            .await
            .map_err(|e| format!("删除失败：{e}"))?;
        Ok(())
    }

    /// 删除目录（仅空目录）
    pub async fn rmdir(&mut self, sub: &str) -> Result<(), String> {
        let path = normalize_sub(sub);
        self.mount
            .rmdir_path(&path)
            .await
            .map_err(|e| format!("删除目录失败：{e}"))?;
        Ok(())
    }

    /// 递归删除目录（先删内容再删目录本身）
    pub async fn remove_recursive(&mut self, sub: &str) -> Result<(), String> {
        self.remove_recursive_boxed(&normalize_sub(sub)).await
    }

    fn remove_recursive_boxed<'a>(
        &'a mut self,
        path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let entries = self.list_dir(path).await?;
            for (name, attrs) in entries {
                let child = join_sub(path, &name);
                if attrs.is_dir {
                    self.remove_recursive_boxed(&child).await?;
                } else {
                    self.remove(&child).await?;
                }
            }
            self.rmdir(path).await
        })
    }

    /// 重命名/移动（挂载根内）
    pub async fn rename(&mut self, old: &str, new: &str) -> Result<(), String> {
        self.mount
            .rename_path(&normalize_sub(old), &normalize_sub(new))
            .await
            .map_err(|e| format!("重命名失败：{e}"))?;
        Ok(())
    }

    /// 断开（unmount + 关连接）
    pub async fn close(&mut self) {
        let _ = self.mount.umount().await;
    }
}

/// 列出服务器全部导出（等价 showmount -e，无需已有挂载；nfs://host 根视图用）。
/// list_exports 只走 mountd（rpcbind 发现端口），显式 port 时固定 mountport。
pub async fn list_exports(host: &str, port: Option<u16>) -> Result<Vec<String>, String> {
    let target = match port {
        Some(p) => format!("nfs://{host}?mountport={p}&version=3"),
        None => format!("nfs://{host}/.?version=3"),
    };
    let fut = nfs_rs::list_exports(&target);
    match tokio::time::timeout(RPC_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v.into_iter().map(|e| e.path).collect()),
        Ok(Err(e)) => Err(format!("查询导出列表失败：{e}")),
        Err(_) => Err("查询导出列表超时（15s，rpcbind/mountd 无响应）".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// UTF-8 / 特殊字符的挂载 URL 编码：中文按字节编码，'/' 保留为分隔符
    #[test]
    fn mount_url_encodes_segments() {
        assert_eq!(
            mount_url("192.168.1.5", None, "/srv/nfs-share"),
            "nfs://192.168.1.5/srv/nfs-share?version=3"
        );
        assert_eq!(
            mount_url("h1", Some(20490), "/文档 dir/a~b"),
            "nfs://h1:20490/%E6%96%87%E6%A1%A3%20dir/a~b?version=3"
        );
        // 段内 '/' 与空格不会被混入段编码；端口缺省时走 rpcbind
        assert_eq!(mount_url("h1", None, "/x y/z%z"), "nfs://h1/x%20y/z%25z?version=3");
    }

    #[test]
    fn attrs_parse_type_mode_mtime() {
        let mut a = NfsAttrRaw::default();
        a.type_ = 2;
        a.file_mode = 0o040755;
        a.filesize = 4096;
        a.mtime.seconds = 1700000000;
        a.mtime.nseconds = 500_000_000;
        let n = NfsAttrs::from_raw(&a);
        assert!(n.is_dir);
        assert!(!n.is_symlink);
        assert_eq!(n.size, 4096);
        assert_eq!(n.mtime, Some(1700000000500));
        assert_eq!(n.perm_string(), "drwxr-xr-x");

        let mut s = NfsAttrRaw::default();
        s.type_ = 3;
        s.file_mode = 0o120777;
        let n2 = NfsAttrs::from_raw(&s);
        assert!(n2.is_symlink);
        assert_eq!(n2.perm_string(), "lrwxrwxrwx");
    }

    #[test]
    fn sub_path_normalize_and_join() {
        assert_eq!(normalize_sub(""), "");
        assert_eq!(normalize_sub("/"), "");
        assert_eq!(normalize_sub("/a/b/"), "/a/b");
        assert_eq!(normalize_sub("a"), "/a");
        assert_eq!(join_sub("", "f"), "/f");
        assert_eq!(join_sub("/d", "f"), "/d/f");
        assert_eq!(join_sub("/d/", "f"), "/d/f");
    }
}
