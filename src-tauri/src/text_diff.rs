//! 文本文件行级比较（v0.19）：任意两个文件（本地 / SFTP / HTTP）的行级 diff 内核，
//! 以及供前端解析 unified diff（git diff / patch）用的文本读取。
//!
//! 轻量策略（与目录级 diff.rs 的定位互补，这里比的是**内容行**）：
//! 1. 去公共前后缀（O(n)，覆盖绝大多数真实改动）；
//! 2. 中段较小时走 Myers O(ND) 精确对齐（带编辑距离上限，防恶意/全量改写卡死）；
//! 3. 中段过大 / 编辑距离超限 → 贪心重对齐（v0.45）：失配处小窗搜索「≥3 连续相同行」的
//!    最近重同步点，大位移纯插入/纯删除单独识别——大文件散布改动（XML 数据文件的主要
//!    痛点）不再从首处差异起整段红绿；
//! 4. 重对齐预算耗尽 / 几乎无共同行 → 退化为「整块替换」（coarse，一侧全删 + 一侧全增），
//!    不保证行对齐（界面出粗略显示提示）。
//!
//! 行语义：\r\n 与 \n 归一；「结尾有无换行符」视为相同（轻量简化，git 语义会标记）。

use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 单文件文本读取上限
pub const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// 中段（去公共前后缀后）单侧行数上限：超过不进 Myers，走贪心重对齐
const MAX_MID_LINES: usize = 1500;
/// Myers 编辑距离上限：超过转贪心重对齐
const MAX_D: usize = 800;
/// 贪心重对齐：重同步要求 ≥ RESYNC_RUN 行连续相同（防重复行误锚到噪声位置）
const RESYNC_RUN: usize = 3;
/// 贪心重对齐：重同步小窗，di + dj 搜索上限（覆盖散布单行改动 / 短段替换）
const RESYNC_MAX_SUM: usize = 48;
/// 贪心重对齐：大位移窗口，整块纯插入 / 纯删除的单侧搜索上限（行）
const RESYNC_BIG_WIN: usize = 8192;
/// 贪心重对齐比较预算：耗尽后剩余整块替换（coarse），最坏耗时可控
const RESYNC_WORK_CAP: u64 = 20_000_000;
/// 中段共同行（按位置计）低于此数视为几乎整段重写，跳过重对齐直接整块替换
const RESYNC_MIN_COMMON: usize = 16;

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
    /// 行尾格式："lf" | "crlf" | "mixed" | "none"（v0.21.1 换行符差异提示用）
    pub eol: String,
}

/// 一段连续同类型的行。eq = 两侧（按忽略正则掩码后）相同；del = 左侧独有；add = 右侧独有。
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
    /// v0.46 忽略正则生效时 eq 段的右侧行原文（比较按掩码判定相同，展示保留各自原文，
    /// 典型如日志时间戳不同、正文一致）；None = 无忽略规则，前端直接复用 lines
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_lines: Option<Vec<String>>,
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
    /// 贪心重对齐预算耗尽 / 几乎无共同行，剩余整块替换（未做行级对齐）
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
    /// v0.30 实际采用的解码（UTF-8 / UTF-16LE / UTF-16BE / …），预览栏据此给提示
    pub encoding: String,
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

/// 本地文本读取结果（预览 / 比较共用）。
pub struct LocalText {
    pub text: String,
    pub lossy: bool,
    pub bytes: u64,
    /// 实际采用的解码：自动探测得到的 "UTF-8" / "UTF-16LE" / "UTF-16BE"（只读展示口另有 "GBK"），
    /// 或显式标签对应的规范名
    pub encoding: &'static str,
}

/// NOT_TEXT 错误码前缀（preview::probe_blocking 据此把二进制结果映射为 Binary 态）
pub const NOT_TEXT_ERR_PREFIX: &str = "NOT_TEXT|";
/// 疑似二进制：CODE|中文详情 契约（v0.42 码化）——probe_local_file 映射为 Binary 态回「疑似二进制」信息卡，diff 侧经 terr 剥码
const BINARY_ERR: &str = "NOT_TEXT|疑似二进制文件，不支持按文本读取";
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// 解码产物（v0.44 自动探测 / 显式编码共用）。
pub struct Decoded {
    pub text: String,
    pub lossy: bool,
    /// 实际采用的解码规范名（"UTF-8" / "UTF-16LE" / "GBK" / …）
    pub encoding: &'static str,
}

/// 自动探测遇到非 UTF-8 文本时的回退策略（v0.44）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NonUtf8 {
    /// UTF-8 有损替换：比较链路——编辑保存按界面显式编码写回，猜成 GBK 再按 UTF-8 存会静默改写文件编码
    Lossy,
    /// GBK 严格解码，不中再 UTF-8 有损替换：预览 / 查看 Diff 等只读展示口
    GbkOrLossy,
    /// GBK 严格解码，不中视为不可读：内容搜索——乱码与前 8KB 无 NUL 的二进制（实测约四分之一
    /// 的 PDF）不当文本搜，避免乱码命中
    GbkOrSkip,
}

/// 自动探测解码：UTF-16（BOM / NUL 奇偶位启发）→ 二进制（前 8KB 含 NUL）→ 去 UTF-8 BOM 后
/// 严格 UTF-8 → 非 UTF-8 按 `non_utf8` 回退。返回 None：二进制，或 GbkOrSkip 下既非 UTF-8 也非 GBK。
/// GBK 回退为单一编码取舍（同 extract.rs 文件名探测，简中存量文件最常见）：Big5 / Shift_JIS
/// 字节序列大多也是合法 GBK，会被解成错字而非报错。
pub fn decode_auto(bytes: Vec<u8>, non_utf8: NonUtf8) -> Option<Decoded> {
    if let Some(enc) = detect_utf16(&bytes) {
        let (cow, had_errors) = enc.decode_with_bom_removal(&bytes);
        return Some(Decoded {
            text: cow.into_owned(),
            lossy: had_errors,
            encoding: enc.name(),
        });
    }
    if looks_binary(&bytes) {
        return None;
    }
    decode_utf8(bytes, non_utf8)
}

/// 去 UTF-8 BOM 后严格 UTF-8 解码；非 UTF-8 按 `non_utf8` 回退（调用方已做二进制探测）。
fn decode_utf8(mut bytes: Vec<u8>, non_utf8: NonUtf8) -> Option<Decoded> {
    if bytes.starts_with(UTF8_BOM) {
        bytes.drain(..UTF8_BOM.len());
    }
    // UTF-8 快路径零拷贝（from_utf8 取回所有权）；遇首个非法字节即失败，GBK 文本在首个汉字处转回退
    let bytes = match String::from_utf8(bytes) {
        Ok(text) => {
            return Some(Decoded {
                text,
                lossy: false,
                encoding: "UTF-8",
            })
        }
        Err(e) => e.into_bytes(),
    };
    if non_utf8 != NonUtf8::Lossy {
        // 严格解码：首个非法序列即放弃，PDF 等非 GBK 字节流不会被整段解码；BOM 已处理，不再嗅探
        if let Some(cow) = encoding_rs::GBK.decode_without_bom_handling_and_without_replacement(&bytes) {
            return Some(Decoded {
                text: cow.into_owned(),
                lossy: false,
                encoding: encoding_rs::GBK.name(),
            });
        }
        if non_utf8 == NonUtf8::GbkOrSkip {
            return None;
        }
    }
    Some(Decoded {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        lossy: true,
        encoding: "UTF-8",
    })
}

/// 读取本地文件为文本（二进制 / 大小守卫）。
/// encoding 为 None 时自动探测（decode_auto，非 UTF-8 不猜旧编码）：UTF-8 BOM 去除；UTF-16 LE/BE
/// 按 BOM 识别，无 BOM 时按「NUL 几乎只落在同一奇偶位」启发识别（Windows 记事本 / PowerShell /
/// regedit 写出的 ini、reg 常为 UTF-16，v0.30 之前一律被 NUL 探测判成二进制）；其余按 UTF-8，
/// 非法字节替换为 U+FFFD 并置 lossy。"utf-8" 显式指定时只去 BOM、不嗅探 UTF-16；其他 WhatWG 标签
/// （gbk / big5 / shift_jis …）经 encoding_rs 解码，不做 BOM 嗅探（尊重用户显式选择），仅移除匹配的 BOM。
pub fn read_local_text_full(path: &Path, encoding: Option<&str>) -> Result<LocalText, String> {
    let (bytes, bytes_len) = read_text_bytes(path)?;
    let label = encoding.map(str::trim).unwrap_or("");
    let explicit_utf8 = label.eq_ignore_ascii_case("utf-8") || label.eq_ignore_ascii_case("utf8");
    let decoded = if label.is_empty() {
        decode_auto(bytes, NonUtf8::Lossy)
    } else if explicit_utf8 {
        if looks_binary(&bytes) {
            None
        } else {
            decode_utf8(bytes, NonUtf8::Lossy)
        }
    } else {
        let enc = encoding_rs::Encoding::for_label(label.as_bytes())
            .ok_or_else(|| format!("不支持的编码：{label}"))?;
        // UTF-16 文本天然含 NUL，二进制探测只对单字节/多字节编码有效
        if enc != encoding_rs::UTF_16LE && enc != encoding_rs::UTF_16BE && looks_binary(&bytes) {
            None
        } else {
            let (cow, had_errors) = enc.decode_with_bom_removal(&bytes);
            Some(Decoded {
                text: cow.into_owned(),
                lossy: had_errors,
                encoding: enc.name(),
            })
        }
    };
    local_text(decoded, bytes_len)
}

/// 只读展示口的文本读取（v0.44 预览 / 查看 Diff）：自动探测同 read_local_text_full(None)，
/// 非 UTF-8 再按 GBK 严格解码，不中仍按 UTF-8 有损显示。比较链路不走这里（见 NonUtf8::Lossy）。
pub fn read_local_text_display(path: &Path) -> Result<LocalText, String> {
    let (bytes, bytes_len) = read_text_bytes(path)?;
    local_text(decode_auto(bytes, NonUtf8::GbkOrLossy), bytes_len)
}

fn local_text(decoded: Option<Decoded>, bytes_len: u64) -> Result<LocalText, String> {
    let d = decoded.ok_or_else(|| BINARY_ERR.to_string())?;
    Ok(LocalText {
        text: d.text,
        lossy: d.lossy,
        bytes: bytes_len,
        encoding: d.encoding,
    })
}

/// 文本读取守卫（常规文件 / 大小上限）+ 整读，返回 (字节, 文件大小)。
fn read_text_bytes(path: &Path) -> Result<(Vec<u8>, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取失败：{e}"))?;
    if !meta.is_file() {
        // 目录/FIFO/socket/设备一律拒绝（v0.42 预览试探对无扩展名放开门控：命名管道读取会永久阻塞）
        return Err("NOT_FILE|路径不是常规文件（目录/管道/设备），无法按文本读取".into());
    }
    let bytes_len = meta.len();
    if bytes_len > MAX_TEXT_BYTES {
        return Err(format!(
            "文件超过 {}MB 上限（实际 {:.1}MB），不按文本读取",
            MAX_TEXT_BYTES >> 20,
            bytes_len as f64 / (1024.0 * 1024.0)
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败：{e}"))?;
    Ok((bytes, bytes_len))
}

/// 读取本地文件为文本，返回 (文本, 是否 lossy, 字节数)。比较链路沿用的精简形态。
pub fn read_local_text(path: &Path, encoding: Option<&str>) -> Result<(String, bool, u64), String> {
    read_local_text_full(path, encoding).map(|t| (t.text, t.lossy, t.bytes))
}

/// 二进制探测：前 8KB 含 NUL 视为二进制（与 git 的 heuristic 一致的轻量版）
fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8192)].contains(&0u8)
}

/// UTF-16 识别：BOM 优先；无 BOM 时要求偶数长度，且探测窗内 NUL 集中在同一奇偶位
/// （ASCII 为主的 UTF-16 文本：高字节位 ≥30% 为 0、低字节位 ≤5% 为 0；CJK 为主的无 BOM
/// UTF-16 命中不了这条，但 Windows 工具写出的 UTF-16 几乎都带 BOM）。
fn detect_utf16(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(encoding_rs::UTF_16LE);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(encoding_rs::UTF_16BE);
    }
    if bytes.len() < 4 || bytes.len() % 2 != 0 {
        return None;
    }
    let probe = &bytes[..bytes.len().min(8192)];
    let pairs = probe.len() / 2;
    let (mut zero_even, mut zero_odd) = (0usize, 0usize);
    for (i, b) in probe.iter().enumerate() {
        if *b == 0 {
            if i % 2 == 0 {
                zero_even += 1;
            } else {
                zero_odd += 1;
            }
        }
    }
    let dominant = |hi: usize, lo: usize| hi * 10 >= pairs * 3 && lo * 20 <= pairs;
    if dominant(zero_odd, zero_even) {
        return Some(encoding_rs::UTF_16LE);
    }
    if dominant(zero_even, zero_odd) {
        return Some(encoding_rs::UTF_16BE);
    }
    None
}

/// 行尾格式探测（v0.21.1 换行符差异提示）："lf" | "crlf" | "mixed" | "none"。
/// 裸 \r（经典 Mac）不参与判定，按无换行处理。
pub fn detect_eol(s: &str) -> &'static str {
    let crlf = s.matches("\r\n").count();
    let lf = s.matches('\n').count().saturating_sub(crlf);
    match (crlf, lf) {
        (0, 0) => "none",
        (0, _) => "lf",
        (_, 0) => "crlf",
        _ => "mixed",
    }
}

/// v0.34 编辑保存：行数组 → 按行尾格式拼接并编码为字节（read_local_text 的逆向）。
/// eol："crlf" 用 \r\n，其余（lf / mixed——原混合分布已不可知）用 \n；
/// 非空且 eol != "none" 时结尾补一个换行（与 split_lines 去掉结尾换行的语义对称）。
/// encoding：None / utf-8 → UTF-8（不写 BOM）；其他 WhatWG 标签经 encoding_rs 编码，
/// 不可映射字符按 HTML 数字实体替换（尽力而为，不报错）。
pub fn encode_lines(lines: &[String], eol: &str, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    let sep = if eol == "crlf" { "\r\n" } else { "\n" };
    let mut text = lines.join(sep);
    if !lines.is_empty() && eol != "none" {
        text.push_str(sep);
    }
    let label = encoding
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("utf-8") && !s.eq_ignore_ascii_case("utf8"));
    match label {
        Some(label) => {
            let enc = encoding_rs::Encoding::for_label(label.as_bytes())
                .ok_or_else(|| format!("不支持的编码：{label}"))?;
            Ok(enc.encode(&text).0.into_owned())
        }
        None => Ok(text.into_bytes()),
    }
}

/// v0.46 忽略正则：编译用户输入的掩码模式（日志时间戳 / UUID 等比较噪声）。
/// 非法模式按 CODE|中文详情 契约报错（前端 terr 剥码展示，l10n errors 包随后跟进）。
pub fn compile_ignore_patterns(patterns: &[String]) -> Result<Vec<Regex>, String> {
    patterns
        .iter()
        .map(|p| Regex::new(p).map_err(|e| format!("BAD_REGEX|忽略正则无效：{p}（{e}）")))
        .collect()
}

/// v0.46 忽略正则掩码：逐行删除匹配片段，产出「比较文本」（行数不变，展示仍用原文）。
/// 典型场景：日志行仅时间戳不同 → 掩码后完全一致，按 eq 对齐而非整段红绿。
pub fn mask_lines(lines: &[String], res: &[Regex]) -> Vec<String> {
    if res.is_empty() {
        return lines.to_vec();
    }
    lines
        .iter()
        .map(|l| {
            let mut s = l.clone();
            for re in res {
                if re.is_match(&s) {
                    s = re.replace_all(&s, "").into_owned();
                }
            }
            s
        })
        .collect()
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

/// 推入一段连续同类型行（与前一正在生长的同类型段合并；行号起点为该类型侧的首行号）。
/// right_lines：忽略正则生效时 eq 段的右侧行原文（与 lines 等长、同下标对应）。
fn seg_eq(
    segs: &mut Vec<TextSegment>,
    lines: Vec<String>,
    right_lines: Option<Vec<String>>,
    la: &mut u64,
    rb: &mut u64,
) {
    if lines.is_empty() {
        return;
    }
    let start_l = *la + 1;
    let start_r = *rb + 1;
    *la += lines.len() as u64;
    *rb += lines.len() as u64;
    match segs.last_mut() {
        Some(s) if s.kind == "eq" => {
            s.lines.extend(lines);
            if let Some(rl) = right_lines {
                s.right_lines.get_or_insert_with(Vec::new).extend(rl);
            }
        }
        _ => segs.push(TextSegment {
            kind: "eq".into(),
            left_start: Some(start_l),
            right_start: Some(start_r),
            lines,
            right_lines,
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
            right_lines: None,
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
            right_lines: None,
        }),
    }
}

/// ia[x..] 与 ib[y..] 是否有 ≥ RESYNC_RUN 行连续相同（id 相等即行内容相等；越界即否）
fn run_eq(ia: &[u64], ib: &[u64], x: usize, y: usize) -> bool {
    x + RESYNC_RUN <= ia.len()
        && y + RESYNC_RUN <= ib.len()
        && (0..RESYNC_RUN).all(|t| ia[x + t] == ib[y + t])
}

/// 小窗重同步：按 di+dj 递增找首个「两侧各偏移 (di,dj) 后 ≥ RESYNC_RUN 行连续相同」的点，
/// 返回 (di, dj)。只认重新对齐处（散布改动 / 短段替换的最近共同锚），预算按试过的
/// 候选 × RESYNC_RUN 扣减，耗尽返回 None。
fn resync_small(ia: &[u64], ib: &[u64], i: usize, j: usize, work: &mut u64) -> Option<(usize, usize)> {
    let (max_di, max_dj) = (
        (ia.len() - i).min(RESYNC_MAX_SUM),
        (ib.len() - j).min(RESYNC_MAX_SUM),
    );
    for s in 1..=RESYNC_MAX_SUM {
        let mut tried = 0usize;
        let mut hit: Option<(usize, usize)> = None;
        for di in 0..=s.min(max_di) {
            let dj = s - di;
            if dj > max_dj {
                continue;
            }
            tried += 1;
            if run_eq(ia, ib, i + di, j + dj) {
                hit = Some((di, dj));
                break;
            }
        }
        *work = work.saturating_sub(tried as u64 * RESYNC_RUN as u64);
        if hit.is_some() || *work == 0 {
            return hit;
        }
    }
    None
}

/// 大位移重同步：小窗搜不到时的兜底，识别整块纯插入（di=0，b 前进 dj 行后重新对齐）
/// 与整块纯删除（dj=0）。数千行的块级增删一次命中，未命中按预算返回 None。
fn resync_big(ia: &[u64], ib: &[u64], i: usize, j: usize, work: &mut u64) -> Option<(usize, usize)> {
    for dj in 1..=(ib.len() - j).min(RESYNC_BIG_WIN) {
        *work = work.saturating_sub(RESYNC_RUN as u64);
        if run_eq(ia, ib, i, j + dj) {
            return Some((0, dj));
        }
        if *work == 0 {
            return None;
        }
    }
    for di in 1..=(ia.len() - i).min(RESYNC_BIG_WIN) {
        *work = work.saturating_sub(RESYNC_RUN as u64);
        if run_eq(ia, ib, i + di, j) {
            return Some((di, 0));
        }
        if *work == 0 {
            return None;
        }
    }
    None
}

/// 贪心重对齐（v0.45）：Myers 超限（中段过大 / 编辑距离超限）后的次优对齐层。
/// 逐行扫描：相同走 eq；失配处先小窗找最近重同步点，再试大位移纯增删，仍未中按
/// 1:1 del+add 步进（渲染为一对红绿行）继续找后续对齐点。任一侧耗尽即纯 del/add 排空。
/// 比较预算耗尽 → 剩余整块替换并返回 false（界面照旧出 coarse 提示）。
/// eq 行由紧凑 id 相等保证内容相同，恒不误标；对齐质量次优（非最小编辑脚本）但恒有效。
fn loose_ops(ia: &[u64], ib: &[u64]) -> (Vec<Op>, bool) {
    let (n, m) = (ia.len(), ib.len());
    // 预检：两侧都有内容但共同行过少 = 几乎整段重写，逐行搜索无收益，直接整块替换
    if n > 0 && m > 0 {
        let mut seen: HashSet<u64> = HashSet::with_capacity(n);
        seen.extend(ia.iter().copied());
        if ib.iter().filter(|id| seen.contains(id)).count() < RESYNC_MIN_COMMON {
            let mut ops: Vec<Op> = Vec::with_capacity(n + m);
            ops.extend(std::iter::repeat(Op::Del).take(n));
            ops.extend(std::iter::repeat(Op::Add).take(m));
            return (ops, false);
        }
    }
    let mut ops: Vec<Op> = Vec::with_capacity(n + m);
    let mut work = RESYNC_WORK_CAP;
    let (mut i, mut j) = (0usize, 0usize);
    while i < n || j < m {
        if i < n && j < m {
            if ia[i] == ib[j] {
                ops.push(Op::Eq);
                i += 1;
                j += 1;
                continue;
            }
            // 重同步：任一命中都会推进至少一行，不成环
            let hit = resync_small(ia, ib, i, j, &mut work)
                .or_else(|| resync_big(ia, ib, i, j, &mut work));
            match hit {
                Some((di, dj)) => {
                    ops.extend(std::iter::repeat(Op::Del).take(di));
                    ops.extend(std::iter::repeat(Op::Add).take(dj));
                    i += di;
                    j += dj;
                }
                None => {
                    // 彻底失配：1:1 步进（一对红绿行），后续位置可能重新对齐
                    ops.push(Op::Del);
                    ops.push(Op::Add);
                    i += 1;
                    j += 1;
                }
            }
            if work == 0 {
                break; // 预算耗尽：剩余整块替换
            }
        } else if i < n {
            ops.push(Op::Del);
            i += 1;
        } else {
            ops.push(Op::Add);
            j += 1;
        }
    }
    let complete = i >= n && j >= m;
    if !complete {
        ops.extend(std::iter::repeat(Op::Del).take(n - i));
        ops.extend(std::iter::repeat(Op::Add).take(m - j));
    }
    (ops, complete)
}

/// 行级 diff 主入口：产出段序列与 coarse 标记。行号均为 1 基。
pub fn diff_segments(a: &[String], b: &[String]) -> (Vec<TextSegment>, bool) {
    diff_segments_cmp(a, b, a, b)
}

/// 行级 diff（忽略正则版，v0.46）：比较用 ca/cb（已按用户规则掩码），展示用 a/b（原文）。
/// 两侧数组按下标一一对应（掩码不改行数）；「相同」以掩码后文本判定，eq 段携带
/// 右侧行原文（right_lines）供双栏各自展示。行号均为 1 基。
pub fn diff_segments_cmp(
    a: &[String],
    b: &[String],
    ca: &[String],
    cb: &[String],
) -> (Vec<TextSegment>, bool) {
    debug_assert_eq!(a.len(), ca.len());
    debug_assert_eq!(b.len(), cb.len());
    let n = a.len();
    let m = b.len();
    // 掩码是否生效（比较与展示数组不同源时 eq 段需带右侧行原文）
    let masked = ca.as_ptr() != a.as_ptr() || cb.as_ptr() != b.as_ptr();
    // 1) 公共前后缀（按比较文本判定）
    let mut pre = 0usize;
    while pre < n && pre < m && ca[pre] == cb[pre] {
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < n - pre && suf < m - pre && ca[n - 1 - suf] == cb[m - 1 - suf] {
        suf += 1;
    }
    let mid_a = &ca[pre..n - suf];
    let mid_b = &cb[pre..m - suf];

    // 2) 中段对齐：行内容 → 紧凑 id（精确相等，无哈希碰撞）
    let mut ids: HashMap<String, u64> = HashMap::new();
    let mut next: u64 = 0;
    let mut to_ids = |lines: &[String]| -> Vec<u64> {
        lines
            .iter()
            .map(|l| {
                *ids.entry(l.clone()).or_insert_with(|| {
                    next += 1;
                    next
                })
            })
            .collect()
    };
    let ia = to_ids(mid_a);
    let ib = to_ids(mid_b);
    // Myers：中段不大时精确对齐；中段过大 / 编辑距离超限 → 贪心重对齐（loose_ops），
    // 其预算耗尽或几乎无共同行才整块替换（coarse）——大文件散布改动不再整段红绿
    let myers = if mid_a.len().max(mid_b.len()) <= MAX_MID_LINES {
        myers_ops(&ia, &ib, MAX_D)
    } else {
        None
    };
    let (mid_ops, coarse) = match myers {
        Some(ops) => (ops, false),
        None => {
            let (ops, complete) = loose_ops(&ia, &ib);
            (ops, !complete)
        }
    };

    // 3) 全序展开：pre 公共段 + 中段 + suf 公共段。中段按连续同类型 op 批量成段
    //    （每段一次 Vec 分配，而非每行一次——大文件相同行占绝大多数，这是主要开销）。
    //    行文本取展示数组（原文），掩码只决定 eq/del/add 的判定
    let eq_right = |s: usize, e: usize| if masked { Some(b[s..e].to_vec()) } else { None };
    let mut segs: Vec<TextSegment> = Vec::new();
    let mut la: u64 = 0;
    let mut rb: u64 = 0;
    seg_eq(
        &mut segs,
        a[..pre].to_vec(),
        eq_right(0, pre),
        &mut la,
        &mut rb,
    );
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
                let e = s + count;
                let right = eq_right(rb as usize, rb as usize + count);
                seg_eq(&mut segs, a[s..e].to_vec(), right, &mut la, &mut rb);
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
    let s = n - suf;
    seg_eq(
        &mut segs,
        a[s..n].to_vec(),
        eq_right(m - suf, m),
        &mut la,
        &mut rb,
    );
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
    fn resync_aligns_distant_changes_in_large_files() {
        // v0.45 回归（XML 报告场景）：两处差异相距 1800 行（中段 > MAX_MID_LINES），
        // 修复前从首处差异起整段 coarse 红绿（含两侧完全相同的行），现恢复行级对齐
        let base: Vec<String> = (0..2200)
            .map(|i| format!("<entry id=\"{i}\" value=\"{}\"/>", i * 7 % 100))
            .collect();
        let mut a = base.clone();
        let mut b = base.clone();
        a[99] = "<!-- marker A -->".into();
        b[99] = "<!-- marker B -->".into();
        a[1899] = "<entry id=\"0\" note=\"left\"/>".into();
        b[1899] = "<entry id=\"0\" note=\"right\"/>".into();
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["eq", "del", "add", "eq", "del", "add", "eq"]);
        assert_eq!(segment_stats(&segs), (2, 2, false));
    }

    #[test]
    fn resync_aligns_dense_scattered_changes() {
        // v0.45 回归：500 处散布单行改动（每 5 行一处），重对齐到 1:1 del/add 而非整块
        let a: Vec<String> = (0..2500).map(|i| format!("line {i}")).collect();
        let mut b = a.clone();
        for i in (0..2500).step_by(5) {
            b[i] = format!("line {i} changed");
        }
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(segment_stats(&segs), (500, 500, false));
        // 每个差异段都收敛到单行（不再有动辄上千行的整块 del/add）
        let max_block = segs
            .iter()
            .filter(|s| s.kind != "eq")
            .map(|s| s.lines.len())
            .max()
            .unwrap();
        assert_eq!(max_block, 1);
    }

    #[test]
    fn resync_pure_insertion_beyond_mid_cap() {
        // v0.45 回归：中段一次性插入 1600 行（> MAX_MID_LINES）——修复前整块替换红绿，
        // 现识别为纯插入块（单侧排空无需搜索）
        let shared: Vec<String> = (0..1200).map(|i| format!("shared {i}")).collect();
        let mut a = shared.clone();
        let mut b: Vec<String> = Vec::new();
        b.extend(shared[..600].iter().cloned());
        b.extend((0..1600).map(|i| format!("inserted {i}")));
        b.extend(shared[600..].iter().cloned());
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["eq", "add", "eq"]);
        assert_eq!(segment_stats(&segs), (1600, 0, false));
    }

    #[test]
    fn resync_big_shift_finds_distant_anchor() {
        // 大位移识别：失配处小窗搜不到，a 侧当前 3 连行在 b 侧 1600 行外重新出现
        //（前面隔着一大段纯插入）→ 命中 add×1600 而非逐行 1:1 步进
        let mut a: Vec<String> = (0..50).map(|i| format!("shared {i}")).collect();
        a.extend((0..3).map(|i| format!("left-only {i}")));
        a.extend((50..100).map(|i| format!("shared {i}")));
        let mut b: Vec<String> = (0..1600).map(|i| format!("inserted {i}")).collect();
        b.extend((0..100).map(|i| format!("shared {i}")));
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(!coarse);
        // 尾部 shared50..99 为公共后缀，末尾多一段 eq；left-only 3 行为纯删除
        assert_eq!(kinds(&segs), vec!["add", "eq", "del", "eq"]);
        assert_eq!(segment_stats(&segs), (1600, 3, false));
    }

    #[test]
    fn resync_budget_exhaustion_still_coarse() {
        // 兜底不破：共同行够多（每百行一个 X）但 3 连相同行永不存在 → 搜索全部落空，
        // 预算耗尽后剩余整块替换，coarse=true（界面粗略显示提示保留）
        let mk = |tag: &str| -> Vec<String> {
            (0..4000)
                .map(|i| {
                    if i % 100 == 0 {
                        "X".to_string()
                    } else {
                        format!("{tag}{i}")
                    }
                })
                .collect()
        };
        let a = mk("A");
        let b = mk("B");
        let (segs, coarse) = diff_segments(&a, &b);
        assert!(coarse);
        // 预算耗尽前已产出的部分仍是对齐结果（含对齐上的 X 行），非全盘无 eq
        assert!(segs.iter().any(|s| s.kind == "eq"));
    }

    #[test]
    fn ignore_regex_masks_timestamps_to_eq() {
        // v0.46：日志时间戳掩码——比较按掩码文本判定 same/eq，eq 段带右侧行原文
        let a = lines(&["2026-11-11 10:00:00.001 INFO worker started", "shared line"]);
        let b = lines(&["2026-11-11 10:00:05.789 INFO worker started", "shared line"]);
        let res = compile_ignore_patterns(&[r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?".to_string()]).unwrap();
        let ca = mask_lines(&a, &res);
        let cb = mask_lines(&b, &res);
        let (segs, coarse) = diff_segments_cmp(&a, &b, &ca, &cb);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["eq"]);
        assert_eq!(segment_stats(&segs), (0, 0, true));
        // eq 段展示保留各自原文（时间戳不同的行不再互相覆盖展示）
        assert_eq!(segs[0].lines[0], "2026-11-11 10:00:00.001 INFO worker started");
        assert_eq!(
            segs[0].right_lines.as_ref().unwrap()[0],
            "2026-11-11 10:00:05.789 INFO worker started"
        );
        // 无掩码路径同一输入恢复 1:1 差异，且不携带 right_lines
        let (segs2, _) = diff_segments(&a, &b);
        assert_eq!(kinds(&segs2), vec!["del", "add", "eq"]);
        assert!(segs2.iter().all(|s| s.right_lines.is_none()));
    }

    #[test]
    fn ignore_regex_invalid_pattern_yields_bad_regex_code() {
        let err = compile_ignore_patterns(&["(unclosed".to_string()]).unwrap_err();
        assert!(err.starts_with("BAD_REGEX|"), "{err}");
    }

    #[test]
    fn ignore_regex_masked_diff_keeps_original_text_in_del_add() {
        // 掩码只影响判定：真差异行（正文不同）的 del/add 仍携带原文
        let a = lines(&["2026-11-11 10:00:00 INFO start", "do A", "2026-11-11 10:00:01 INFO end"]);
        let b = lines(&["2026-11-11 10:00:09 INFO start", "do B", "2026-11-11 10:00:11 INFO end"]);
        let res = compile_ignore_patterns(&[r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}".to_string()]).unwrap();
        let ca = mask_lines(&a, &res);
        let cb = mask_lines(&b, &res);
        let (segs, coarse) = diff_segments_cmp(&a, &b, &ca, &cb);
        assert!(!coarse);
        assert_eq!(kinds(&segs), vec!["eq", "del", "add", "eq"]);
        assert_eq!(segs[1].lines, lines(&["do A"]));
        assert_eq!(segs[2].lines, lines(&["do B"]));
        assert_eq!(segs[0].right_lines.as_ref().unwrap()[0], "2026-11-11 10:00:09 INFO start");
        assert_eq!(segs[3].right_lines.as_ref().unwrap()[0], "2026-11-11 10:00:11 INFO end");
    }

    #[test]
    fn read_local_text_guards() {
        let dir = std::env::temp_dir().join("r-dir-text-diff-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.txt");
        std::fs::write(&f, b"hello\nworld\n").unwrap();
        let (text, lossy, bytes) = read_local_text(&f, None).unwrap();
        assert_eq!(text, "hello\nworld\n");
        assert!(!lossy);
        assert_eq!(bytes, 12);
        // 二进制
        let fb = dir.join("b.bin");
        std::fs::write(&fb, [0x68, 0x00, 0x69]).unwrap();
        assert!(read_local_text(&fb, None).is_err());
        // 目录
        assert!(read_local_text(&dir, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_text_gbk_decoding() {
        let dir = std::env::temp_dir().join("r-dir-text-diff-enc-test");
        std::fs::create_dir_all(&dir).unwrap();
        // "你好\n" 的 GBK 编码（无 BOM）
        let f = dir.join("g.txt");
        std::fs::write(&f, [0xC4, 0xE3, 0xBA, 0xC3, 0x0A]).unwrap();
        // 默认 UTF-8 解码 → lossy 乱码
        let (text, lossy, _) = read_local_text(&f, None).unwrap();
        assert!(lossy);
        assert_ne!(text, "你好\n");
        // 显式 GBK → 正常解码
        let (text, lossy, _) = read_local_text(&f, Some("gbk")).unwrap();
        assert!(!lossy);
        assert_eq!(text, "你好\n");
        // 不支持的编码标签 → 报错
        assert!(read_local_text(&f, Some("no-such-encoding")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decode_auto_non_utf8_strategies() {
        // "你好\n" 的 GBK 编码
        let gbk = vec![0xC4, 0xE3, 0xBA, 0xC3, 0x0A];
        // 比较链路：不猜旧编码，UTF-8 有损
        let d = decode_auto(gbk.clone(), NonUtf8::Lossy).unwrap();
        assert!(d.lossy);
        assert_eq!(d.encoding, "UTF-8");
        // 只读展示 / 内容搜索：GBK 严格解码
        for mode in [NonUtf8::GbkOrLossy, NonUtf8::GbkOrSkip] {
            let d = decode_auto(gbk.clone(), mode).unwrap();
            assert_eq!(d.text, "你好\n");
            assert!(!d.lossy);
            assert_eq!(d.encoding, "GBK");
        }
        // 既非 UTF-8 也非 GBK（CP1252 的 é 后接空格不是合法 GBK 尾字节）：展示口有损、搜索放弃
        let latin1 = b"caf\xE9 hello\n".to_vec();
        let d = decode_auto(latin1.clone(), NonUtf8::GbkOrLossy).unwrap();
        assert!(d.lossy);
        assert_eq!(d.encoding, "UTF-8");
        assert!(d.text.ends_with(" hello\n"));
        assert!(decode_auto(latin1, NonUtf8::GbkOrSkip).is_none());
        // 合法 UTF-8 不走回退；BOM 去除
        let d = decode_auto(b"\xEF\xBB\xBF\xE4\xB8\xAD\n".to_vec(), NonUtf8::GbkOrSkip).unwrap();
        assert_eq!(d.text, "中\n");
        assert_eq!(d.encoding, "UTF-8");
        // 二进制恒为 None
        assert!(decode_auto(vec![0x68, 0x00, 0x69], NonUtf8::GbkOrLossy).is_none());
    }

    #[test]
    fn read_local_text_display_gbk_fallback() {
        let dir = std::env::temp_dir().join("r-dir-text-diff-display-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("g.txt");
        std::fs::write(&f, [0xC4, 0xE3, 0xBA, 0xC3, 0x0A]).unwrap();
        let t = read_local_text_display(&f).unwrap();
        assert_eq!(t.text, "你好\n");
        assert!(!t.lossy);
        assert_eq!(t.encoding, "GBK");
        assert_eq!(t.bytes, 5);
        // 比较链路（None）保持 UTF-8 有损：猜成 GBK 后编辑再按 UTF-8 存会静默改写文件编码
        let t = read_local_text_full(&f, None).unwrap();
        assert!(t.lossy);
        assert_eq!(t.encoding, "UTF-8");
        // 守卫与二进制判定同 read_local_text_full
        assert!(read_local_text_display(&dir).err().unwrap().starts_with("NOT_FILE|"));
        let fb = dir.join("b.bin");
        std::fs::write(&fb, [0x68, 0x00, 0x69]).unwrap();
        assert!(read_local_text_display(&fb).err().unwrap().starts_with("NOT_TEXT|"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_text_utf16_autodetect() {
        let dir = std::env::temp_dir().join("r-dir-text-diff-utf16-test");
        std::fs::create_dir_all(&dir).unwrap();
        // UTF-16LE + BOM（Windows 记事本 / regedit 导出的典型形态）：此前被 NUL 探测判成二进制
        let mut le = vec![0xFF, 0xFE];
        for u in "[app]\r\nname=你好\r\n".encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        let f = dir.join("le.ini");
        std::fs::write(&f, &le).unwrap();
        let t = read_local_text_full(&f, None).unwrap();
        assert_eq!(t.text, "[app]\r\nname=你好\r\n");
        assert!(!t.lossy);
        assert_eq!(t.encoding, "UTF-16LE");
        // UTF-16BE + BOM
        let mut be = vec![0xFE, 0xFF];
        for u in "key=value\n".encode_utf16() {
            be.extend_from_slice(&u.to_be_bytes());
        }
        let f = dir.join("be.txt");
        std::fs::write(&f, &be).unwrap();
        let t = read_local_text_full(&f, None).unwrap();
        assert_eq!(t.text, "key=value\n");
        assert_eq!(t.encoding, "UTF-16BE");
        // 无 BOM 的 ASCII 为主 UTF-16LE：按 NUL 奇偶位分布识别
        let mut nobom = Vec::new();
        for u in "[section]\r\nkey=value\r\n".encode_utf16() {
            nobom.extend_from_slice(&u.to_le_bytes());
        }
        let f = dir.join("nobom.ini");
        std::fs::write(&f, &nobom).unwrap();
        let t = read_local_text_full(&f, None).unwrap();
        assert_eq!(t.text, "[section]\r\nkey=value\r\n");
        assert_eq!(t.encoding, "UTF-16LE");
        // 显式 utf-16le 标签：不再被 NUL 探测拦下
        let (text, lossy, _) = read_local_text(&f, Some("utf-16le")).unwrap();
        assert_eq!(text, "[section]\r\nkey=value\r\n");
        assert!(!lossy);
        // 真二进制（PNG 头：NUL 散布在奇偶位、占比低）仍判二进制
        let f = dir.join("p.png");
        std::fs::write(
            &f,
            [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52],
        )
        .unwrap();
        assert!(read_local_text(&f, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_text_strips_utf8_bom() {
        let dir = std::env::temp_dir().join("r-dir-text-diff-bom-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("bom.txt");
        std::fs::write(&f, [0xEF, 0xBB, 0xBF, b'a', b'b', b'\n']).unwrap();
        let t = read_local_text_full(&f, None).unwrap();
        assert_eq!(t.text, "ab\n");
        assert!(!t.lossy);
        assert_eq!(t.encoding, "UTF-8");
        // 显式 utf-8 同样去 BOM
        let (text, _, _) = read_local_text(&f, Some("utf-8")).unwrap();
        assert_eq!(text, "ab\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_text_rejects_non_regular_files() {
        let dir = std::env::temp_dir().join("r-dir-text-diff-nonregular-test");
        std::fs::create_dir_all(&dir).unwrap();
        // 目录：NOT_FILE 码（v0.42 起目录/FIFO/socket/设备共用同一守卫）
        let err = match read_local_text_full(&dir, None) {
            Err(e) => e,
            Ok(_) => panic!("目录应被拒绝"),
        };
        assert!(err.starts_with("NOT_FILE|"), "{err}");
        // 无扩展名命名管道：试探门控放开后的新风险面——拒绝而非永久阻塞读取
        #[cfg(unix)]
        {
            let fifo = dir.join("namedpipe");
            let st = std::process::Command::new("mkfifo").arg(&fifo).status().unwrap();
            assert!(st.success());
            let err = match read_local_text_full(&fifo, None) {
                Err(e) => e,
                Ok(_) => panic!("FIFO 应被拒绝"),
            };
            assert!(err.starts_with("NOT_FILE|"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn binary_content_yields_not_text_code() {
        // v0.42 试探门控的目标场景：无扩展名二进制产出 NOT_TEXT 码（CODE|中文详情 契约）
        let dir = std::env::temp_dir().join("r-dir-text-diff-nottext-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("payload");
        let png_head: [u8; 16] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
            0x52,
        ];
        std::fs::write(&f, png_head).unwrap();
        let err = match read_local_text_full(&f, None) {
            Err(e) => e,
            Ok(_) => panic!("二进制内容应产出 NOT_TEXT 码"),
        };
        assert!(err.starts_with("NOT_TEXT|"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_eol_variants() {
        assert_eq!(detect_eol("a\nb\n"), "lf");
        assert_eq!(detect_eol("a\r\nb\r\n"), "crlf");
        assert_eq!(detect_eol("a\nb\r\n"), "mixed");
        assert_eq!(detect_eol("abc"), "none");
        assert_eq!(detect_eol(""), "none");
    }

    #[test]
    fn encode_lines_roundtrips_split_lines() {
        // 与 split_lines 对称：lf / crlf 结尾补换行，none 不补，空数组得空文件
        let l = lines(&["a", "b"]);
        assert_eq!(encode_lines(&l, "lf", None).unwrap(), b"a\nb\n");
        assert_eq!(encode_lines(&l, "crlf", None).unwrap(), b"a\r\nb\r\n");
        assert_eq!(encode_lines(&l, "mixed", None).unwrap(), b"a\nb\n");
        assert_eq!(encode_lines(&lines(&["only"]), "none", None).unwrap(), b"only");
        assert_eq!(encode_lines(&[], "lf", None).unwrap(), b"");
        // 往返：split_lines(encode) == 原行
        let bytes = encode_lines(&l, "crlf", Some("utf-8")).unwrap();
        assert_eq!(split_lines(std::str::from_utf8(&bytes).unwrap()), l);
    }

    #[test]
    fn encode_lines_gbk_and_unknown_label() {
        let bytes = encode_lines(&lines(&["你好"]), "lf", Some("gbk")).unwrap();
        assert_eq!(bytes, [0xC4, 0xE3, 0xBA, 0xC3, 0x0A]);
        assert!(encode_lines(&lines(&["x"]), "lf", Some("no-such-encoding")).is_err());
    }
}
