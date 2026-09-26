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

/** 展示项：真实行 / 折叠的相同行间隙（点击展开） */
export type DisplayItem =
  | { type: "row"; row: DiffRow }
  | { type: "gap"; id: string; count: number };

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
    for (let k = from; k < to; k++) items.push({ type: "row", row: rows[k] });
  };
  const emitGap = (from: number, to: number) => {
    const hidden = to - from;
    if (hidden <= 0) return;
    const id = `${prefix}gap-${gapSeq++}`;
    if (expanded?.has(id)) pushRun(from, to);
    else items.push({ type: "gap", id, count: hidden });
  };
  while (i < rows.length) {
    if (rows[i].kind !== "eq") {
      items.push({ type: "row", row: rows[i] });
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
