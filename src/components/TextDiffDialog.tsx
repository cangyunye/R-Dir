import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  FileDiff,
  GripVertical,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { diffTextFiles, readTextFile, writeTextSide } from "@/lib/api";
import {
  buildDisplayItems,
  parseUnifiedDiff,
  rediffRegion,
  rowsFromSegments,
  rowsStats,
  type DiffRow,
} from "@/lib/text-diff";
import { AppConfirmDialog, type AppConfirmRequest } from "@/components/AppConfirmDialog";
import { Button } from "@/components/ui/button";
import { isMac } from "@/lib/keymap";
import { cn } from "@/lib/utils";

/** 文本比较的来源：任意两侧文件 / 粘贴的 diff 文本 / .patch 文件 */
export type TextDiffSource =
  | { kind: "files"; left: string; right: string; leftLabel?: string; rightLabel?: string }
  | { kind: "patchText"; text: string; title?: string }
  | { kind: "patchFile"; path: string };

type Side = "left" | "right";

interface Section {
  leftName: string;
  rightName: string;
  rows: DiffRow[];
}

/** 与 FileList 的虚拟滚动解耦：diff 行高独立（含表头/间隙统一行高） */
const ROW_H = 24;
const BUFFER = 8;
/** 行号槽宽度（左右各一列，中轴恰好在容器 50% 处） */
const GUTTER = 48;

/** v0.21.1 编码切换：value 为 WhatWG 标签，后端经 encoding_rs 解码 */
const ENCODINGS: { value: string; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "gbk", label: "GBK" },
  { value: "big5", label: "Big5" },
  { value: "shift_jis", label: "Shift_JIS" },
  { value: "euc-kr", label: "EUC-KR" },
  { value: "windows-1252", label: "Latin-1" },
];

const EOL_LABEL: Record<string, string> = {
  lf: "LF (UNIX)",
  crlf: "CRLF (DOS)",
  mixed: "混合行尾",
  none: "无换行",
};

type Item =
  | { type: "section"; si: number }
  | { type: "row"; row: DiffRow; rowIdx: number }
  | { type: "gap"; id: string; count: number };

function titleOf(source: TextDiffSource): string {
  if (source.kind === "files") return "文本比较";
  if (source.kind === "patchText") return source.title ?? "Git Diff（粘贴导入）";
  return "Git Diff";
}

/**
 * 测一侧内容的最大行宽（px）：等宽字体按 ASCII 单宽、其余双宽估算挑出最长行，
 * 再对候选行用 canvas 精测一次。O(总字符数) 且只有 1~2 次 measureText，
 * 8MB 级文件也不卡。仅用于滚动条量程，±1px 误差无感。
 */
function maxLineWidth(rows: DiffRow[], side: Side, font: string | null): number {
  const ctx = document.createElement("canvas").getContext("2d");
  const measure = (t: string) => {
    if (!ctx) return t.length * 7.2;
    ctx.font = font || "11px monospace";
    return ctx.measureText(t).width;
  };
  let best = "";
  let bestW = -1;
  let wAscii = 0;
  for (const row of rows) {
    const t = row[side]?.text;
    if (!t) continue;
    if (!wAscii) wAscii = measure("0") || 7;
    let est = 0;
    for (let i = 0; i < t.length; i++) est += t.charCodeAt(i) < 0x2e80 ? wAscii : wAscii * 2;
    if (est > bestW) {
      bestW = est;
      best = t;
    }
  }
  if (!best) return 0;
  return measure(best) + 17; // 单元格 px-2 内边距 16 + 1px 余量
}

/**
 * 横向滚动条（左右各一条，绑定同一偏移：拖任意一条，两条同步移动）。
 * 量程为两侧内容的最大宽度，指针按下即定位并可续拖（pointer capture）。
 */
function HScrollBar({
  side,
  value,
  max,
  onChange,
}: {
  side: Side;
  value: number;
  max: number;
  onChange: (h: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // track 宽 == 半栏视口宽：thumb 长按 可视/总内容 比例
  const thumbW = max > 0 ? Math.max(24, Math.round((trackW / (trackW + max)) * trackW)) : trackW;
  const range = Math.max(1, trackW - thumbW);
  const thumbX = max > 0 ? (value / max) * range : 0;
  const toH = (clientX: number) => {
    const el = trackRef.current;
    if (!el || max <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - thumbW / 2;
    return Math.max(0, Math.min(max, (x / range) * max));
  };
  return (
    <div
      ref={trackRef}
      data-hscroll={side}
      className="relative mx-1 h-2 cursor-pointer rounded bg-muted/60 hover:bg-muted"
      title={side === "left" ? "左侧横向滚动（与右侧联动）" : "右侧横向滚动（与左侧联动）"}
      onPointerDown={(e) => {
        if (max <= 0) return;
        e.preventDefault();
        onChange(toH(e.clientX));
        const move = (ev: PointerEvent) => onChange(toH(ev.clientX));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    >
      <div
        data-hscroll-thumb={side}
        className="absolute inset-y-0 rounded bg-foreground/25 hover:bg-foreground/40"
        style={{ width: thumbW, transform: `translateX(${thumbX}px)` }}
      />
    </div>
  );
}

/**
 * 文本差异窗口（v0.19）：左右双栏 + 行号，del 红 / add 绿，
 * 长相同段折叠（±3 行上下文，点击展开），支持只看差异。
 * 文件模式与 patch 解析模式共用本渲染器。
 * v0.29.1：打开即最大化；左右双栏恒定等宽同屏。
 * v0.34：双横向滚动条（联动 + 方向键/滚轮横移，长行不再把对侧挤出屏幕）；
 * 双侧可编辑保存（vimdiff 式）；中轴差异块可一键局部 patch（左→右 / 右→左）。
 */
export function TextDiffDialog({
  source,
  onClose,
}: {
  source: TextDiffSource;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [stats, setStats] = useState({ additions: 0, deletions: 0 });
  const [same, setSame] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const [lossy, setLossy] = useState(false);
  /** v0.34 按 side 记录 lossy（某侧解码有损时禁编辑，避免把替换符写回磁盘） */
  const [lossySides, setLossySides] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });
  const [onlyDiff, setOnlyDiff] = useState(false);
  // v0.29.1 打开即最大化：差异阅读吃屏幕空间，1400px 窗口两侧各 ~650px，长行必须横向拖动
  const [maximized, setMaximized] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ w: 1200, h: 400 });
  /** v0.21.1 编码切换（仅 files 模式；切换后两侧同时按新编码重新比较） */
  const [encoding, setEncoding] = useState("utf-8");
  /** 两侧行尾格式（files 模式，来自后端 TextSide.eol；保存时按原格式回写） */
  const [eols, setEols] = useState<{ left?: string; right?: string }>({});
  // ---- v0.34 编辑模型：files 模式下两侧全量行数组（下标 = 行号-1）+ 脏标记 ----
  const [sideLines, setSideLines] = useState<{ left: string[]; right: string[] }>({
    left: [],
    right: [],
  });
  const [dirty, setDirty] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ text: string; err?: boolean } | null>(null);
  // ---- v0.34 双横向滚动条：左右两条绑定同一偏移 ----
  const [hScroll, setHScrollState] = useState(0);
  const [contentW, setContentW] = useState<{ left: number; right: number }>({ left: 0, right: 0 });
  // ---- v0.34 行内编辑 ----
  const [editing, setEditing] = useState<{ rowIdx: number; side: Side } | null>(null);
  const [editValue, setEditValue] = useState("");
  // ---- 关闭 / 切编码 / 放弃修改前的确认 ----
  const [confirmReq, setConfirmReq] = useState<AppConfirmRequest | null>(null);
  const confirmActionRef = useRef<() => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);

  const filesMode = source.kind === "files";
  const anyDirty = dirty.left || dirty.right;

  // 加载（手动重载沿用）：token 防乱序；preserveScroll 供保存/放弃后恢复阅读位置
  const loadTokenRef = useRef(0);
  const load = useCallback(
    async (preserveScroll = false) => {
      const token = ++loadTokenRef.current;
      const alive = () => token === loadTokenRef.current;
      const st = scrollRef.current?.scrollTop ?? 0;
      setLoading(true);
      setError(null);
      setExpanded(new Set());
      setEditing(null);
      setSaveNote(null);
      setDirty({ left: false, right: false });
      if (!preserveScroll) setScrollTop(0);
      try {
        if (source.kind === "files") {
          const out = await diffTextFiles(source.left, source.right, encoding);
          if (!alive()) return;
          const rows = rowsFromSegments(out.segments);
          setSections([
            {
              leftName: source.leftLabel ?? out.left.path,
              rightName: source.rightLabel ?? out.right.path,
              rows,
            },
          ]);
          setSideLines({
            left: rows.map((r) => r.left?.text ?? ""),
            right: rows.map((r) => r.right?.text ?? ""),
          });
          setStats({ additions: out.additions, deletions: out.deletions });
          setSame(out.same);
          setCoarse(out.coarse);
          setLossy(out.left.lossy || out.right.lossy);
          setLossySides({ left: out.left.lossy, right: out.right.lossy });
          setEols({ left: out.left.eol, right: out.right.eol });
        } else {
          const text =
            source.kind === "patchText" ? source.text : (await readTextFile(source.path)).text;
          if (!alive()) return;
          const parsed = parseUnifiedDiff(text);
          if (parsed.length === 0) {
            throw new Error("未识别出 diff 内容（需要 unified diff 格式：git diff 输出或 .patch 文件）");
          }
          setSections(parsed.map((s) => ({ leftName: s.leftName, rightName: s.rightName, rows: s.rows })));
          const total = parsed.reduce(
            (acc, s) => {
              const st2 = rowsStats(s.rows);
              return { additions: acc.additions + st2.additions, deletions: acc.deletions + st2.deletions };
            },
            { additions: 0, deletions: 0 },
          );
          setStats(total);
          setSame(total.additions === 0 && total.deletions === 0);
          setCoarse(false);
          setLossy(false);
          setLossySides({ left: false, right: false });
          setEols({});
          setSideLines({ left: [], right: [] });
        }
        if (preserveScroll) {
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = st;
              setScrollTop(st);
            }
          });
        }
      } catch (e) {
        if (alive()) setError(String(e));
      } finally {
        if (alive()) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, encoding],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Esc 关闭 + F11/⌘⇧F 全屏切换：仅在比对窗口打开期间注册（组件卸载即失效）。
  // 监听器只订阅一次（回调走 ref），避免 [onClose] 依赖在每次渲染时反复退订/重订——
  // 重订阅窗口期与事件派发撞车时，真实按键会被跳过（表现为 Esc/F11 偶发不响应）。
  // v0.29.1：macOS 把 F11 绑定为「调度中心 → 显示桌面」，按键在系统层就被吃掉、
  // 页面根本收不到（表现为 F11 无效），因此补一路 mod+shift+F（mac ⌘⇧F / win Ctrl+Shift+F），
  // 两平台都能穿透到页面；F11 保留给 Windows 用户。
  // v0.34：←/→（Shift=到两端）横向滚动，↑/↓/PageUp/PageDown/Home/End 纵向滚动；
  // 焦点在输入框内时不劫持。
  const keyActionRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyActionRef.current = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      requestClose();
      return;
    }
    const maximizeKey =
      e.key === "F11" ||
      (e.key === "F" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey);
    if (maximizeKey) {
      e.preventDefault();
      setMaximized((m) => !m);
      return;
    }
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
    ) {
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const vMove = (dy: number) => {
      e.preventDefault();
      el.scrollTop = Math.max(0, Math.min(el.scrollHeight, el.scrollTop + dy));
      setScrollTop(el.scrollTop);
    };
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        setHScroll(hScroll - (e.shiftKey ? el.clientWidth : 64));
        break;
      case "ArrowRight":
        e.preventDefault();
        setHScroll(hScroll + (e.shiftKey ? el.clientWidth : 64));
        break;
      case "ArrowUp":
        vMove(-ROW_H);
        break;
      case "ArrowDown":
        vMove(ROW_H);
        break;
      case "PageUp":
        vMove(-el.clientHeight);
        break;
      case "PageDown":
        vMove(el.clientHeight);
        break;
      case "Home":
        vMove(-el.scrollTop);
        break;
      case "End":
        vMove(el.scrollHeight);
        break;
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyActionRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视口尺寸（虚拟滚动窗口 + 横向量程）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [loading]);

  const paneW = Math.max(0, (viewport.w - GUTTER * 2) / 2);
  const maxScroll = Math.max(0, Math.ceil(Math.max(contentW.left, contentW.right) - paneW));
  const hMaxRef = useRef(0);
  hMaxRef.current = maxScroll;
  const hScrollRef = useRef(0);
  hScrollRef.current = hScroll;
  const setHScroll = useCallback((h: number) => {
    setHScrollState(() => Math.max(0, Math.min(hMaxRef.current, Math.round(h))));
  }, []);
  // 量程缩小（重载/缩窗）时收回越界的偏移
  useEffect(() => {
    setHScrollState((h) => Math.min(h, maxScroll));
  }, [maxScroll]);

  // 内容宽度测量（滚动条量程）：等真实单元格渲染后取实际字体
  useEffect(() => {
    if (loading || sections.length === 0) return;
    const cell = scrollRef.current?.querySelector<HTMLElement>("[data-diff-cell]");
    let font: string | null = null;
    if (cell) {
      const cs = getComputedStyle(cell);
      font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    }
    const all = sections.flatMap((s) => s.rows);
    setContentW({ left: maxLineWidth(all, "left", font), right: maxLineWidth(all, "right", font) });
  }, [sections, loading]);

  /** 展示项 + 差异块（hunk）索引：hunk = 连续非 eq 行（被 gap/eq 隔开即分块），键为 items 下标 */
  const { items, hunks } = useMemo(() => {
    const out: Item[] = [];
    const hunkMap = new Map<number, { s: number; e: number }>();
    sections.forEach((s, si) => {
      out.push({ type: "section", si });
      let prevHunk: { s: number; e: number } | null = null;
      for (const it of buildDisplayItems(s.rows, { expanded, onlyDiff, idPrefix: `${si}:` })) {
        if (it.type === "row") {
          out.push({ type: "row", row: it.row, rowIdx: it.index });
          if (it.row.kind !== "eq") {
            if (prevHunk) prevHunk.e = it.index + 1;
            else {
              const h = { s: it.index, e: it.index + 1 };
              hunkMap.set(out.length - 1, h);
              prevHunk = h;
            }
          } else {
            prevHunk = null;
          }
        } else {
          out.push({ type: "gap", id: it.id, count: it.count });
          prevHunk = null;
        }
      }
    });
    return { items: out, hunks: hunkMap };
  }, [sections, expanded, onlyDiff]);

  const expandGap = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const range = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
    const end = Math.min(items.length, Math.ceil((scrollTop + viewport.h) / ROW_H) + BUFFER);
    return { start, end, padTop: start * ROW_H, padBottom: Math.max(0, items.length - end) * ROW_H };
  }, [items, scrollTop, viewport.h]);

  const leftLabel = source.kind === "files" ? (source.leftLabel ?? source.left) : null;
  const rightLabel = source.kind === "files" ? (source.rightLabel ?? source.right) : null;
  const maximizeHint = (isMac ? "F11 / ⌘⇧F" : "F11 / Ctrl+Shift+F");

  // ---- v0.34 编辑 / 补丁 / 保存 ----

  const sideEditable = (side: Side): boolean => {
    if (!filesMode || loading) return false;
    if (lossySides[side]) return false;
    const p = side === "left" ? source.left : source.right;
    return !p.startsWith("http://") && !p.startsWith("https://");
  };

  /** 编辑类操作的统一落地：更新行数组 + 重建 rows + 统计/脏标记 */
  const applyEdit = (side: Side, lines: string[], newRows: DiffRow[]) => {
    setSideLines((prev) => ({ ...prev, [side]: lines }));
    setSections((prev) => prev.map((s, i) => (i === 0 ? { ...s, rows: newRows } : s)));
    const st = rowsStats(newRows);
    setStats(st);
    setSame(st.additions + st.deletions === 0);
    setDirty((d) => ({ ...d, [side]: true }));
    setSaveNote(null);
  };

  // 编辑会话走 ref：Enter 提交后输入框卸载引发的 blur 不再二次提交
  const editingRef = useRef<{ rowIdx: number; side: Side } | null>(null);
  editingRef.current = editing;
  const editValueRef = useRef("");
  editValueRef.current = editValue;

  const startEdit = (rowIdx: number, side: Side) => {
    const line = sections[0]?.rows[rowIdx]?.[side];
    if (!line || !sideEditable(side)) return;
    setEditing({ rowIdx, side });
    setEditValue(line.text);
  };

  const commitEdit = () => {
    const ed = editingRef.current;
    if (!ed || !sections[0]) return;
    editingRef.current = null;
    setEditing(null);
    const row = sections[0].rows[ed.rowIdx];
    const line = row?.[ed.side];
    const value = editValueRef.current;
    if (!line || line.text === value) return;
    const lines = [...sideLines[ed.side]];
    lines[line.no - 1] = value;
    const newRows = rediffRegion(
      sections[0].rows,
      ed.rowIdx,
      ed.rowIdx + 1,
      ed.side === "left" ? lines : sideLines.left,
      ed.side === "right" ? lines : sideLines.right,
      { [ed.side]: { start: line.no - 1, removed: 1, inserted: 1 } },
    );
    applyEdit(ed.side, lines, newRows);
  };

  const deleteLine = (rowIdx: number, side: Side) => {
    const cur = sections[0]?.rows[rowIdx]?.[side];
    if (!cur || !sideEditable(side)) return;
    editingRef.current = null;
    setEditing(null);
    const lines = [...sideLines[side]];
    lines.splice(cur.no - 1, 1);
    const newRows = rediffRegion(
      sections[0].rows,
      rowIdx,
      rowIdx + 1,
      side === "left" ? lines : sideLines.left,
      side === "right" ? lines : sideLines.right,
      { [side]: { start: cur.no - 1, removed: 1, inserted: 0 } },
    );
    applyEdit(side, lines, newRows);
  };

  const insertLineBelow = (rowIdx: number, side: Side) => {
    const rows = sections[0]?.rows;
    if (!rows || !sideEditable(side)) return;
    editingRef.current = null;
    setEditing(null);
    // 插入点 = 该侧在 rows[0..rowIdx] 的行数（含当前行；当前行无该侧内容时 = 其前方行数）
    let count = 0;
    for (let i = 0; i <= rowIdx; i++) if (rows[i][side]) count++;
    let s = rowIdx;
    let e = rowIdx + 1;
    while (s > 0 && rows[s - 1].kind !== "eq") s--;
    while (e < rows.length && rows[e].kind !== "eq") e++;
    const lines = [...sideLines[side]];
    lines.splice(count, 0, "");
    const newRows = rediffRegion(
      rows,
      rowIdx,
      rowIdx + 1,
      side === "left" ? lines : sideLines.left,
      side === "right" ? lines : sideLines.right,
      { [side]: { start: count, removed: 0, inserted: 1 } },
    );
    applyEdit(side, lines, newRows);
    // 直接进入新行编辑：区域重建后该侧行号为 count（1 基）的行即新行
    for (let i = s; i < newRows.length; i++) {
      if (newRows[i][side]?.no === count) {
        setEditing({ rowIdx: i, side });
        setEditValue("");
        break;
      }
    }
  };

  /** 局部 patch：把 hunk [s,e) 一侧的内容应用到另一侧（vimdiff 的 do/dp），目标侧标记未保存 */
  const applyHunk = (s: number, e: number, dir: "l2r" | "r2l") => {
    const rows = sections[0]?.rows;
    if (!rows || !filesMode) return;
    const dst: Side = dir === "l2r" ? "right" : "left";
    const src: Side = dir === "l2r" ? "left" : "right";
    if (!sideEditable(dst)) return;
    editingRef.current = null;
    setEditing(null);
    // 目标侧在 hunk 区间内的行号范围（hunk 由 eq 锚点包围；全空 = 纯插入/纯删除）
    let firstDst: number | undefined;
    let lastDst: number | undefined;
    for (let i = s; i < e; i++) {
      const no = rows[i][dst]?.no;
      if (no !== undefined) {
        if (firstDst === undefined) firstDst = no;
        lastDst = no;
      }
    }
    const start = firstDst ?? (s > 0 ? rows[s - 1][dst]!.no + 1 : 1);
    const end = lastDst ?? (e < rows.length ? rows[e][dst]!.no - 1 : start - 1);
    const srcLines = rows.slice(s, e).flatMap((r) => (r[src] ? [r[src]!.text] : []));
    const lines = [...sideLines[dst]];
    lines.splice(start - 1, Math.max(0, end - start + 1), ...srcLines);
    const newRows = rediffRegion(
      rows,
      s,
      e,
      dir === "l2r" ? sideLines.left : lines,
      dir === "l2r" ? lines : sideLines.right,
      {
        [dst]: {
          start: start - 1,
          removed: Math.max(0, end - start + 1),
          inserted: srcLines.length,
        },
      },
    );
    applyEdit(dst, lines, newRows);
  };

  const saveAll = async () => {
    if (!filesMode || saving || !anyDirty) return;
    setSaving(true);
    setSaveNote(null);
    const jobs: Promise<void>[] = [];
    if (dirty.left) jobs.push(writeTextSide(source.left, sideLines.left, eols.left ?? "lf", encoding));
    if (dirty.right) jobs.push(writeTextSide(source.right, sideLines.right, eols.right ?? "lf", encoding));
    try {
      await Promise.all(jobs);
      await load(true);
      setSaveNote({ text: "已保存" });
    } catch (e) {
      setSaveNote({ text: `保存失败：${String(e)}`, err: true });
    } finally {
      setSaving(false);
    }
  };

  const discardEdits = () => {
    setConfirmReq({
      title: "放弃未保存的修改？",
      message: "两侧的编辑（含已应用的补丁）将被丢弃，重新从磁盘读取。",
      confirmLabel: "放弃修改",
      danger: true,
    });
    confirmActionRef.current = () => void load(true);
  };

  const requestClose = () => {
    if (anyDirty) {
      setConfirmReq({
        title: "有未保存的修改",
        message: "关闭将丢弃两侧未保存的编辑。",
        confirmLabel: "放弃并关闭",
        danger: true,
      });
      confirmActionRef.current = onClose;
    } else {
      onClose();
    }
  };

  const changeEncoding = (enc: string) => {
    if (anyDirty) {
      setConfirmReq({
        title: "切换编码将丢弃未保存的修改",
        message: "切换编码会按新编码重新读取并比较两侧文件，未保存的编辑（含已应用的补丁）将被丢弃。",
        confirmLabel: "切换",
      });
      confirmActionRef.current = () => setEncoding(enc);
    } else {
      setEncoding(enc);
    }
  };

  const cellCls = (side: Side, row: DiffRow) => {
    const active =
      side === "left"
        ? row.kind === "del" || row.kind === "pair"
        : row.kind === "add" || row.kind === "pair";
    return cn(
      "block px-2 font-mono text-[11px] leading-6",
      // v0.29.1：必须 overflow-hidden——1fr 轨道 min-size 是 auto，长行会把本侧轨道
      // 撑到整行 min-content 宽，把右侧整列推出视口。v0.34 起双栏恒定半宽，
      // 超长行在栏内经横向滚动条查看（不再 ellipsis 截断）。
      "overflow-hidden",
      active && (side === "left" ? "bg-destructive/15" : "bg-emerald-500/15"),
      !active && row.kind !== "eq" && "text-muted-foreground/30",
    );
  };

  const gutterBtn =
    "flex h-4 w-3.5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";
  const gutterCls = cn(
    "relative select-none border-r px-1 text-right font-mono text-[10px] leading-6 text-muted-foreground/70 tabular-nums",
  );

  /** 行号槽：可编辑侧悬停显示 编辑 / 下方插入 / 删除 三个微型按钮 */
  const renderGutter = (row: DiffRow, rowIdx: number, side: Side) => {
    const line = row[side];
    const can = sideEditable(side);
    const sideName = side === "left" ? "左" : "右";
    return (
      <span className={cn(gutterCls, line ? "" : "bg-muted/10")}>
        {can && (
          <span className="absolute inset-0 z-10 hidden items-center justify-end gap-px pr-0.5 group-hover/row:flex">
            <button
              className={gutterBtn}
              title={`编辑本行（${sideName}侧）`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => startEdit(rowIdx, side)}
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
            <button
              className={gutterBtn}
              title={`在下方插入一行（${sideName}侧）`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertLineBelow(rowIdx, side)}
            >
              <Plus className="h-2.5 w-2.5" />
            </button>
            <button
              className={gutterBtn}
              title={`删除本行（${sideName}侧）`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => deleteLine(rowIdx, side)}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        <span className={can ? "group-hover/row:opacity-0" : undefined}>{line?.no ?? ""}</span>
      </span>
    );
  };

  /** 文本单元格：横向偏移经 translate 实现（双栏各裁各的，滚动条联动）；双击进入编辑 */
  const renderCell = (row: DiffRow, rowIdx: number, side: Side) => {
    const line = row[side];
    if (editing && editing.rowIdx === rowIdx && editing.side === side) {
      return (
        <span className={cn(cellCls(side, row), "ring-1 ring-inset ring-primary/60")}>
          <input
            data-diff-edit=""
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onFocus={(e) => {
              e.currentTarget.scrollLeft = hScrollRef.current;
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                editingRef.current = null;
                setEditing(null);
              }
            }}
            onBlur={commitEdit}
            className="h-6 w-full bg-background px-2 font-mono text-[11px] leading-6 text-foreground outline-none"
          />
        </span>
      );
    }
    return (
      <span
        data-diff-cell={side}
        className={cellCls(side, row)}
        title={line?.text || undefined}
        onDoubleClick={() => startEdit(rowIdx, side)}
      >
        <span
          className="inline-block whitespace-pre"
          style={hScroll > 0 ? { transform: `translateX(${-hScroll}px)` } : undefined}
        >
          {line?.text ?? ""}
        </span>
      </span>
    );
  };

  return (
    <div
      data-text-diff=""
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        style={
          maximized
            ? { width: "calc((100vw - 24px) / var(--rdir-zoom, 1))", height: "calc((100vh - 24px) / var(--rdir-zoom, 1))" }
            : { width: "calc(min(1400px, 96vw) / var(--rdir-zoom, 1))", height: "calc(80vh / var(--rdir-zoom, 1))" }
        }
      >
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <FileDiff className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-semibold">{titleOf(source)}</span>
            {same && !loading && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                两个文件相同
              </span>
            )}
            {lossy && (
              <span
                className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-500"
                title={`文件按 ${encoding === "utf-8" ? "UTF-8" : encoding.toUpperCase()} 解码存在无效字节（可能选错了编码），已按替换符显示；此侧禁止编辑，避免把替换符写回文件`}
              >
                <TriangleAlert className="h-3 w-3" /> 编码
              </span>
            )}
            {source.kind === "files" &&
              eols.left &&
              eols.right &&
              eols.left !== eols.right && (
                <span
                  className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-500"
                  title={`两侧行尾格式不同：左 ${EOL_LABEL[eols.left] ?? eols.left} · 右 ${EOL_LABEL[eols.right] ?? eols.right}。行级比对已按归一化换行处理，此差异不体现在上方行差异中`}
                >
                  <TriangleAlert className="h-3 w-3" /> 换行符 {EOL_LABEL[eols.left] ?? eols.left} ↔{" "}
                  {EOL_LABEL[eols.right] ?? eols.right}
                </span>
              )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMaximized((m) => !m)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={maximized ? `还原窗口（${maximizeHint}）` : `最大化（${maximizeHint}）`}
            >
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              onClick={requestClose}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 路径 + 统计 */}
        <div className="flex items-center gap-3 border-b px-4 py-1.5 text-[11px] text-muted-foreground">
          {source.kind === "files" && (
            <>
              <span className="min-w-0 truncate font-mono" title={leftLabel ?? undefined}>
                <span className="text-[10px]">左：</span>
                {leftLabel}
                {dirty.left && <span className="text-amber-500" title="左侧有未保存修改"> ●</span>}
              </span>
              <span className="min-w-0 truncate font-mono" title={rightLabel ?? undefined}>
                <span className="text-[10px]">右：</span>
                {rightLabel}
                {dirty.right && <span className="text-amber-500" title="右侧有未保存修改"> ●</span>}
              </span>
            </>
          )}
          {source.kind !== "files" && <span>共 {sections.length} 个文件段落</span>}
          {source.kind === "files" && (
            <label
              className="flex shrink-0 items-center gap-1"
              title="选择编码后，左右两侧同时按该编码重新解码并比较"
            >
              <span>编码</span>
              <select
                value={encoding}
                disabled={loading}
                onChange={(e) => changeEncoding(e.target.value)}
                className="rounded border bg-transparent px-1 py-0.5 tabular-nums hover:bg-accent disabled:opacity-50"
              >
                {ENCODINGS.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="ml-auto shrink-0 tabular-nums">
            <span className="text-emerald-600">+{stats.additions}</span>
            {" "}
            <span className="text-destructive">−{stats.deletions}</span>
          </span>
          <button
            onClick={() => setOnlyDiff((v) => !v)}
            disabled={stats.additions + stats.deletions === 0}
            title="仅显示有差异的部分"
            className={cn(
              "shrink-0 rounded border px-2 py-0.5 disabled:opacity-50",
              onlyDiff ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-foreground",
            )}
          >
            只看差异
          </button>
        </div>
        {coarse && (
          <div className="border-b bg-amber-500/5 px-4 py-1 text-[11px] text-amber-600 dark:text-amber-500">
            差异过大，已按整块替换粗略显示（未做行级对齐）
          </div>
        )}

        {/* 内容：纵向原生滚动；横向由双栏各自的裁剪 + 联动滚动条承担 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onWheel={(e) => {
              // 触摸板横向滑动 / Shift+滚轮（浏览器转成 deltaX）：与滚动条同一偏移
              if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) setHScroll(hScrollRef.current + e.deltaX);
            }}
          >
            {loading ? (
              <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {source.kind === "files" ? "正在读取并比较…" : "正在解析…"}
              </div>
            ) : error ? (
              <div className="p-4 text-xs text-destructive">{error}</div>
            ) : (
              <div className="text-xs">
                <div style={{ height: range.padTop }} />
                {items.slice(range.start, range.end).map((it, idx) => {
                  const key = `${range.start + idx}`;
                  if (it.type === "section") {
                    const s = sections[it.si];
                    return (
                      <div
                        key={key}
                        className="grid w-full grid-cols-[48px_1fr_48px_1fr] items-center border-y bg-muted/40 px-0 font-medium text-muted-foreground"
                        style={{ height: ROW_H }}
                      >
                        <span className="col-span-2 truncate px-2 font-mono" title={s.leftName}>
                          {s.leftName}
                        </span>
                        <span className="col-span-2 truncate px-2 font-mono" title={s.rightName}>
                          {s.rightName}
                        </span>
                      </div>
                    );
                  }
                  if (it.type === "gap") {
                    return (
                      <button
                        key={key}
                        onClick={() => expandGap(it.id)}
                        className="flex w-full items-center justify-center gap-1 bg-muted/20 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        style={{ height: ROW_H }}
                      >
                        ⋯ 已折叠 {it.count} 行相同 — 点击展开
                      </button>
                    );
                  }
                  const row = it.row;
                  const hunk = hunks.get(range.start + idx);
                  return (
                    <div
                      key={key}
                      className="group/row relative grid w-full grid-cols-[48px_1fr_48px_1fr] items-start"
                      style={{ height: ROW_H }}
                    >
                      {renderGutter(row, it.rowIdx, "left")}
                      {renderCell(row, it.rowIdx, "left")}
                      {renderGutter(row, it.rowIdx, "right")}
                      {renderCell(row, it.rowIdx, "right")}
                      {/* 中轴补丁：悬停差异块显示，把一侧应用到另一侧（vimdiff do/dp） */}
                      {filesMode && hunk && (
                        <div className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-px rounded-sm border border-border/60 bg-background/90 p-px opacity-0 shadow-sm group-hover/row:opacity-100">
                          <button
                            data-patch="l2r"
                            className={cn(gutterBtn, "w-4 disabled:opacity-30")}
                            disabled={!sideEditable("right")}
                            title="应用到右侧：此差异块以左侧为准（右侧记为未保存）"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyHunk(hunk.s, hunk.e, "l2r")}
                          >
                            <ArrowRightToLine className="h-3 w-3" />
                          </button>
                          <button
                            data-patch="r2l"
                            className={cn(gutterBtn, "w-4 disabled:opacity-30")}
                            disabled={!sideEditable("left")}
                            title="应用到左侧：此差异块以右侧为准（左侧记为未保存）"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyHunk(hunk.s, hunk.e, "r2l")}
                          >
                            <ArrowLeftToLine className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{ height: range.padBottom }} />
              </div>
            )}
          </div>
          {/* 双横向滚动条：同一偏移，拖/点任意一条两侧同步 */}
          {maxScroll > 0 && !loading && !error && (
            <div className="grid shrink-0 grid-cols-[48px_1fr_48px_1fr] items-center border-t bg-muted/20 py-1 text-xs">
              <div />
              <HScrollBar side="left" value={hScroll} max={maxScroll} onChange={setHScroll} />
              <div className="flex items-center justify-center">
                <GripVertical className="h-3 w-3 text-muted-foreground/40" />
              </div>
              <HScrollBar side="right" value={hScroll} max={maxScroll} onChange={setHScroll} />
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <span className="text-[11px] text-muted-foreground">
            行高亮：红 = 左侧（删除），绿 = 右侧（新增）
            {filesMode && " · 悬停行号可编辑/插入/删除，双击单元格编辑，中轴按钮可按块应用一侧"}
          </span>
          {saveNote && (
            <span
              className={cn(
                "shrink-0 text-[11px]",
                saveNote.err ? "text-destructive" : "text-emerald-600",
              )}
            >
              {saveNote.text}
            </span>
          )}
          {filesMode && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={!anyDirty || saving}
                onClick={discardEdits}
                title="丢弃未保存的编辑，重新从磁盘读取"
              >
                放弃修改
              </Button>
              <Button
                size="sm"
                disabled={!anyDirty || saving}
                onClick={() => void saveAll()}
                title={
                  lossy
                    ? "存在解码有损的一侧，已禁编辑；仅无损侧可保存"
                    : !anyDirty
                      ? "无修改"
                      : "把编辑写入左侧/右侧文件（SFTP 侧自动回传覆盖）"
                }
              >
                {saving ? "保存中…" : "保存修改"}
              </Button>
            </>
          )}
          {!filesMode && <Button size="sm" className="ml-auto" onClick={requestClose}>关闭</Button>}
          {filesMode && (
            <Button size="sm" variant="outline" onClick={requestClose}>
              关闭
            </Button>
          )}
        </div>
      </div>

      {confirmReq && (
        <div className="relative z-[90]">
          <AppConfirmDialog
            req={confirmReq}
            onConfirm={() => {
              const fn = confirmActionRef.current;
              setConfirmReq(null);
              fn();
            }}
            onCancel={() => setConfirmReq(null)}
          />
        </div>
      )}
    </div>
  );
}
