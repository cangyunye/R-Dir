//! 字符级 2-gram 倒排索引——子串查询的核心数据结构。
//!
//! 为什么选 2-gram（按字符切，不按字节）：
//! - 中文文件名一个字 UTF-8 占 3 字节，按字节切会产生乱码 gram（常见错误实现）；
//!   按字符切则「下载」「合同」这类 2 字查询 = 恰好 2 个 gram 的交集，全覆盖；
//! - 3-gram 无法回答 2 字查询（只能退化全表扫），2-gram 查询最短 2 字命中索引；
//! - 1 字查询走全量名字扫描回退（见 engine，~几十 ms，罕见路径，不值得为它
//!   维护一套 1-gram 把倒排内存翻倍）。
//!
//! posting 列表在建库时按 id 升序追加（两阶段：并行 walk 先收齐、按序赋 id 后
//! 统一建 gram），天然有序——交集用双指针，零哈希、cache 友好。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// gram 键：一对相邻字符（均已小写归一）
pub type GramKey = (char, char);

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct GramIndex {
    pub map: HashMap<GramKey, Vec<u32>>,
}

/// 小写归一（逐字符 `to_lowercase`，正确处理 Ö 等多字节展开；ASCII 是快路径）
pub fn lower_chars(s: &str) -> impl Iterator<Item = char> + '_ {
    s.chars().flat_map(|c| c.to_lowercase())
}

impl GramIndex {
    /// 把 name 的全部相邻 2-gram 挂到 id 上（同一 gram 的 posting 保持追加升序）。
    pub fn add(&mut self, id: u32, name: &str) {
        let mut prev: Option<char> = None;
        for ch in lower_chars(name) {
            if let Some(p) = prev {
                self.map.entry((p, ch)).or_default().push(id);
            }
            prev = Some(ch);
        }
    }

    /// 查询词的 gram 交集（候选 id，升序）。
    /// - 返回 `None`：查询词不足 2 字符，无 gram 可用——调用方走全量扫描回退；
    /// - 返回 `Some(空)`：存在 gram 但索引里没有——必无结果，可直接返回；
    /// - `cap`：候选截断上限。截断只会丢候选（精度由调用方的原名校验兜底），
    ///   不会引入假结果；预筛场景传 `usize::MAX` 即不截断（多段交集要求完整）。
    pub fn candidates_cap(&self, query: &str, cap: usize) -> Option<Vec<u32>> {
        let chars: Vec<char> = lower_chars(query).collect();
        if chars.len() < 2 {
            return None;
        }
        let mut lists: Vec<&Vec<u32>> = Vec::with_capacity(chars.len() - 1);
        for w in chars.windows(2) {
            match self.map.get(&(w[0], w[1])) {
                Some(l) => lists.push(l),
                // 索引中不存在的 gram ⇒ 任何名字都不含它 ⇒ 必无结果
                // （此前 filter_map 跳过会返回超集，白白多验一轮；直接短路）
                None => return Some(Vec::new()),
            }
        }
        // 从最短的 posting 开始交，尽早收敛/触发截断
        lists.sort_by_key(|l| l.len());
        let mut acc: Vec<u32> = lists[0].clone();
        for l in &lists[1..] {
            if acc.len() > cap {
                acc.truncate(cap);
                return Some(acc);
            }
            acc = intersect(&acc, l);
            if acc.is_empty() {
                break;
            }
        }
        if acc.len() > cap {
            acc.truncate(cap);
        }
        Some(acc)
    }
}

/// 升序有序列表双指针交集（O(a+b)，无哈希、无分配放大、cache 友好）。
/// 供引擎做多段字面量预筛的段间交集（crate 内可见）。
pub(crate) fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let (mut i, mut j) = (0usize, 0usize);
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_query_basic() {
        let mut g = GramIndex::default();
        g.add(1, "readme.md");
        g.add(2, "读取我.md");
        g.add(3, "report.pdf");
        // 2 字查询
        assert!(g.candidates_cap("ea", 10_000).unwrap().contains(&1));
        assert!(g.candidates_cap(".md", 10_000).unwrap().contains(&1));
        assert!(g.candidates_cap("读取", 10_000).unwrap().contains(&2));
        assert!(g.candidates_cap("我.m", 10_000).unwrap().contains(&2));
        // 大小写归一
        assert!(g.candidates_cap("EA", 10_000).unwrap().contains(&1));
        // 无命中
        assert!(g.candidates_cap("zz", 10_000).unwrap().is_empty());
        // 单字 → None（回退信号）
        assert!(g.candidates_cap("r", 10_000).is_none());
    }

    /// gram 是近似索引：「ea」「ad」两个 gram 都在但「ead」不连续的名字必须能被
    /// 调用方的原名校验拦下（这里验证候选确实包含它）
    #[test]
    fn intersection_is_superset_of_true_matches() {
        let mut g = GramIndex::default();
        // "eabnad"：含 (e,a) 与 (a,d) 两个 gram，但不含连续子串 "ead"
        g.add(7, "eabnad");
        assert!(!"eabnad".contains("ead"));
        let c = g.candidates_cap("ead", 10_000).unwrap();
        assert!(c.contains(&7));
    }

    #[test]
    fn candidates_cap_truncates() {
        let mut g = GramIndex::default();
        for i in 0..100u32 {
            g.add(i, "common.txt");
        }
        let c = g.candidates_cap("common", 10).unwrap();
        assert_eq!(c.len(), 10);
    }
}
