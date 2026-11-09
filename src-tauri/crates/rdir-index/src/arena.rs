//! 打包路径存储与正排元数据。
//!
//! 百万文件量级下，`HashMap<String, _>` 式存储每条路径一次堆分配 + String 头开销 +
//! 容量冗余，轻松突破内存预算；本模块把全部路径连续放进一块 UTF-8 buffer，
//! 条目只记 `(offset, len)`，整表读取（建 gram、全量扫）对 CPU cache 也更友好。

use serde::{Deserialize, Serialize};

/// 单条目的正排元数据（AoS：按 id 顺序整表扫描时对缓存友好）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntryMeta {
    /// 路径在 arena 中的起始字节偏移
    pub off: u32,
    /// 路径字节长度
    pub len: u32,
    /// 文件名（路径末段）字节长度——gram 提取与名称匹配只看这一段
    pub name_len: u32,
    pub is_dir: bool,
    /// 文件大小（字节；目录为 0）。增量重扫对未变目录沿用旧值（名字集合未变，
    /// size/mtime 可能陈旧，下次全量重建校正——一切以搜索正确性为先）
    pub size: u64,
    /// 修改时间（Unix 毫秒；取不到为 0）
    pub mtime: i64,
    /// 目录自身 mtime（增量重扫剪枝依据：仅在子项增删改名时变化；非目录恒为 0）
    pub dir_mtime: i64,
}

/// 连续 UTF-8 路径 buffer。
#[derive(Clone, Default, Debug)]
pub struct PathArena {
    buf: Vec<u8>,
}

impl PathArena {
    pub fn with_capacity(cap: usize) -> Self {
        Self { buf: Vec::with_capacity(cap) }
    }

    /// 追加一个路径，返回 `(offset, len)`。
    pub fn push(&mut self, s: &str) -> (u32, u32) {
        let off = self.buf.len() as u32;
        self.buf.extend_from_slice(s.as_bytes());
        (off, s.len() as u32)
    }

    /// 取回路径切片。buffer 只由 `push`（合法 `&str`）写入，免校验直取。
    pub fn get(&self, off: u32, len: u32) -> &str {
        let s = &self.buf[off as usize..(off + len) as usize];
        // SAFETY: 写入方只 push 合法 UTF-8
        unsafe { std::str::from_utf8_unchecked(s) }
    }

    /// 打包字节数（内存占用统计用）
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    /// 全部字节（快照序列化用）
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    /// 快照反序列化重建
    pub fn from_bytes(buf: Vec<u8>) -> Self {
        Self { buf }
    }
}

/// 文件名 = 路径最后一个分隔符之后的段；返回其在路径内的字节偏移。
/// 无分隔符则整条路径就是文件名（偏移 0）。
pub fn name_offset(path: &str) -> usize {
    match path.rfind(|c| c == '/' || c == '\\') {
        Some(i) => i + 1,
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_get_roundtrip() {
        let mut a = PathArena::default();
        let (o1, l1) = a.push("/home/u/文件.txt");
        let (o2, l2) = a.push("C:\\data\\x.md");
        assert_eq!(a.get(o1, l1), "/home/u/文件.txt");
        assert_eq!(a.get(o2, l2), "C:\\data\\x.md");
        // 多字节路径不破坏后续偏移
        assert_ne!(o1, o2);
    }

    #[test]
    fn name_offset_works() {
        assert_eq!(name_offset("/a/b/c.txt"), 5); // "c.txt"
        assert_eq!(name_offset("C:\\a\\b.md"), 5); // "b.md"（第 2 个 \ 在下标 4）
        assert_eq!(name_offset("plain"), 0);
        assert_eq!(name_offset("/ends-with-sep/"), 15); // 空名（防御）
    }
}
