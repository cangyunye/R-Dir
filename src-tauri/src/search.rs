//! 内容搜索（VSCode 风格）。
//!
//! 行为设计（对齐 ripgrep 常用直觉但刻意简化）：
//! - 默认关键词按字面量处理（`regex::escape`）；`use_regex = true` 时按正则解析
//!   （等价 rg 默认行为，字面量对应 rg `-F`）；
//! - 默认跳过隐藏文件/目录（名称以 `.` 开头），`include_hidden = true` 时包含
//!   （等价 rg `--hidden`）；
//! - 编码自动探测（v0.44，与预览共用 `text_diff::decode_auto`）：UTF-8（含 BOM）/ UTF-16
//!   （BOM 或 NUL 奇偶位启发）/ GBK；无法无损解码的（其他编码 / 乱码 / 前 8KB 无 NUL 的二进制）
//!   不搜，避免乱码误报；
//! - 跳过二进制文件（前 8KB 含 NUL 字节且不像 UTF-16 即视为二进制）；
//! - 超过 `MAX_FILE_BYTES` 的文件不搜内容；
//! - 每文件最多 `MAX_PER_FILE` 条命中，总计最多 `MAX_TOTAL` 条，防止大目录卡死；
//! - `recursive = false` 时只搜当前目录的直接子文件（默认，用户明确要求）；
//! - `max_depth` 限制递归层数（None = 不限；Some(1) = 只搜当前层，与 walkdir
//!   语义对齐：根目录第 0 层、直接子项第 1 层）；
//! - 不跟随目录符号链接（`entry.file_type()` 判定，防止环；对齐 find 的
//!   `follow_links(false)`）；
//! - 单行最多保留 `MAX_LINE_CHARS` 字符。

use crate::text_diff::{decode_auto, NonUtf8};
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
    include_hidden: bool,
    use_regex: bool,
    max_depth: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // 字面量关键词做 regex::escape；正则模式直接编译（编译错误原样返回给 UI）
    let trimmed = query.trim();
    let pattern = if use_regex {
        trimmed.to_string()
    } else {
        regex::escape(trimmed)
    };
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
    walk(
        &root,
        &root,
        recursive,
        include_hidden,
        max_depth,
        &re,
        &mut out,
        &mut total,
        1,
    );
    Ok(out)
}

/// `depth` = 当前目录内文件所处的层级（根的直接子文件为第 1 层）。
/// 进入子目录的文件在第 depth+1 层，超过 `max_depth` 即剪枝（Some(1) = 只搜当前层）。
fn walk(
    dir: &Path,
    root: &Path,
    recursive: bool,
    include_hidden: bool,
    max_depth: Option<usize>,
    re: &Regex,
    out: &mut Vec<SearchMatch>,
    total: &mut usize,
    depth: usize,
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
        if !include_hidden && name.starts_with('.') {
            continue; // 跳过隐藏项
        }
        // entry.file_type() 不跟随符号链接（is_dir 对符号链接为 false），
        // 目录符号链接按文件处理（read 失败自然跳过），杜绝符号链接环
        let is_dir = matches!(entry.file_type(), Ok(ft) if ft.is_dir());
        if is_dir {
            // 子目录内文件在第 depth+1 层，达到上限就不再进入
            if recursive && max_depth.map_or(true, |m| depth + 1 <= m) {
                walk(
                    &path,
                    root,
                    recursive,
                    include_hidden,
                    max_depth,
                    re,
                    out,
                    total,
                    depth + 1,
                );
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
    // 此前只认合法 UTF-8，GBK 文件整文件跳过（连 ASCII 关键词也搜不到）；
    // UTF-16 的 lossy 多为启发误判的二进制，同样不搜
    let text = match decode_auto(bytes, NonUtf8::GbkOrSkip) {
        Some(d) if !d.lossy => d.text,
        _ => return,
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
            let s = rel.to_string_lossy().replace('\\', "/");
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
        // PNG 头（NUL 散布在奇偶位）+ 关键词：二进制跳过才不命中；[0,1,2,3] 这类极短字节会被 UTF-16 启发收下，测不出跳过
        let png_head: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52];
        std::fs::write(root.join("b.bin"), [png_head, b"hello"].concat()).unwrap();
        std::fs::write(sub.join("c.md"), "deep hello here\n").unwrap();
        std::fs::write(sub.join("big.log"), "x".repeat(5 * 1024 * 1024)).unwrap();

        // 非递归：只命中 a.txt 的一行
        let hits = search_content("hello", root.to_str().unwrap(), false, false, false, false, None).unwrap();
        assert!(hits.iter().any(|m| m.rel_path == "a.txt" && m.line_number == 1));
        assert!(!hits.iter().any(|m| m.rel_path == "sub/c.md"), "非递归不应进入子目录");
        assert!(!hits.iter().any(|m| m.rel_path == ".hidden.txt"), "应跳过隐藏文件");
        assert!(!hits.iter().any(|m| m.rel_path == "b.bin"), "应跳过二进制");
        assert!(!hits.iter().any(|m| m.rel_path == "big.log"), "应跳过超大文件");

        // 递归：命中 c.md
        let hits = search_content("hello", root.to_str().unwrap(), true, false, false, false, None).unwrap();
        assert!(hits.iter().any(|m| m.rel_path == "sub/c.md"));

        // 大小写不敏感命中 Hello；敏感时不命中
        assert!(search_content("HELLO", root.to_str().unwrap(), false, false, false, false, None)
            .unwrap()
            .iter()
            .any(|m| m.rel_path == "a.txt"));
        assert!(!search_content("HELLO", root.to_str().unwrap(), false, true, false, false, None)
            .unwrap()
            .iter()
            .any(|m| m.rel_path == "a.txt"));

        // include_hidden：命中 .hidden.txt
        let hits = search_content("hidden", root.to_str().unwrap(), false, false, true, false, None).unwrap();
        assert!(hits.iter().any(|m| m.rel_path == ".hidden.txt"), "应包含隐藏文件");

        // use_regex：正则 hel+o 命中 hello；字面量模式下 hel+o 无命中
        assert!(search_content(r"hel+o", root.to_str().unwrap(), false, false, false, true, None)
            .unwrap()
            .iter()
            .any(|m| m.rel_path == "a.txt"));
        assert!(search_content(r"hel+o", root.to_str().unwrap(), false, false, false, false, None)
            .unwrap()
            .is_empty());
        // 正则语法错误返回 Err（UI 显示错误提示）
        assert!(search_content("(unclosed", root.to_str().unwrap(), false, false, false, true, None).is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    /// max_depth 语义（对齐 walkdir：根第 0 层、直接子项第 1 层）：
    /// Some(1) 只搜当前层文件，Some(2) 深入一层子目录，None 全部
    #[test]
    fn search_max_depth() {
        let root = std::env::temp_dir().join("rfm_search_depth_test");
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("sub");
        let deep = sub.join("deep");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(root.join("a.txt"), "hello\n").unwrap();
        std::fs::write(sub.join("b.txt"), "hello\n").unwrap();
        std::fs::write(deep.join("c.txt"), "hello\n").unwrap();
        let dir = root.to_str().unwrap();
        let paths = |d: Option<usize>| -> Vec<String> {
            let mut v: Vec<String> = search_content("hello", dir, true, false, false, false, d)
                .unwrap()
                .into_iter()
                .map(|m| m.rel_path)
                .collect();
            v.sort();
            v
        };
        assert_eq!(paths(Some(1)), vec!["a.txt"]);
        assert_eq!(paths(Some(2)), vec!["a.txt", "sub/b.txt"]);
        assert_eq!(paths(None), vec!["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
        std::fs::remove_dir_all(&root).ok();
    }

    /// v0.44 编码探测：GBK / UTF-16 / UTF-8 BOM 可搜；Big5 按 GBK 解成错字（ASCII 照常命中、繁体不中，
    /// 单一回退的已知取舍）；既非 UTF-8 也非 GBK 的（CP1252、前 8KB 无 NUL 的类 PDF 二进制）仍跳过
    #[test]
    fn search_decodes_legacy_encodings() {
        let root = std::env::temp_dir().join("rfm_search_enc_test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let text = "第一行 hello\n中文内容测试\n";
        std::fs::write(root.join("gbk.txt"), encoding_rs::GBK.encode(text).0).unwrap();
        let mut le = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(root.join("utf16le.txt"), &le).unwrap();
        std::fs::write(root.join("bom.txt"), [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat()).unwrap();
        std::fs::write(root.join("big5.txt"), encoding_rs::BIG5.encode("繁體測試 hello\n").0).unwrap();
        std::fs::write(root.join("latin1.txt"), encoding_rs::WINDOWS_1252.encode("café hello\n").0).unwrap();
        std::fs::write(root.join("doc.pdf"), b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj hello\n\xFF\xFF\n").unwrap();

        let dir = root.to_str().unwrap();
        let hits = |q: &str, re: bool| -> Vec<(String, usize)> {
            let mut v: Vec<_> = search_content(q, dir, false, false, false, re, None)
                .unwrap()
                .into_iter()
                .map(|m| (m.rel_path, m.line_number))
                .collect();
            v.sort();
            v
        };
        let at = |name: &str, n: usize| (name.to_string(), n);
        assert_eq!(hits("中文", false), vec![at("bom.txt", 2), at("gbk.txt", 2), at("utf16le.txt", 2)]);
        assert_eq!(
            hits("hello", false),
            vec![at("big5.txt", 1), at("bom.txt", 1), at("gbk.txt", 1), at("utf16le.txt", 1)]
        );
        // UTF-8 BOM 已去除：行首锚定命中第 1 行
        assert_eq!(hits("^第一行", true), vec![at("bom.txt", 1), at("gbk.txt", 1), at("utf16le.txt", 1)]);
        assert!(hits("繁體", false).is_empty());

        std::fs::remove_dir_all(&root).ok();
    }
}
