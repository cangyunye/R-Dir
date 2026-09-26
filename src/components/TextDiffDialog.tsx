import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDiff, Loader2, Maximize2, Minimize2, TriangleAlert, X } from "lucide-react";
import { diffTextFiles, readTextFile } from "@/lib/api";
import {
  buildDisplayItems,
  parseUnifiedDiff,
  rowsFromSegments,
  rowsStats,
  type DiffRow,
} from "@/lib/text-diff";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 文本比较的来源：任意两侧文件 / 粘贴的 diff 文本 / .patch 文件 */
export type TextDiffSource =
  | { kind: "files"; left: string; right: string; leftLabel?: string; rightLabel?: string }
  | { kind: "patchText"; text: string; title?: string }
  | { kind: "patchFile"; path: string };

interface Section {
  leftName: string;
  rightName: string;
  rows: DiffRow[];
}

/** 与 FileList 的虚拟滚动解耦：diff 行高独立（含表头/间隙统一行高） */
const ROW_H = 24;
const BUFFER = 8;

type Item =
  | { type: "section"; si: number }
  | { type: "row"; row: DiffRow }
  | { type: "gap"; id: string; count: number };

function titleOf(source: TextDiffSource): string {
  if (source.kind === "files") return "文本比较";
  if (source.kind === "patchText") return source.title ?? "Git Diff（粘贴导入）";
  return "Git Diff";
}

/**
 * 文本差异窗口（v0.19）：左右双栏 + 行号，del 红 / add 绿，
 * 长相同段折叠（±3 行上下文，点击展开），支持只看差异。
 * 文件模式与 patch 解析模式共用本渲染器。
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
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setExpanded(new Set());
    setScrollTop(0);
    const load = async () => {
      try {
        if (source.kind === "files") {
          const out = await diffTextFiles(source.left, source.right);
          if (!alive) return;
          setSections([
            {
              leftName: source.leftLabel ?? out.left.path,
              rightName: source.rightLabel ?? out.right.path,
              rows: rowsFromSegments(out.segments),
            },
          ]);
          setStats({ additions: out.additions, deletions: out.deletions });
          setSame(out.same);
          setCoarse(out.coarse);
          setLossy(out.left.lossy || out.right.lossy);
        } else {
          const text =
            source.kind === "patchText" ? source.text : (await readTextFile(source.path)).text;
          if (!alive) return;
          const parsed = parseUnifiedDiff(text);
          if (parsed.length === 0) {
            throw new Error("未识别出 diff 内容（需要 unified diff 格式：git diff 输出或 .patch 文件）");
          }
          setSections(parsed.map((s) => ({ leftName: s.leftName, rightName: s.rightName, rows: s.rows })));
          const total = parsed.reduce(
            (acc, s) => {
              const st = rowsStats(s.rows);
              return { additions: acc.additions + st.additions, deletions: acc.deletions + st.deletions };
            },
            { additions: 0, deletions: 0 },
          );
          setStats(total);
          setSame(total.additions === 0 && total.deletions === 0);
          setCoarse(false);
          setLossy(false);
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 视口高度（虚拟滚动窗口）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, [loading]);

  /** 展示项：段落头 + 折叠上下文后的行 */
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    sections.forEach((s, si) => {
      out.push({ type: "section", si });
      for (const it of buildDisplayItems(s.rows, {
        expanded,
        onlyDiff,
        idPrefix: `${si}:`,
      })) {
        if (it.type === "row") out.push({ type: "row", row: it.row });
        else out.push({ type: "gap", id: it.id, count: it.count });
      }
    });
    return out;
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
    const end = Math.min(items.length, Math.ceil((scrollTop + viewportH) / ROW_H) + BUFFER);
    return { start, end, padTop: start * ROW_H, padBottom: Math.max(0, items.length - end) * ROW_H };
  }, [items, scrollTop, viewportH]);

  const leftLabel = source.kind === "files" ? (source.leftLabel ?? source.left) : null;
  const rightLabel = source.kind === "files" ? (source.rightLabel ?? source.right) : null;

  const cellCls = (side: "left" | "right", row: DiffRow) => {
    const active =
      side === "left"
        ? row.kind === "del" || row.kind === "pair"
        : row.kind === "add" || row.kind === "pair";
    return cn(
      "px-2 font-mono text-[11px] leading-6 whitespace-pre",
      active && (side === "left" ? "bg-destructive/15" : "bg-emerald-500/15"),
      !active && row.kind !== "eq" && "text-muted-foreground/30",
    );
  };

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        style={
          maximized
            ? { width: "calc((100vw - 24px) / var(--rdir-zoom, 1))", height: "calc((100vh - 24px) / var(--rdir-zoom, 1))" }
            : { width: "calc(min(1080px, 95vw) / var(--rdir-zoom, 1))", height: "calc(80vh / var(--rdir-zoom, 1))" }
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
                title="文件含非 UTF-8 字节（如 GBK 编码），已按替换符显示，比对结果仅供参考"
              >
                <TriangleAlert className="h-3 w-3" /> 编码
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMaximized((m) => !m)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={maximized ? "还原窗口" : "最大化"}
            >
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              onClick={onClose}
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
              </span>
              <span className="min-w-0 truncate font-mono" title={rightLabel ?? undefined}>
                <span className="text-[10px]">右：</span>
                {rightLabel}
              </span>
            </>
          )}
          {source.kind !== "files" && <span>共 {sections.length} 个文件段落</span>}
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

        {/* 内容 */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {source.kind === "files" ? "正在读取并比较…" : "正在解析…"}
            </div>
          ) : error ? (
            <div className="p-4 text-xs text-destructive">{error}</div>
          ) : (
            <div className="min-w-max text-xs">
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
                return (
                  <div
                    key={key}
                    className="grid w-full grid-cols-[48px_1fr_48px_1fr] items-start"
                    style={{ height: ROW_H }}
                  >
                    <span
                      className={cn(
                        "select-none border-r px-1 text-right font-mono text-[10px] leading-6 text-muted-foreground/70 tabular-nums",
                        row.left ? "" : "bg-muted/10",
                      )}
                    >
                      {row.left?.no ?? ""}
                    </span>
                    <span className={cellCls("left", row)}>{row.left?.text ?? ""}</span>
                    <span
                      className={cn(
                        "select-none border-r px-1 text-right font-mono text-[10px] leading-6 text-muted-foreground/70 tabular-nums",
                        row.right ? "" : "bg-muted/10",
                      )}
                    >
                      {row.right?.no ?? ""}
                    </span>
                    <span className={cellCls("right", row)}>{row.right?.text ?? ""}</span>
                  </div>
                );
              })}
              <div style={{ height: range.padBottom }} />
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <span className="text-[11px] text-muted-foreground">
            行高亮：红 = 左侧（删除），绿 = 右侧（新增）
          </span>
          <Button size="sm" className="ml-auto" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
