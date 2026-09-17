//! SFTP v3 协议报文编解码（russh 只提供 SSH 传输，SFTP 子协议在此实现）。
//! 覆盖：列目录 / stat / 打开下载 / 新建 / 删除 / 重命名 / 上传。
//! 报文格式：u32 length(不含自身) + u8 type + 内容，请求均带 u32 request-id。

#![allow(dead_code)] // 完整协议常量/编解码函数，写操作场景会逐步用上

use std::collections::HashMap;

// 请求类型（v3）
pub const INIT: u8 = 1;
pub const OPEN: u8 = 3;
pub const CLOSE: u8 = 4;
pub const READ: u8 = 5;
pub const WRITE: u8 = 6;
pub const OPENDIR: u8 = 11;
pub const READDIR: u8 = 12;
pub const REMOVE: u8 = 13;
pub const MKDIR: u8 = 14;
pub const RMDIR: u8 = 15;
pub const REALPATH: u8 = 16;
pub const STAT: u8 = 17;
pub const RENAME: u8 = 18;
pub const FSTAT: u8 = 8;

// 回复类型
pub const VERSION: u8 = 2;
pub const STATUS: u8 = 101;
pub const HANDLE: u8 = 102;
pub const DATA: u8 = 103;
pub const NAME: u8 = 104;
pub const ATTRS: u8 = 105;

// 打开模式（OpenFlags，v3 常用子集）
pub const FXF_READ: u32 = 0x1;
pub const FXF_WRITE: u32 = 0x2;
pub const FXF_APPEND: u32 = 0x4;
pub const FXF_CREAT: u32 = 0x8;
pub const FXF_TRUNC: u32 = 0x10;
pub const FXF_EXCL: u32 = 0x20;

// 属性 flags
pub const ATTR_SIZE: u32 = 0x1;
pub const ATTR_UIDGID: u32 = 0x2;
pub const ATTR_PERMISSIONS: u32 = 0x4;
pub const ATTR_ACMODTIME: u32 = 0x8;

/// 错误码（STATUS 报文中的 error code）
pub mod err {
    pub const OK: u32 = 0;
    pub const EOF: u32 = 1;
    pub const NO_SUCH_FILE: u32 = 2;
    pub const PERMISSION_DENIED: u32 = 3;
    pub const FAILURE: u32 = 4;
    pub const BAD_MESSAGE: u32 = 5;
    pub const NO_CONNECTION: u32 = 6;
    pub const CONNECTION_LOST: u32 = 7;
    pub const OP_UNSUPPORTED: u32 = 8;
}

pub fn err_str(code: u32, msg: &str) -> String {
    let name = match code {
        err::EOF => "EOF",
        err::NO_SUCH_FILE => "文件不存在",
        err::PERMISSION_DENIED => "权限不足",
        err::FAILURE => "操作失败",
        err::BAD_MESSAGE => "报文错误",
        err::NO_CONNECTION => "无连接",
        err::CONNECTION_LOST => "连接已断开",
        err::OP_UNSUPPORTED => "操作不支持",
        _ => "未知错误",
    };
    if msg.is_empty() {
        name.to_string()
    } else {
        format!("{name}（{msg}）")
    }
}

/// SFTP 条目属性（解析后的 v3 attrs）
#[derive(Debug, Clone, Default)]
pub struct SftpAttrs {
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub permissions: u32,
    pub mtime: Option<i64>,
    pub atime: Option<i64>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

impl SftpAttrs {
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
            let bits = (self.permissions >> shift) & 0o7;
            s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
            s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
            s.push(if bits & 0o1 != 0 { 'x' } else { '-' });
        }
        s
    }
}

/// 简易字节写入器（big-endian 按 SFTP 规范）
#[derive(Default)]
pub struct Buf {
    pub data: Vec<u8>,
}

impl Buf {
    pub fn new() -> Self {
        Self { data: Vec::new() }
    }
    pub fn u8(&mut self, v: u8) {
        self.data.push(v);
    }
    pub fn u32(&mut self, v: u32) {
        self.data.extend_from_slice(&v.to_be_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.data.extend_from_slice(&v.to_be_bytes());
    }
    pub fn str(&mut self, s: &str) {
        let b = s.as_bytes();
        self.u32(b.len() as u32);
        self.data.extend_from_slice(b);
    }
    pub fn raw(&mut self, b: &[u8]) {
        self.data.extend_from_slice(b);
    }
    /// 追加到 channel 发送缓冲：u32 len + body（len 不含自身）
    pub fn finalize(self) -> Vec<u8> {
        let len = self.data.len() as u32;
        let mut out = Vec::with_capacity(len as usize + 4);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&self.data);
        out
    }
}

/// 简易字节读取器
pub struct Reader<'a> {
    data: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.data.len() {
            return Err("SFTP 报文截断".into());
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    pub fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    pub fn str(&mut self) -> Result<String, String> {
        let len = self.u32()? as usize;
        let b = self.take(len)?;
        Ok(String::from_utf8_lossy(b).to_string())
    }
    pub fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }
}

/// 解析 attrs（从当前位置到报文尾，v3）
pub fn parse_attrs(r: &mut Reader) -> Result<SftpAttrs, String> {
    let flags = r.u32()?;
    let mut a = SftpAttrs::default();
    if flags & ATTR_SIZE != 0 {
        a.size = r.u64()?;
    }
    if flags & ATTR_UIDGID != 0 {
        a.uid = Some(r.u32()?);
        a.gid = Some(r.u32()?);
    }
    if flags & ATTR_PERMISSIONS != 0 {
        a.permissions = r.u32()?;
        const S_IFMT: u32 = 0o170000;
        const S_IFDIR: u32 = 0o040000;
        const S_IFLNK: u32 = 0o120000;
        a.is_dir = a.permissions & S_IFMT == S_IFDIR;
        a.is_symlink = a.permissions & S_IFMT == S_IFLNK;
    }
    if flags & ATTR_ACMODTIME != 0 {
        a.atime = Some(r.u32()? as i64);
        a.mtime = Some(r.u32()? as i64);
    }
    Ok(a)
}

/// 解析 NAME 报文（readdir / realpath 结果）
pub fn parse_name(data: &[u8]) -> Result<Vec<(String, SftpAttrs)>, String> {
    let mut r = Reader::new(data);
    let count = r.u32()? as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let name = r.str()?;
        let _longname = r.str()?;
        let attrs = parse_attrs(&mut r)?;
        out.push((name, attrs));
    }
    Ok(out)
}

/// 解析 STATUS 报文 → 错误字符串；code=0 返回 None
pub fn parse_status(data: &[u8]) -> Result<Option<String>, String> {
    let mut r = Reader::new(data);
    let code = r.u32()?;
    let msg = r.str()?;
    let _lang = r.str()?;
    if code == 0 {
        Ok(None)
    } else {
        Ok(Some(err_str(code, &msg)))
    }
}

/// 解析 VERSION 报文（记录扩展名）
pub fn parse_version(data: &[u8]) -> Result<u32, String> {
    let mut r = Reader::new(data);
    let version = r.u32()?;
    let _ext_count = r.u32().unwrap_or(0);
    Ok(version)
}

/// 会话初始化请求：SSH_FXP_INIT
pub fn init_request() -> Vec<u8> {
    let mut b = Buf::new();
    b.u8(INIT);
    b.u32(3); // version
    b.finalize()
}

/// 服务器端 VERSION 应答：SSH_FXP_VERSION
pub fn version_reply(version: u32) -> Vec<u8> {
    let mut b = Buf::new();
    b.u8(VERSION);
    b.u32(version);
    b.finalize()
}

/// 发送方校验：普通请求包裹 request-id
pub fn request(id: u32, type_: u8, payload: &dyn Fn(&mut Buf)) -> Vec<u8> {
    let mut b = Buf::new();
    b.u8(type_);
    b.u32(id);
    payload(&mut b);
    b.finalize()
}

/// 解析收到的包：返回 (type, request_id, body)
pub fn parse_packet(data: &[u8]) -> Result<(u8, u32, &[u8]), String> {
    if data.len() < 5 {
        return Err("SFTP 包过短".into());
    }
    let type_ = data[0];
    let id = u32::from_be_bytes(data[1..5].try_into().unwrap());
    Ok((type_, id, &data[5..]))
}

/// 权限位（用于 mkdir 默认 0755）
pub const DEFAULT_DIR_PERM: u32 = 0o40755;
pub const DEFAULT_FILE_PERM: u32 = 0o100644;

/// 从服务器扩展名列表构建 map（当前仅记录，方便调试）
pub fn collect_extensions(data: &[u8]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut r = Reader::new(data);
    if let Ok(count) = r.u32() {
        for _ in 0..count {
            if let (Ok(k), Ok(v)) = (r.str(), r.str()) {
                map.insert(k, v);
            }
        }
    }
    map
}
