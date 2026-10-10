import { useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSize, formatTime } from "@/lib/format";
import { FileIcon } from "./FileIcon";
import type { FileEntry } from "@/lib/types";

export interface QuickJumpRow {
  entry: FileEntry;
  /** 命中字符下标（升序，针对 entry.name，UTF-16 code unit） */
  positions: number[];
}

export interface QuickJumpProps {
  query: string;
  rows: QuickJumpRow[];
  activeIndex: number;
  totalMatches: number;
  onQueryChange: (query: string) => void;
  onMove: (delta: 1 | -1) => void;
  onConfirm: () => void;
  onHover: (index: number) => void;
  onActivate: (index: number) => void;
  onCancel: () => void;
  onOutsideDown: () => void;
}

/** 高亮匹配字符。positions 与 fuzzyMatch 同为 UTF-16 code unit 口径，故用 split("") 对齐。 */
function Highlight({
  text,
  positions,
  active,
}: {
  text: string;
  positions: number[];
  active: boolean;
}) {
  const set = new Set(positions);
  return (
    <>
      {text.split("").map((ch, i) =>
        set.has(i) ? (
          <span
            key={i}
            className={cn(
              "font-semibold",
              active ? "text-primary-foreground underline" : "text-primary",
            )}
          >
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

/**
 * 快速定位玻璃浮层（受控）。仅负责外观 + 匹配高亮 + 事件转发，
 * 不持有业务状态、不直接操作文件列表。
 */
export function QuickJump({
  query,
  rows,
  activeIndex,
  totalMatches,
  onQueryChange,
  onMove,
  onConfirm,
  onHover,
  onActivate,
  onCancel,
  onOutsideDown,
}: QuickJumpProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即聚焦隐藏输入：获得退格 / 粘贴 / 中文 IME 的原生支持
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      data-quickjump-backdrop=""
      className="absolute inset-0 z-30"
      onMouseDown={onOutsideDown}
    >
      <div
        data-quickjump=""
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-[6%] flex w-[min(560px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-white/15 bg-background/70 shadow-2xl ring-1 ring-black/5 backdrop-blur-xl backdrop-saturate-150 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150 motion-reduce:animate-none dark:border-white/10 dark:ring-white/10"
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            data-quickjump-input=""
            aria-label="快速定位查询"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                onMove(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                onMove(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                onConfirm();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
            className="sr-only"
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {query || <span className="text-muted-foreground">输入以筛选…</span>}
          </span>
        </div>

        <div className="max-h-[min(60vh,392px)] overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              无匹配项
            </div>
          ) : (
            rows.map((row, i) => {
              const active = i === activeIndex;
              return (
                <div
                  key={row.entry.path}
                  data-quickjump-row={i}
                  data-quickjump-active={active ? "true" : undefined}
                  onMouseEnter={() => onHover(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onActivate(i);
                  }}
                  className={cn(
                    "flex cursor-default items-center gap-2 px-3 py-1.5 text-[13px]",
                    active ? "bg-primary/90 text-primary-foreground" : "hover:bg-muted/60",
                  )}
                >
                  <FileIcon entry={row.entry} size={16} className="shrink-0" />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      row.entry.is_dir && "font-medium",
                    )}
                  >
                    <Highlight text={row.entry.name} positions={row.positions} active={active} />
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {row.entry.is_dir ? "—" : formatSize(row.entry.size)}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {formatTime(row.entry.modified)}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>{totalMatches} 项匹配</span>
          <span>↑↓ 选择 · ↵ 定位/进入 · Esc 取消</span>
        </div>
      </div>
    </div>
  );
}
