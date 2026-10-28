/**
 * 文本比较共享模型（v0.19）。
 *
 * 两个功能汇聚到同一套行模型、共用 TextDiffDialog 渲染：
 * - 后端 `diff_text_files` 产出的段序列（TextSegment）→ 展开为成对行；
 * - unified diff（git diff / .patch 文件 / 粘贴导入）解析 → 同样的成对行。
 *
 * 成对规则：连续 del 段与紧随的 add 段按顺序 zip（第 i 行删 ↔ 第 i 行增），
 * 多出的一侧以纯删/纯增行呈现——这是轻量 side-by-side，不做行内词级对齐。
 */
import type { TextSegment } from "./types";

export type { TextSegment } from "./types";

/** 渲染用的一行：left/right 各有行号+文本；null = 该侧无内容 */
export interface DiffRow {
  kind: "eq" | "del" | "add" | "pair";
  left: { no: number; text: string } | null;
  right: { no: number; text: string } | null;
}

/** 展示项：真实行（带 rows 数组下标，编辑/补丁定位用）/ 折叠的相同行间隙（点击展开，from = 折叠起点下标） */
export type DisplayItem =
  | { type: "row"; row: DiffRow; index: number }
  | { type: "gap"; id: string; count: number; from: number };

/** unified diff 解析出的一个文件段落 */
export interface PatchSection {
  leftName: string;
  rightName: string;
  rows: DiffRow[];
}

function delRow(no: number, text: string): DiffRow {
  return { kind: "del", left: { no, text }, right: null };
}
function addRow(no: number, text: string): DiffRow {
  return { kind: "add", left: null, right: { no, text } };
}

/** 段序列 → 成对行（del/add 相邻即 zip） */
export function rowsFromSegments(segs: TextSegment[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let pending: { no: number; text: string }[] = [];
  const flush = (adds?: { no: number; text: string }[]) => {
    if (adds) {
      const n = Math.max(pending.length, adds.length);
      for (let i = 0; i < n; i++) {
        const l = pending[i];
        const r = adds[i];
        if (l && r) rows.push({ kind: "pair", left: l, right: r });
        else if (l) rows.push(delRow(l.no, l.text));
        else rows.push(addRow(r!.no, r!.text));
      }
    } else {
      for (const l of pending) rows.push(delRow(l.no, l.text));
    }
    pending = [];
  };
  for (const seg of segs) {
    if (seg.kind === "eq") {
      flush();
      seg.lines.forEach((text, i) => {
        rows.push({
          kind: "eq",
          left: { no: (seg.leftStart ?? 0) + i, text },
          right: { no: (seg.rightStart ?? 0) + i, text },
        });
      });
    } else if (seg.kind === "del") {
      seg.lines.forEach((text, i) => pending.push({ no: (seg.leftStart ?? 0) + i, text }));
    } else {
      flush(seg.lines.map((text, i) => ({ no: (seg.rightStart ?? 0) + i, text })));
    }
  }
  flush();
  return rows;
}

/** 行统计（解析路径用；后端路径直接带 additions/deletions） */
export function rowsStats(rows: DiffRow[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const r of rows) {
    if (r.kind === "add" || r.kind === "pair") additions++;
    if (r.kind === "del" || r.kind === "pair") deletions++;
  }
  return { additions, deletions };
}

/** 展示项构建：相同行长段折叠为间隙（保留上下文 ±ctx 行），onlyDiff 时全部折叠 */
export function buildDisplayItems(
  rows: DiffRow[],
  opts: { ctx?: number; expanded?: Set<string>; onlyDiff?: boolean; idPrefix?: string } = {},
): DisplayItem[] {
  const ctx = opts.ctx ?? 3;
  const expanded = opts.expanded;
  const onlyDiff = opts.onlyDiff ?? false;
  // onlyDiff：相同行不留上下文
  const keep = onlyDiff ? 0 : ctx;
  const prefix = opts.idPrefix ?? "";
  const items: DisplayItem[] = [];
  let i = 0;
  let gapSeq = 0;
  const pushRun = (from: number, to: number) => {
    for (let k = from; k < to; k++) items.push({ type: "row", row: rows[k], index: k });
  };
  const emitGap = (from: number, to: number) => {
    const hidden = to - from;
    if (hidden <= 0) return;
    const id = `${prefix}gap-${gapSeq++}`;
    if (expanded?.has(id)) pushRun(from, to);
    else items.push({ type: "gap", id, count: hidden, from });
  };
  while (i < rows.length) {
    if (rows[i].kind !== "eq") {
      items.push({ type: "row", row: rows[i], index: i });
      i++;
      continue;
    }
    // 相同行 run [i, j)
    let j = i;
    while (j < rows.length && rows[j].kind === "eq") j++;
    const len = j - i;
    // 常规模式：不超过 2*keep+1 行的相同段原样保留
    const collapsible = onlyDiff || len > keep * 2 + 1;
    if (!collapsible) {
      pushRun(i, j);
    } else if (i === 0) {
      // 文件头：只保留末尾 keep 行作首个改动的前文
      const tail = Math.min(keep, len);
      emitGap(i, j - tail);
      pushRun(j - tail, j);
    } else if (j === rows.length) {
      const head = Math.min(keep, len);
      pushRun(i, i + head);
      emitGap(i + head, j);
    } else {
      const head = Math.min(keep, len);
      const tail = Math.min(keep, len - head);
      pushRun(i, i + head);
      emitGap(i + head, j - tail);
      pushRun(j - tail, j);
    }
    i = j;
  }
  return items;
}

// ==================== v0.34 前端区域重 diff（编辑保存 / 局部补丁用） ====================
//
// 与后端 text_diff.rs 同一套策略的 TS 移植：去公共前后缀 → 中段 Myers O(ND)
// （带行数/编辑距离上限，超限退化为整块替换）。只用于「编辑 / 补丁应用后的小区域
// 重建」，区域通常只有几行，不会触碰后端那次全量 diff 的性能边界。

const MID_LINES_CAP = 1500;
const D_CAP = 800;

type DiffOp = "eq" | "del" | "add";

function myersOps(a: number[], b: number[], maxD: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return myersBacktrack(trace, n, m, offset);
    }
  }
  return null;
}

function myersBacktrack(trace: Int32Array[], n: number, m: number, offset: number): DiffOp[] {
  let x = n;
  let y = m;
  const ops: DiffOp[] = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("eq");
      x--;
      y--;
    }
    if (d > 0) {
      // x 未动 = 从 k+1 下移来（add）；否则右移来（del）
      ops.push(x === prevX ? "add" : "del");
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

/** 两侧行数组 → op 序列（前后缀修剪 + Myers，超限整块替换） */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const midA = a.slice(pre, n - suf);
  const midB = b.slice(pre, m - suf);
  let ops: DiffOp[] | null = null;
  if (Math.max(midA.length, midB.length) <= MID_LINES_CAP) {
    const ids = new Map<string, number>();
    let next = 0;
    const toIds = (lines: string[]) =>
      lines.map((l) => {
        let id = ids.get(l);
        if (id === undefined) {
          id = ++next;
          ids.set(l, id);
        }
        return id;
      });
    ops = myersOps(toIds(midA), toIds(midB), D_CAP);
  }
  const mid = ops ?? [...midA.map((): DiffOp => "del"), ...midB.map((): DiffOp => "add")];
  const eq = (count: number): DiffOp[] => Array.from({ length: count }, (): DiffOp => "eq");
  return [...eq(pre), ...mid, ...eq(suf)];
}

/** op 序列 + 两侧行内容 → 成对行（行号占位为 0，需 renumberRows 重排） */
export function zipRows(a: string[], b: string[], ops: DiffOp[]): DiffRow[] {
  const mk = (text: string) => ({ no: 0, text });
  const rows: DiffRow[] = [];
  let pending: string[] = [];
  let ai = 0;
  let bi = 0;
  const flush = (adds: string[]) => {
    const n = Math.max(pending.length, adds.length);
    for (let i = 0; i < n; i++) {
      const l = pending[i];
      const r = adds[i];
      if (l !== undefined && r !== undefined) rows.push({ kind: "pair", left: mk(l), right: mk(r) });
      else if (l !== undefined) rows.push({ kind: "del", left: mk(l), right: null });
      else rows.push({ kind: "add", left: null, right: mk(r) });
    }
    pending = [];
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === "eq") {
      flush([]);
      rows.push({ kind: "eq", left: mk(a[ai++]), right: mk(b[bi++]) });
    } else if (op === "del") {
      pending.push(a[ai++]);
    } else {
      const adds: string[] = [];
      while (i < ops.length && ops[i] === "add") {
        adds.push(b[bi++]);
        i++;
      }
      i--; // 抵消外层 for 的 ++（连续 add 已在内层消费完毕）
      flush(adds);
    }
  }
  flush([]);
  return rows;
}

/** 就地重排整表行号：按行序累计左右行号（1 基）。区域重建后必须调用。 */
export function renumberRows(rows: DiffRow[]): void {
  let l = 0;
  let r = 0;
  for (const row of rows) {
    if (row.left) row.left.no = ++l;
    if (row.right) row.right.no = ++r;
  }
}

/** 调用方对某侧全量行数组做过的 splice 变更（变化前行数组的 0 基下标） */
export interface RegionMutation {
  start: number;
  removed: number;
  inserted: number;
}

/**
 * 区域重建（v0.34）：rows[rs..re) 内任一侧内容有变（单行编辑 / 插入 / 删除 / 补丁应用）后，
 * 把区域扩张到最近的 eq 锚点（锚点内容未变，是稳定的对齐边界），按两侧行号范围从
 * 全量行数组取内容重新 diff，拼接回整表并重排行号。返回新数组，不修改入参。
 *
 * mutation：调用方已在对应侧全量行数组上做过的 splice（行号仍为变化前的旧编号）。
 * 变更落在区域内/紧邻边界时，区域终点按行数增量延伸/收缩；整体在区域之前时平移区间。
 * 注意：锚点间的局部 diff 与全量最优 diff 在极少数情形下对齐不同，属有效差异表示；
 * 保存后会以后端全量 diff 为准刷新。
 */
export function rediffRegion(
  rows: DiffRow[],
  rs: number,
  re: number,
  leftLines: string[],
  rightLines: string[],
  mutation?: { left?: RegionMutation; right?: RegionMutation },
): DiffRow[] {
  let s = rs;
  let e = re;
  while (s > 0 && rows[s - 1].kind !== "eq") s--;
  while (e < rows.length && rows[e].kind !== "eq") e++;
  // 区域在该侧的行号范围（1 基闭区间）：优先取区域内首/末个有内容的行，
  // 全空时用相邻锚点行号推算（两端推算结果一致地落在空区间上）
  let firstL: number | undefined;
  let lastL: number | undefined;
  let firstR: number | undefined;
  let lastR: number | undefined;
  for (let i = s; i < e; i++) {
    if (rows[i].left && firstL === undefined) firstL = rows[i].left!.no;
    if (rows[i].left) lastL = rows[i].left!.no;
    if (rows[i].right && firstR === undefined) firstR = rows[i].right!.no;
    if (rows[i].right) lastR = rows[i].right!.no;
  }
  const lStart = firstL ?? (s > 0 ? rows[s - 1].left!.no + 1 : 1);
  const lEnd = lastL ?? (e < rows.length ? rows[e].left!.no - 1 : lStart - 1);
  const rStart = firstR ?? (s > 0 ? rows[s - 1].right!.no + 1 : 1);
  const rEnd = lastR ?? (e < rows.length ? rows[e].right!.no - 1 : rStart - 1);
  // 旧行号区间 → 变更后新数组上的 0 基闭区间（end < start 表示空区间）
  const rangeAfter = (ls: number, le: number, m: RegionMutation | undefined) => {
    const ls0 = ls - 1;
    const le0 = le - 1;
    if (!m) return [ls0, le0] as const;
    if (m.start + m.removed < ls0) {
      const d = m.inserted - m.removed;
      return [ls0 + d, le0 + d] as const;
    }
    return [Math.min(ls0, m.start), le0 + m.inserted - m.removed] as const;
  };
  const [la, lb] = rangeAfter(lStart, lEnd, mutation?.left);
  const [ra, rb] = rangeAfter(rStart, rEnd, mutation?.right);
  const a = leftLines.slice(la, lb + 1);
  const b = rightLines.slice(ra, rb + 1);
  const regionRows = zipRows(a, b, diffOps(a, b));
  const next = [...rows.slice(0, s), ...regionRows, ...rows.slice(e)];
  renumberRows(next);
  return next;
}

function stripTag(name: string): string {
  // 去掉 "a/"、"b/" 前缀与 "\t时间戳" 尾巴；引号路径去引号
  let s = name.trim();
  const tab = s.indexOf("\t");
  if (tab >= 0) s = s.slice(0, tab);
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  if (s.length > 2 && (s.startsWith("a/") || s.startsWith("b/"))) s = s.slice(2);
  return s;
}

/**
 * 解析 unified diff（git diff 输出 / .patch / .diff / 粘贴文本）。
 * 宽容策略：只认 `@@` hunk 与 `---/+++` 文件头，其余行（index、CI 日志前后文）忽略；
 * 一个文件都没有时抛错（前端提示「未识别出 diff 内容」）。
 */
export function parseUnifiedDiff(text: string): PatchSection[] {
  const lines = text.split(/\r?\n/);
  const sections: PatchSection[] = [];
  let cur: PatchSection | null = null;
  let inHunk = false;
  let leftNo = 0;
  let rightNo = 0;
  let pending: { no: number; text: string }[] = [];

  const flushHunk = () => {
    for (const l of pending) cur?.rows.push(delRow(l.no, l.text));
    pending = [];
    inHunk = false;
  };
  const ensureSection = () => {
    if (!cur) {
      cur = { leftName: "(未知文件)", rightName: "(未知文件)", rows: [] };
      sections.push(cur);
    }
  };

  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      flushHunk();
      ensureSection();
      inHunk = true;
      leftNo = Number(m[1]);
      rightNo = Number(m[3]);
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("diff --git ") || raw.startsWith("Index: ")) {
        flushHunk();
        cur = null; // 新文件段：等 ---/+++ 提供名字
      } else if (raw.startsWith("--- ")) {
        flushHunk();
        cur = { leftName: stripTag(raw.slice(4)), rightName: "(未知文件)", rows: [] };
        sections.push(cur);
      } else if (raw.startsWith("+++ ")) {
        if (cur) cur.rightName = stripTag(raw.slice(4));
      }
      continue;
    }
    // hunk 内（inHunk=true 时 cur 必已存在：@@ 分支先 ensureSection 再置位）
    if (raw.startsWith("-")) {
      pending.push({ no: leftNo++, text: raw.slice(1) });
    } else if (raw.startsWith("+")) {
      const text = raw.slice(1);
      const l = pending.shift();
      if (l) cur!.rows.push({ kind: "pair", left: l, right: { no: rightNo++, text } });
      else cur!.rows.push(addRow(rightNo++, text));
    } else if (raw.startsWith(" ") || raw === "") {
      // 上下文行（unified 格式空行等价 " "）：先结算挂起的删除行
      for (const l of pending) cur!.rows.push(delRow(l.no, l.text));
      pending = [];
      const text = raw.slice(1);
      cur!.rows.push({
        kind: "eq",
        left: { no: leftNo++, text },
        right: { no: rightNo++, text },
      });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" —— 轻量忽略
    } else {
      // hunk 内未知行：视为 hunk 结束（宽容粘贴日志场景）
      flushHunk();
    }
  }
  flushHunk();
  return sections.filter((s) => s.rows.length > 0);
}
