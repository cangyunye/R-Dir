//! SFTP v3 协议报文编解码（russh 只提供 SSH 传输，SFTP 子协议在此实现）。
//! 覆盖：列目录 / stat / 打开下载 / 新建 / 删除 / 重命名 / 上传。
//! 报文格式：u32 length(不含自身) + u8 type + 内容，请求均带 u32 request-id。

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

// 回复类型
pub const VERSION: u8 = 2;
pub const STATUS: u8 = 101;
pub const DATA: u8 = 103;
pub const NAME: u8 = 104;

// 打开模式（OpenFlags，v3 常用子集）
pub const FXF_READ: u32 = 0x1;
pub const FXF_WRITE: u32 = 0x2;
pub const FXF_CREAT: u32 = 0x8;
pub const FXF_TRUNC: u32 = 0x10;

// 属性 flags
pub const ATTR_SIZE: u32 = 0x1;
pub const ATTR_UIDGID: u32 = 0x2;
pub const ATTR_PERMISSIONS: u32 = 0x4;
pub const ATTR_ACMODTIME: u32 = 0x8;

/// 错误码（STATUS 报文中的 error code）
pub mod err {
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
        // 读掉但不保留（v3 报文里 u32 uid + u32 gid 必须消费，否则后续解析错位）
        r.u32()?;
        r.u32()?;
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
        r.u32()?; // atime 读掉不用
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

/// 权限位（用于 mkdir 默认 0755）
pub const DEFAULT_DIR_PERM: u32 = 0o40755;
pub const DEFAULT_FILE_PERM: u32 = 0o100644;

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- Buf / Reader roundtrip ----------

    #[test]
    fn u32_u64_str_roundtrip() {
        let mut b = Buf::new();
        b.u32(7);
        b.u64(u64::MAX);
        b.str("");
        b.str("路径/测试🎉");

        let mut r = Reader::new(&b.data);
        assert_eq!(r.u32().unwrap(), 7);
        assert_eq!(r.u64().unwrap(), u64::MAX);
        assert_eq!(r.str().unwrap(), "");
        assert_eq!(r.str().unwrap(), "路径/测试🎉");
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn finalize_prefixes_length_excluding_self() {
        let mut b = Buf::new();
        b.u32(1);
        let framed = b.finalize();
        assert_eq!(framed.len(), 8);
        assert_eq!(u32::from_be_bytes(framed[..4].try_into().unwrap()), 4);
        assert_eq!(&framed[4..], &[0, 0, 0, 1]);
    }

    // ---------- 截断 / 坏包：必须 Err 不 panic ----------

    #[test]
    fn reader_truncated_returns_err() {
        let mut b = Buf::new();
        b.u32(1);
        b.u64(2);
        let full = b.data.clone();
        for cut in 0..full.len() {
            let mut r = Reader::new(&full[..cut]);
            let ok = r.u32().is_ok() && r.u64().is_ok();
            assert!(!ok, "截断到 {cut} 字节不应同时读出 u32+u64");
        }

        let mut b2 = Buf::new();
        b2.str("abc");
        let full2 = b2.data.clone();
        // 长度字段未完整或数据不足的每个截断点都要 Err
        for cut in 0..full2.len() - 1 {
            let mut r = Reader::new(&full2[..cut]);
            assert!(r.str().is_err(), "str 截断到 {cut} 字节应报错");
        }
    }

    #[test]
    fn reader_str_length_overrun_is_err_not_panic() {
        // 长度字段撒谎（声称 1MB，实际没有数据）
        let mut b = Buf::new();
        b.u32(1_048_576);
        let mut r = Reader::new(&b.data);
        assert!(r.str().is_err());
    }

    // ---------- parse_attrs ----------

    #[test]
    fn attrs_all_flags_roundtrip() {
        let mut b = Buf::new();
        b.u32(ATTR_SIZE | ATTR_UIDGID | ATTR_PERMISSIONS | ATTR_ACMODTIME);
        b.u64(12345);
        b.u32(1000); // uid
        b.u32(1000); // gid
        b.u32(0o040755); // drwxr-xr-x
        b.u32(1700000000); // atime
        b.u32(1700000001); // mtime

        let mut r = Reader::new(&b.data);
        let a = parse_attrs(&mut r).unwrap();
        assert_eq!(a.size, 12345);
        assert!(a.is_dir);
        assert!(!a.is_symlink);
        assert_eq!(a.permissions, 0o040755);
        assert_eq!(a.mtime, Some(1700000001));
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn attrs_no_flags_is_default() {
        let mut b = Buf::new();
        b.u32(0);
        let mut r = Reader::new(&b.data);
        let a = parse_attrs(&mut r).unwrap();
        assert_eq!(a.size, 0);
        assert!(!a.is_dir);
        assert_eq!(a.mtime, None);
    }

    #[test]
    fn attrs_symlink_permissions() {
        let mut b = Buf::new();
        b.u32(ATTR_PERMISSIONS);
        b.u32(0o120777);
        let mut r = Reader::new(&b.data);
        let a = parse_attrs(&mut r).unwrap();
        assert!(a.is_symlink);
        assert!(!a.is_dir);
        assert_eq!(a.perm_string(), "lrwxrwxrwx");
    }

    #[test]
    fn attrs_truncated_is_err() {
        // flags 声称有 SIZE 但缺 8 字节
        let mut b = Buf::new();
        b.u32(ATTR_SIZE);
        b.u32(0);
        let mut r = Reader::new(&b.data);
        assert!(parse_attrs(&mut r).is_err());
    }

    #[test]
    fn perm_string_variants() {
        let a = SftpAttrs {
            is_dir: true,
            permissions: 0o040755,
            ..Default::default()
        };
        assert_eq!(a.perm_string(), "drwxr-xr-x");
        let f = SftpAttrs {
            permissions: 0o100644,
            ..Default::default()
        };
        assert_eq!(f.perm_string(), "-rw-r--r--");
    }

    // ---------- parse_name ----------

    #[test]
    fn name_roundtrip_two_entries() {
        let mut b = Buf::new();
        b.u32(2); // count
        for name in ["a.txt", "目录"] {
            b.str(name);
            b.str(&format!("{name} longname"));
            b.u32(ATTR_SIZE | ATTR_PERMISSIONS);
            b.u64(42);
            b.u32(0o100644);
        }
        let entries = parse_name(&b.data).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "a.txt");
        assert_eq!(entries[0].1.size, 42);
        assert!(!entries[0].1.is_dir);
        assert_eq!(entries[1].0, "目录");
    }

    #[test]
    fn name_zero_count_empty_ok() {
        let mut b = Buf::new();
        b.u32(0);
        let entries = parse_name(&b.data).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn name_truncated_is_err() {
        // count 声称 1 但没有条目数据
        let mut b = Buf::new();
        b.u32(1);
        assert!(parse_name(&b.data).is_err());
        // 条目缺 attrs
        let mut b2 = Buf::new();
        b2.u32(1);
        b2.str("x");
        b2.str("");
        assert!(parse_name(&b2.data).is_err());
    }

    // ---------- parse_status ----------

    #[test]
    fn status_zero_is_none() {
        let mut b = Buf::new();
        b.u32(0);
        b.str("");
        b.str("");
        assert_eq!(parse_status(&b.data).unwrap(), None);
    }

    #[test]
    fn status_error_with_and_without_message() {
        let mut b = Buf::new();
        b.u32(err::NO_SUCH_FILE);
        b.str("");
        b.str("en");
        assert_eq!(parse_status(&b.data).unwrap(), Some("文件不存在".into()));

        let mut b2 = Buf::new();
        b2.u32(err::PERMISSION_DENIED);
        b2.str("locked");
        b2.str("en");
        assert_eq!(
            parse_status(&b2.data).unwrap(),
            Some("权限不足（locked）".into())
        );

        // 未知错误码
        let mut b3 = Buf::new();
        b3.u32(9999);
        b3.str("");
        b3.str("");
        assert_eq!(parse_status(&b3.data).unwrap(), Some("未知错误".into()));
    }

    #[test]
    fn status_truncated_is_err() {
        let mut b = Buf::new();
        b.u32(err::EOF);
        assert!(parse_status(&b.data).is_err()); // 缺 msg/lang
    }

    // ---------- parse_version ----------

    #[test]
    fn version_and_extensions() {
        let mut b = Buf::new();
        b.u32(3);
        b.u32(1); // 扩展数
        b.str("ext-name");
        b.str("1");
        assert_eq!(parse_version(&b.data).unwrap(), 3);

        // 无扩展段（截断的 ext_count 容忍——unwrap_or(0)）
        let mut b2 = Buf::new();
        b2.u32(3);
        assert_eq!(parse_version(&b2.data).unwrap(), 3);
    }
}
