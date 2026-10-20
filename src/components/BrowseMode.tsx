/**
 * 图文浏览模式（v0.28.0）：目录内图片/文档的沉浸式浏览。
 * - 覆盖侧边栏+文件区（挂内容行容器 absolute inset-0，工具栏/状态栏保留），暗色背景
 * - 中央：PreviewBody 复用（图片大图 / 文本卡 / 文档首页缩略图卡）
 * - 底部缩略图条：图片 = ThumbImage 懒加载卡；文档/文本 = 图标+文件名小卡；
 *   只收录可预览类型，排序与列表一致（sortEntries），当前项高亮并滚动居中
 * - 键盘（capture 捕获，先于 App 全局分发）：←/→/↑/↓ 切换、Home/End、
 *   Enter 外部打开、ESC 退出；导航即选中（onNavigate → 窗格 selection），三方同步
 */
import { useEffect, useMemo, useRef } from "react";
import { ExternalLink, X } from "lucide-react";
import { FileIcon } from "@/components/FileIcon";
import { ThumbImage } from "@/components/ThumbImage";
import { PreviewBody } from "@/components/preview/PreviewBody";
import { sortEntries } from "@/lib/entry-sort";
import { isPreviewable, previewKindOf } from "@/lib/preview";
import { cn } from "@/lib/utils";
import type { FileEntry, SortDir, SortKey } from "@/lib/types";

export function BrowseMode({
  entries,
  sortKey,
  sortDir,
  showHidden,
  primaryPath,
  onNavigate,
  onClose,
  onOpenExternal,
}: {
  /** 焦点窗格原始条目（未排序） */
  entries: FileEntry[];
  sortKey: SortKey;
  sortDir: SortDir;
  showHidden: boolean;
  /** 焦点窗格主选中（selection[0] ?? null） */
  primaryPath: string | null;
  /** 导航即选中：把 path 设为窗格选中 */
  onNavigate: (path: string) => void;
  onClose: () => void;
  onOpenExternal: (path: string) => void;
}) {
  const list = useMemo(
    () => sortEntries(entries, sortKey, sortDir, showHidden).filter(isPreviewable),
    [entries, sortKey, sortDir, showHidden],
  );
  const index = Math.max(
    0,
    list.findIndex((e) => e.path === primaryPath),
  );
  const current: FileEntry | null = list[index] ?? null;
  const stripRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  // 当前项滚动居中
  useEffect(() => {
    tileRefs.current[index]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [index]);

  // 键盘导航（capture，避免落回全局快捷键分发，如 ESC=取消选择）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = (d: number) => {
        if (list.length === 0) return;
        const next = Math.min(list.length - 1, Math.max(0, index + d));
        if (next !== index) onNavigate(list[next].path);
      };
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          step(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          step(-1);
          break;
        case "Home":
          e.preventDefault();
          e.stopPropagation();
          if (list.length > 0) onNavigate(list[0].path);
          break;
        case "End":
          e.preventDefault();
          e.stopPropagation();
          if (list.length > 0) onNavigate(list[list.length - 1].path);
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (current) onOpenExternal(current.path);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [list, index, current, onNavigate, onOpenExternal, onClose]);

  // 缩略图条纵向滚轮 → 横向滚动（React 合成 wheel 是 passive，需原生监听）
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [list.length]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-black/90 text-zinc-100" data-testid="browse-mode">
      {/* 顶栏：文件名 + 序号 + 操作 */}
      <header className="flex shrink-0 items-center gap-3 px-4 py-2.5">
        {current && <FileIcon entry={current} size={16} />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={current?.path}>
          {current?.name ?? "当前目录没有可预览的图片或文档"}
        </span>
        <span className="shrink-0 font-mono text-xs text-zinc-400" data-testid="browse-counter">
          {list.length > 0 ? `${index + 1} / ${list.length}` : "0 / 0"}
        </span>
        <button
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/20 px-2 py-1 text-xs transition-colors hover:bg-white/10 disabled:opacity-40"
          disabled={!current}
          onClick={() => current && onOpenExternal(current.path)}
        >
          <ExternalLink className="h-3.5 w-3.5" /> 外部打开
        </button>
        <button
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/20 px-2 py-1 text-xs transition-colors hover:bg-white/10"
          onClick={onClose}
          title="退出（Esc）"
        >
          <X className="h-3.5 w-3.5" /> 退出
        </button>
      </header>

      {/* 中央内容（文本包浅色卡保证任何主题下可读） */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {current && previewKindOf(current) === "text" ? (
          <div className="mx-auto h-full w-full max-w-4xl p-4">
            <div className="h-full overflow-hidden rounded-lg bg-background shadow-xl">
              <PreviewBody entry={current} onOpenExternal={onOpenExternal} />
            </div>
          </div>
        ) : (
          <PreviewBody entry={current} onOpenExternal={onOpenExternal} />
        )}
      </div>

      {/* 底部横向缩略图条 */}
      <footer className="shrink-0 border-t border-white/10 px-3 py-2">
        <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {list.map((e, i) => {
            const active = i === index;
            const kind = previewKindOf(e);
            return (
              <button
                key={e.path}
                ref={(el) => {
                  tileRefs.current[i] = el;
                }}
                onClick={() => onNavigate(e.path)}
                className={cn(
                  "relative shrink-0 overflow-hidden rounded-md border transition-all",
                  kind === "image" ? "h-16 w-20" : "h-16 w-24 px-1.5",
                  active
                    ? "border-primary ring-2 ring-primary ring-offset-1 ring-offset-black/90"
                    : "border-white/15 opacity-70 hover:opacity-100",
                )}
                title={e.name}
              >
                {kind === "image" ? (
                  <ThumbImage
                    path={e.path}
                    mtime={e.modified}
                    size={144}
                    className="h-full w-full"
                    fallback={<FileIcon entry={e} size={22} />}
                  />
                ) : (
                  <span className="flex h-full w-full flex-col items-center justify-center gap-1 bg-background/95 text-foreground">
                    <FileIcon entry={e} size={20} />
                    <span className="line-clamp-2 w-full break-all text-center text-[9px] leading-tight">
                      {e.name}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="pt-1 text-center text-[10px] text-zinc-500">
          ← → 切换 · Home/End 首尾 · Enter 外部打开 · Esc 退出（滚轮/拖拽横移缩略图条）
        </div>
      </footer>
    </div>
  );
}
