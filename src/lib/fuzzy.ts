/** 模糊匹配（fzf 思路）纯函数。query 的字符须按顺序出现在 target 中（大小写不敏感）。
 * 返回命中位置（升序，用于高亮）与分数；不匹配返回 null。空 query 视为匹配全部。 */

export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/** 词边界分隔符 */
const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " "]);

// —— 评分常数（相对关系由 fuzzy.test.ts 锁定，非绝对值）——
const MATCH_BASE = 1; // 每命中一个字符的基础分
const FIRST_CHAR_BONUS = 6; // 命中 target 首字符
const BOUNDARY_BONUS = 10; // 命中分隔符之后 / 驼峰边界
const CONSECUTIVE_BONUS = 8; // 紧跟上一个命中
const GAP_PENALTY = -3; // 间隔起始惩罚
const GAP_EXTEND = -1; // 间隔每多一个字符的额外惩罚
const PREFIX_BONUS = 12; // 整段前缀命中
const LENGTH_PENALTY = -0.5; // 目标越长越轻微降权

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -1;
  // 贪心左到右子序列（YAGNI：不做最优子序列搜索，相对排序由测试锁定）
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let bonus = MATCH_BASE;
    if (prev >= 0 && prev === ti - 1) {
      // prev >= 0 守卫：首字符命中时 prev === -1 === ti - 1，否则会误加连续奖励
      bonus += CONSECUTIVE_BONUS;
    } else if (prev >= 0) {
      const gap = ti - prev - 1;
      bonus += GAP_PENALTY + GAP_EXTEND * (gap - 1);
    }
    if (ti === 0) {
      bonus += FIRST_CHAR_BONUS;
    } else if (SEPARATORS.has(target[ti - 1])) {
      bonus += BOUNDARY_BONUS;
    } else if (/[a-z]/.test(target[ti - 1]) && /[A-Z]/.test(target[ti])) {
      bonus += BOUNDARY_BONUS;
    }
    score += bonus;
    positions.push(ti);
    prev = ti;
    qi++;
  }
  if (qi < q.length) return null;
  // 整段前缀：首字符命中且后续完全连续
  if (positions[0] === 0) {
    let contiguous = true;
    for (let k = 1; k < positions.length; k++) {
      if (positions[k] !== positions[k - 1] + 1) {
        contiguous = false;
        break;
      }
    }
    if (contiguous) score += PREFIX_BONUS;
  }
  score += LENGTH_PENALTY * target.length;
  return { score, positions };
}

export function rank<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
): Ranked<T>[] {
  if (!query) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }
  const scored: { r: Ranked<T>; i: number }[] = [];
  items.forEach((item, i) => {
    const m = fuzzyMatch(query, toText(item));
    if (m) scored.push({ r: { item, score: m.score, positions: m.positions }, i });
  });
  // 稳定排序：分数降序，同分保持输入顺序
  scored.sort((a, b) => b.r.score - a.r.score || a.i - b.i);
  return scored.map((s) => s.r);
}
