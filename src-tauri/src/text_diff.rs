//! 文本文件行级比较（v0.19）：任意两个文件（本地 / SFTP / HTTP）的行级 diff 内核，
//! 以及供前端解析 unified diff（git diff / patch）用的文本读取。
//!
//! 轻量策略（与目录级 diff.rs 的定位互补，这里比的是**内容行**）：
//! 1. 去公共前后缀（O(n)，覆盖绝大多数真实改动）；
//! 2. 中段较小时走 Myers O(ND) 精确对齐（带编辑距离上限，防恶意/全量改写卡死）；
//! 3. 超限退化为「整块替换」（coarse，一侧全删 + 一侧全增），不保证行对齐。
//!
//! 行语义：\r\n 与 \n 归一；「结尾有无换行符」视为相同（轻量简化，git 语义会标记）。

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// 单文件文本读取上限
pub const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// 中段（去公共前后缀后）单侧行数上限：超过直接粗略对齐，不进 Myers
const MAX_MID_LINES: usize = 1500;
/// Myers 编辑距离上限：超过退化为整块替换
const MAX_D: usize = 800;

/// 参与比较的一侧文件信息。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSide {
    /// 调用方传入的原始路径（可能是 sftp:// 或 http(s)://）
    pub path: String,
    /// 实际读取的本地路径（远程侧为临时文件，diff 完成后即删）
    pub local_path: String,
    pub is_temp: bool,
    /// 含非 UTF-8 字节，已按 lossy 转换（乱码占位符 U+FFFD）
    pub lossy: bool,
    pub bytes: u64,
    pub lines: usize,
}

/// 一段连续同类型的行。eq = 两侧相同；del = 左侧独有；add = 右侧独有。
/// eq 段只带起点行号（渲染器按序展开）；del/add 段带行文本。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSegment {
    /// "eq" | "del" | "add"
    pub kind: String,
    /// 左侧行号起点（1 基）；add 段为 None
    pub left_start: Option<u64>,
    /// 右侧行号起点（1 基）；del 段为 None
    pub right_start: Option<u64>,
    pub lines: Vec<String>,
}

/// 文本比较结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDiffOutcome {
    pub left: TextSide,
    pub right: TextSide,
    pub segments: Vec<TextSegment>,
    pub additions: usize,
    pub deletions: usize,
    /// 完全相同
    pub same: bool,
    /// 中段过大 / 编辑距离超限，退化为整块替换（未做行级对齐）
    pub coarse: bool,
}

/// 读取文本文件的结果（右键 .patch/.diff「查看 Diff」用）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileContent {
    pub path: String,
    pub local_path: String,
    pub is_temp: bool,
    pub lossy: bool,
    pub text: String,
}

/// 按行拆分：\r\n 归一为 \n 的内容；结尾有无换行符视为相同。
pub fn split_lines(s: &str) -> Vec<String> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = s
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    if s.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// 读取本地文件为文本（二进制 / 大小守卫）。返回 (文本, 是否 lossy, 字节数)。
pub fn read_local_text(path: &Path) -> Result<(String, bool, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取失败：{e}"))?;
    if meta.is_dir() {
        return Err("路径是目录，无法按文本比较".into());
    }
    let bytes_len = meta.len();
    if bytes_len > MAX_TEXT_BYTES {
        return Err(format!(
            "文件超过 {}MB 上限（实际 {:.1}MB），不做文本比较",
            MAX_TEXT_BYTES >> 20,
            bytes_len as f64 / (1024.0 * 1024.0)
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败：{e}"))?;
    // 二进制探测：前 8KB 含 NUL 视为二进制（与 git 的 heuristic 一致的轻量版）
    let probe_len = bytes.len().min(8192);
    if bytes[..probe_len].contains(&0u8) {
        return Err("疑似二进制文件，不支持文本比较".into());
    }
    // UTF-8 快路径零拷贝（from_utf8 取回所有权）；仅非法字节才 lossy 复制一份
    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, false, bytes_len)),
        Err(e) => Ok((String::from_utf8_lossy(e.as_bytes()).to_string(), true, bytes_len)),
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Op {
    Eq,
    Del,
    Add,
}

/// Myers O(ND) 精确对齐。返回 None = 编辑距离超过 max_d（调用方退化处理）。
fn myers_ops(a: &[u64], b: &[u64], max_d: usize) -> Option<Vec<Op>> {
    let n = a.len();
    let m = b.len();
    if n == 0 && m == 0 {
        return Some(Vec::new());
    }
    let max = n + m;
    let offset = max as isize;
    let mut v = vec![0isize; 2 * max + 1];
    // trace[d] = 第 d 轮开始前（即 d-1 轮结束时）的 V 快照；只到解出为止，典型几轮
    let mut trace: Vec<Vec<isize>> = Vec::with_capacity(32);
    for d in 0..=max {
        if d > max_d {
            return None;
        }
        trace.push(v.clone());
        let di = d as isize;
        let mut k = -di;
        while k <= di {
            // 下移（add）还是右移（del）：与 Myers 论文一致；k==±d 时只读已计算的一侧
            let mut x;
            if k == -di || (k != di && v[(k - 1 + offset) as usize] < v[(k + 1 + offset) as usize])
            {
                x = v[(k + 1 + offset) as usize];
            } else {
                x = v[(k - 1 + offset) as usize] + 1;
            }
            let mut y = x - k;
            while (x as usize) < n && (y as usize) < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(k + offset) as usize] = x;
            if (x as usize) >= n && (y as usize) >= m {
                return Some(backtrack(&trace, n as isize, m as isize, offset));
            }
            k += 2;
        }
    }
    None
}

/// 沿 trace 反向回放，产出正向 op 序列。
fn backtrack(trace: &[Vec<isize>], n: isize, m: isize, offset: isize) -> Vec<Op> {
    let mut x = n;
    let mut y = m;
    let mut ops: Vec<Op> = Vec::new();
    for (d, v) in trace.iter().enumerate().rev() {
        let di = d as isize;
        let k = x - y;
        let prev_k =
            if k == -di || (k != di && v[(k - 1 + offset) as usize] < v[(k + 1 + offset) as usize]) {
                k + 1
            } else {
                k - 1
            };
        let prev_x = v[(prev_k + offset) as usize];
        let prev_y = prev_x - prev_k;
        // 先回放对角线（相同行）
        while x > prev_x && y > prev_y {
            ops.push(Op::Eq);
            x -= 1;
            y -= 1;
        }
        if di > 0 {
            // 编辑步：x 未动 = 本轮从 k+1 下移来（add）；否则右移来（del）
            if x == prev_x {
                ops.push(Op::Add);
            } else {
                ops.push(Op::Del);
            }
        }
        x = prev_x;
        y = prev_y;
    }
    ops.reverse();
    ops
}

/// 推入一段连续同类型行（与前一正在生长的同类型段合并；行号起点为该类型侧的首行号）
fn seg_eq(segs: &mut Vec<TextSegment>, lines: Vec<String>, la: &mut u64, rb: &mut u64) {
    if lines.is_empty() {
        return;
    }
    let start_l = *la + 1;
    let start_r = *rb + 1;
    *la += lines.len() as u64;
    *rb += lines.len() as u64;
    match segs.last_mut() {
        Some(s) if s.kind == "eq" => s.lines.extend(lines),
        _ => segs.push(TextSegment {
            kind: "eq".into(),
            left_start: Some(start_l),
            right_start: Some(start_r),
            lines,
        }),
    }
}

fn seg_del_run(segs: &mut Vec<TextSegment>, lines: Vec<String>, la: &mut u64) {
    if lines.is_empty() {
        return;
    }
    let start = *la + 1;
    *la += lines.len() as u64;
    match segs.last_mut() {
        Some(s) if s.kind == "del" => s.lines.extend(lines),
        _ => segs.push(TextSegment {
            kind: "del".into(),
            left_start: Some(start),
            right_start: None,
            lines,
        }),
    }
}

fn seg_add_run(segs: &mut Vec<TextSegment>, lines: Vec<String>, rb: &mut u64) {
    if lines.is_empty() {
        return;
    }
    let start = *rb + 1;
    *rb += lines.len() as u64;
    match segs.last_mut() {
        Some(s) if s.kind == "add" => s.lines.extend(lines),
        _ => segs.push(TextSegment {
            kind: "add".into(),
            left_start: None,
            right_start: Some(start),
            lines,
        }),
    }
}

/// 行级 diff 主入口：产出段序列与 coarse 标记。行号均为 1 基。
pub fn diff_segments(a: &[String], b: &[String]) -> (Vec<TextSegment>, bool) {
    let n = a.len();
    let m = b.len();
    // 1) 公共前后缀
    let mut pre = 0usize;
    while pre < n && pre < m && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < n - pre && suf < m - pre && a[n - 1 - suf] == b[m - 1 - suf] {
        suf += 1;
    }
    let mid_a = &a[pre..n - suf];
    let mid_b = &b[pre..m - suf];

    // 2) 中段对齐：行内容 → 紧凑 id（精确相等，无哈希碰撞）
    let ops: Option<Vec<Op>> = if mid_a.len().max(mid_b.len()) > MAX_MID_LINES {
        None
    } else {
        let mut ids: HashMap<String, u64> = HashMap::new();
        let mut next: u64 = 0;
        let ia: Vec<u64> = mid_a
            .iter()
            .map(|l| *ids.entry(l.clone()).or_insert_with(|| {
                next += 1;
                next
            }))
            .collect();
        let ib: Vec<u64> = mid_b
            .iter()
            .map(|l| *ids.entry(l.clone()).or_insert_with(|| {
                next += 1;
                next
            }))
            .collect();
        myers_ops(&ia, &ib, MAX_D)
    };
    let coarse = ops.is_none();
    let mid_ops = ops.unwrap_or_else(|| {
        let mut v: Vec<Op> = mid_a.iter().map(|_| Op::Del).collect();
        v.extend(mid_b.iter().map(|_| Op::Add));
        v
    });

    // 3) 全序展开：pre 公共段 + 中段 + suf 公共段。中段按连续同类型 op 批量成段
    //    （每段一次 Vec 分配，而非每行一次——大文件相同行占绝大多数，这是主要开销）
    let mut segs: Vec<TextSegment> = Vec::new();
    let mut la: u64 = 0;
    let mut rb: u64 = 0;
    seg_eq(&mut segs, a[..pre].to_vec(), &mut la, &mut rb);
    let mut i = 0usize;
    while i < mid_ops.len() {
        let op = mid_ops[i];
        let start = i;
        while i < mid_ops.len() && mid_ops[i] == op {
            i += 1;
        }
        let count = i - start;
        match op {
            Op::Eq => {
                let s = la as usize;
                seg_eq(&mut segs, a[s..s + count].to_vec(), &mut la, &mut rb);
            }
            Op::Del => {
                let lines = a[la as usize..la as usize + count].to_vec();
                seg_del_run(&mut segs, lines, &mut la);
            }
            Op::Add => {
                let lines = b[rb as usize..rb as usize + count].to_vec();
                seg_add_run(&mut segs, lines, &mut rb);
            }
        }
    }
    seg_eq(&mut segs, a[n - suf..n].to_vec(), &mut la, &mut rb);
    (segs, coarse)
}

/// 统计辅助：加/删行数与是否完全相同。
pub fn segment_stats(segs: &[TextSegment]) -> (usize, usize, bool) {
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for s in segs {
        match s.kind.as_str() {
            "add" => additions += s.lines.len(),
            "del" => deletions += s.lines.len(),
            _ => {}
        }
    }
    (additions, deletions, additions + deletions == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn kinds(segs: &[TextSegment]) -> Vec<&str> {
        segs.iter().map(|s| s.kind.as_str()).collect()
    }

    #[test]
    fn split_lines_normalizes_crlf_and_trailing_newline() {
        assert_eq!(split_lines("a\r\nb\r\n"), lines(&["a", "b"]));
        assert_eq!(split_lines("a\nb"), lines(&["a", "b"]));
        assert_eq!(split_lines(""), Vec::<String>::new());
        // 单个换行 = 一行空行（与 wc -l 语义一致）
        assert_eq!(split_lines("\n"), lines(&[""]));
    }

    #[test]
    fn identical_files_all_eq() {
        let a = lines(&["x", "y", "z"]);
        let (segs, coarse) = diff_segments(&a, &a);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["eq"]);
        assert_eq!(segs[0].left_start, Some(1));
        assert_eq!(segment_stats(&segs), (0, 0, true));
    }

    #[test]
    fn pure_insert_middle() {
        let a = lines(&["1", "2", "3"]);
        let b = lines(&["1", "x", "y", "2", "3"]);
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["eq", "add", "eq"]);
        assert_eq!(segs[1].right_start, Some(2));
        assert_eq!(segs[1].lines, lines(&["x", "y"]));
        assert_eq!(segment_stats(&segs), (2, 0, false));
    }

    #[test]
    fn pure_delete_head_and_tail() {
        let a = lines(&["h1", "h2", "keep", "t1"]);
        let b = lines(&["keep"]);
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["del", "eq", "del"]);
        assert_eq!(segs[0].lines, lines(&["h1", "h2"]));
        assert_eq!(segs[2].lines, lines(&["t1"]));
        assert_eq!(segment_stats(&segs), (0, 3, false));
    }

    #[test]
    fn replace_middle_aligns_lines() {
        let a = lines(&["a", "old1", "old2", "b"]);
        let b = lines(&["a", "new1", "new2", "b"]);
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["eq", "del", "add", "eq"]);
        assert_eq!(segs[1].lines, lines(&["old1", "old2"]));
        assert_eq!(segs[2].lines, lines(&["new1", "new2"]));
    }

    #[test]
    fn moved_line_pairs_del_add() {
        // 经典场景：一行移动 → 最小编辑脚本 = 1 del + 1 add
        //（移动行两侧的公共行可能把 del/add 段隔开，属正确 LCS 行为）
        let a = lines(&["p", "q", "r", "s"]);
        let b = lines(&["p", "s", "q", "r"]);
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(segment_stats(&segs), (1, 1, false));
        let dels: Vec<&TextSegment> = segs.iter().filter(|s| s.kind == "del").collect();
        let adds: Vec<&TextSegment> = segs.iter().filter(|s| s.kind == "add").collect();
        assert_eq!(dels.len(), 1);
        assert_eq!(adds.len(), 1);
        assert_eq!(dels[0].lines, lines(&["s"]));
        assert_eq!(adds[0].lines, lines(&["s"]));
    }

    #[test]
    fn empty_vs_content() {
        let a = Vec::new();
        let b = lines(&["x", "y"]);
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["add"]);
        assert_eq!(segs[0].right_start, Some(1));
    }

    #[test]
    fn oversized_middle_falls_back_coarse() {
        let a: Vec<String> = (0..1600).map(|i| format!("L{i}")).collect();
        let b: Vec<String> = (0..1600).map(|i| format!("R{i}")).collect();
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(coarse);
        assert_eq!(kinds(&segs), vec!["del", "add"]);
        assert_eq!(segs[0].lines.len(), 1600);
    }

    #[test]
    fn large_edit_distance_falls_back_coarse() {
        // 中段不超过行数上限，但完全不同 → 编辑距离超限 → 粗略对齐
        let a: Vec<String> = (0..900).map(|i| format!("A{i}")).collect();
        let b: Vec<String> = (0..900).map(|i| format!("B{i}")).collect();
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(coarse);
        assert_eq!(kinds(&segs), vec!["del", "add"]);
    }

    #[test]
    fn read_local_text_guards() {
        let dir = std::env::temp_dir().join("r-dir-text-diff-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.txt");
        std::fs::write(&f, b"hello\nworld\n").unwrap();
        let (text, lossy, bytes) = read_local_text(&f).unwrap();
        assert_eq!(text, "hello\nworld\n");
        assert!(!lossy);
        assert_eq!(bytes, 12);
        // 二进制
        let fb = dir.join("b.bin");
        std::fs::write(&fb, [0x68, 0x00, 0x69]).unwrap();
        assert!(read_local_text(&fb).is_err());
        // 目录
        assert!(read_local_text(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
