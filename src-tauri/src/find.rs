//! 快速文件检索（fd 语义）。
//!
//! 实现基于 `ignore` crate —— 这正是 fd 内部使用的遍历引擎，
//! 行为对齐 fd：
//! - 匹配文件名（默认正则，`glob = true` 时为通配符，等价 fd `--glob`）；
//! - `case_sensitive` 显式控制大小写（等价 fd `--case`；不再做 smart case，
//!   与搜索面板 Aa 灯钮的二态语义保持一致）；
//! - 默认跳过隐藏文件/目录、尊重 .gitignore / .ignore；
//! - 并行遍历目录（ignore 内部自带），结果按路径排序保证确定性；
//! - `max_depth` 限制深度；结果上限 `MAX_TOTAL` 防止超大目录卡 UI。

use globset::GlobBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::path::Path;

/// 结果上限
const MAX_TOTAL: usize = 500;

#[derive(Serialize)]
pub struct FindEntry {
    /// 绝对路径
    pub path: String,
    /// 相对搜索根目录的展示路径
    pub rel_path: String,
    pub is_dir: bool,
}

/// 文件名匹配器：正则（fd 默认）或通配符（fd `--glob`，整名匹配）
enum Matcher {
    Regex(regex::Regex),
    Glob(globset::GlobMatcher),
}

impl Matcher {
    fn is_match(&self, name: &str) -> bool {
        match self {
            Matcher::Regex(re) => re.is_match(name),
            Matcher::Glob(g) => g.is_match(name),
        }
    }
}

pub fn find_files(
    pattern: &str,
    dir: &str,
    show_hidden: bool,
    max_depth: Option<usize>,
    glob: bool,
    case_sensitive: bool,
) -> Result<Vec<FindEntry>, String> {
    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Ok(Vec::new());
    }

    let matcher = if glob {
        Matcher::Glob(
            GlobBuilder::new(pattern)
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|e| format!("无效的通配符模式：{e}"))?
                .compile_matcher(),
        )
    } else {
        Matcher::Regex(
            RegexBuilder::new(pattern)
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|e| format!("无效的正则表达式：{e}"))?,
        )
    };

    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(!show_hidden) // ignore 语义：hidden(true) 跳过隐藏项
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .require_git(false)
        .follow_links(false)
        .max_depth(max_depth)
        .sort_by_file_path(|a, b| a.cmp(b)); // 确定性输出

    let mut out: Vec<FindEntry> = Vec::new();
    for entry in builder.build() {
        if out.len() >= MAX_TOTAL {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // 跳过无法读取的条目
        };
        // fd 默认只匹配文件名（而非完整路径）
        if !matcher.is_match(entry.file_name().to_string_lossy().as_ref()) {
            continue;
        }
        let path = entry.path();
        let is_dir = match entry.file_type() {
            Some(ft) => ft.is_dir(),
            None => path.is_dir(),
        };
        out.push(FindEntry {
            path: path.to_string_lossy().into_owned(),
            rel_path: rel_path(path, root),
            is_dir,
        });
    }
    Ok(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_case_and_hidden() {
        let root = std::env::temp_dir().join("rfm_find_test");
        let sub = root.join("src");
        std::fs::create_dir_all(&sub).unwrap();
        // 注意：macOS 默认大小写不敏感 FS，避免创建大小写变体同名文件
        std::fs::write(root.join("CamelCase.rs"), "").unwrap();
        std::fs::write(root.join("plain.txt"), "").unwrap();
        std::fs::write(root.join(".hidden.md"), "").unwrap();
        std::fs::write(sub.join("main.rs"), "").unwrap();

        // 默认不区分大小写：camel / CAMEL 均命中 CamelCase.rs
        for pat in ["camel", "CAMEL"] {
            let hits = find_files(pat, root.to_str().unwrap(), false, None, false, false).unwrap();
            assert!(hits.iter().any(|e| e.rel_path == "CamelCase.rs"), "{pat} 应命中");
        }

        // 区分大小写：CAMEL 不命中 CamelCase.rs，PLAIN 不命中 plain.txt，plain 命中
        let hits = find_files("CAMEL", root.to_str().unwrap(), false, None, false, true).unwrap();
        assert!(!hits.iter().any(|e| e.rel_path == "CamelCase.rs"));
        let hits = find_files("PLAIN", root.to_str().unwrap(), false, None, false, true).unwrap();
        assert!(!hits.iter().any(|e| e.rel_path == "plain.txt"));
        let hits = find_files("plain", root.to_str().unwrap(), false, None, false, true).unwrap();
        assert!(hits.iter().any(|e| e.rel_path == "plain.txt"));

        // 正则 + 递归命中子目录；max_depth=0 只命中根目录直接子项
        let hits = find_files(r"^main\.rs$", root.to_str().unwrap(), false, None, false, false).unwrap();
        assert!(hits.iter().any(|e| e.rel_path == "src/main.rs"));
        let hits = find_files("main", root.to_str().unwrap(), false, Some(0), false, false).unwrap();
        assert!(!hits.iter().any(|e| e.rel_path.contains("main.rs")));

        // show_hidden：默认跳过 .hidden.md，开启后命中
        let hits = find_files("hidden", root.to_str().unwrap(), false, None, false, false).unwrap();
        assert!(!hits.iter().any(|e| e.rel_path == ".hidden.md"), "应跳过隐藏");
        let hits = find_files("hidden", root.to_str().unwrap(), true, None, false, false).unwrap();
        assert!(hits.iter().any(|e| e.rel_path == ".hidden.md"), "应包含隐藏");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn find_glob_mode() {
        let root = std::env::temp_dir().join("rfm_find_glob");
        let sub = root.join("src");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.rs"), "").unwrap();
        std::fs::write(root.join("b.txt"), "").unwrap();
        std::fs::write(sub.join("main.rs"), "").unwrap();

        // 通配符整名匹配：*.rs 命中 a.rs 与 src/main.rs，不命中 b.txt
        let hits = find_files("*.rs", root.to_str().unwrap(), false, None, true, false).unwrap();
        assert!(hits.iter().any(|e| e.rel_path == "a.rs"));
        assert!(hits.iter().any(|e| e.rel_path == "src/main.rs"));
        assert!(!hits.iter().any(|e| e.rel_path == "b.txt"));

        // 通配符同样受大小写开关控制：*.RS 在不区分时命中 a.rs
        let hits = find_files("*.RS", root.to_str().unwrap(), false, None, true, false).unwrap();
        assert!(hits.iter().any(|e| e.rel_path == "a.rs"));
        let hits = find_files("*.RS", root.to_str().unwrap(), false, None, true, true).unwrap();
        assert!(!hits.iter().any(|e| e.rel_path == "a.rs"));

        // 通配符里 * 等价 .*：main* 命中 src/main.rs
        let hits = find_files("main*", root.to_str().unwrap(), false, None, true, false).unwrap();
        assert!(hits.iter().any(|e| e.rel_path == "src/main.rs"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn invalid_patterns_error() {
        assert!(find_files("(unclosed", "/", false, None, false, false).is_err());
        assert!(find_files("[unclosed", "/", false, None, true, false).is_err());
    }
}
