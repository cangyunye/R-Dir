//! 内容搜索（VSCode 风格，字面量关键词）。
//!
//! 行为设计（对齐 ripgrep 常用直觉但刻意简化）：
//! - 关键词按字面量处理（`regex::escape`），不做正则解析；
//! - 默认跳过隐藏文件/目录（名称以 `.` 开头）；
//! - 跳过二进制文件（前 8KB 含 NUL 字节即视为二进制）；
//! - 超过 `MAX_FILE_BYTES` 的文件不搜内容；
//! - 每文件最多 `MAX_PER_FILE` 条命中，总计最多 `MAX_TOTAL` 条，防止大目录卡死；
//! - `recursive = false` 时只搜当前目录的直接子文件（默认，用户明确要求）；
//! - 单行最多保留 `MAX_LINE_CHARS` 字符。

use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// 单个文件搜索上限（字节）
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// 单文件最多返回的命中行数
const MAX_PER_FILE: usize = 50;
/// 总命中上限
const MAX_TOTAL: usize = 300;
/// 命中行截断长度
const MAX_LINE_CHARS: usize = 300;

#[derive(Serialize)]
pub struct SearchMatch {
    pub path: String,
    /// 相对搜索根目录的展示路径
    pub rel_path: String,
    pub line_number: usize,
    pub line: String,
}

pub fn search_content(
    query: &str,
    dir: &str,
    recursive: bool,
    case_sensitive: bool,
) -> Result<Vec<SearchMatch>, String> {
    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let pattern = regex::escape(query.trim());
    let re = Regex::new(&pattern)
        .map(|r| {
            if case_sensitive {
                r
            } else {
                // 构造不区分大小写版本
                Regex::new(&format!("(?i){pattern}")).expect("regex 已合法")
            }
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let mut total = 0usize;
    walk(&root, &root, recursive, &re, &mut out, &mut total);
    Ok(out)
}

fn walk(
    dir: &Path,
    root: &Path,
    recursive: bool,
    re: &Regex,
    out: &mut Vec<SearchMatch>,
    total: &mut usize,
) {
    if *total >= MAX_TOTAL {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if *total >= MAX_TOTAL {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // 跳过隐藏项
        }
        if path.is_dir() {
            if recursive {
                walk(&path, root, recursive, re, out, total);
            }
        } else {
            search_file(&path, root, re, out, total);
        }
    }
}

fn search_file(
    path: &Path,
    root: &Path,
    re: &Regex,
    out: &mut Vec<SearchMatch>,
    total: &mut usize,
) {
    if *total >= MAX_TOTAL {
        return;
    }
    // 大小限制
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_FILE_BYTES {
            return;
        }
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return,
    };
    // 二进制检测：前 8KB 出现 NUL 视为二进制
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return;
    }
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return, // 非 UTF-8 文本不做解码搜索（避免乱码误报）
    };

    let rel = rel_path(path, root);
    let mut file_hits = 0usize;
    for (i, line) in text.lines().enumerate() {
        if *total >= MAX_TOTAL || file_hits >= MAX_PER_FILE {
            return;
        }
        if re.is_match(line) {
            out.push(SearchMatch {
                path: path.to_string_lossy().into_owned(),
                rel_path: rel.clone(),
                line_number: i + 1,
                line: truncate(line, MAX_LINE_CHARS),
            });
            *total += 1;
            file_hits += 1;
        }
    }
}

/// 计算相对展示路径；与根目录相同时返回文件名。
fn rel_path(path: &Path, root: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) => {
            let s = rel.to_string_lossy().into_owned();
            if s.is_empty() {
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| s)
            } else {
                s
            }
        }
        Err(_) => path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        let mut cut: String = chars[..max].iter().collect();
        cut.push('…');
        cut
    }
}

// 便于直接跑 `cargo test` 的单元测试
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_works() {
        assert_eq!(truncate("abc", 5), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }

    #[test]
    fn rel_path_works() {
        use std::path::PathBuf;
        let root = PathBuf::from("/a/b");
        let p = PathBuf::from("/a/b/c/d.txt");
        assert_eq!(rel_path(&p, &root), "c/d.txt");
        assert_eq!(rel_path(&root, &root), "b");
    }

    /// 真实目录搜索：当前层只命中直接子文件，递归命中子目录内文件
    #[test]
    fn search_real_dir() {
        let root = std::env::temp_dir().join("rfm_search_test");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.txt"), "hello world\nfoo bar\n").unwrap();
        std::fs::write(root.join(".hidden.txt"), "hello hidden\n").unwrap();
        std::fs::write(root.join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        std::fs::write(sub.join("c.md"), "deep hello here\n").unwrap();
        std::fs::write(sub.join("big.log"), "x".repeat(5 * 1024 * 1024)).unwrap();

        // 非递归：只命中 a.txt 的一行
        let hits = search_content("hello", root.to_str().unwrap(), false, false).unwrap();
        assert!(hits.iter().any(|m| m.rel_path == "a.txt" && m.line_number == 1));
        assert!(!hits.iter().any(|m| m.rel_path == "sub/c.md"), "非递归不应进入子目录");
        assert!(!hits.iter().any(|m| m.rel_path == ".hidden.txt"), "应跳过隐藏文件");
        assert!(!hits.iter().any(|m| m.rel_path == "b.bin"), "应跳过二进制");
        assert!(!hits.iter().any(|m| m.rel_path == "big.log"), "应跳过超大文件");

        // 递归：命中 c.md
        let hits = search_content("hello", root.to_str().unwrap(), true, false).unwrap();
        assert!(hits.iter().any(|m| m.rel_path == "sub/c.md"));

        // 大小写不敏感命中 Hello；敏感时不命中
        assert!(search_content("HELLO", root.to_str().unwrap(), false, false)
            .unwrap()
            .iter()
            .any(|m| m.rel_path == "a.txt"));
        assert!(!search_content("HELLO", root.to_str().unwrap(), false, true)
            .unwrap()
            .iter()
            .any(|m| m.rel_path == "a.txt"));

        std::fs::remove_dir_all(&root).ok();
    }
}
