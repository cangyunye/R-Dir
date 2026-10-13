/**
 * 预览栏（v0.28.0）：右侧覆盖式拉门，悬浮在内容区上方（不挤压分屏布局）。
 * - 展开面板：头部（图标+文件名+收起）+ 内容（PreviewBody 按类型分发）+ 底部操作条
 * - 收起：贴边细把手（点击或 空格 拉出）
 * - 左缘拖拽调宽（280–720，App 持久化）；开合 transform 200ms
 * 挂载点：内容行容器（relative），故 top/bottom 自动落在工具栏与状态栏之间。
 */
import { useRef } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, GalleryVertical } from "lucide-react";
import { FileIcon } from "@/components/FileIcon";
import { PreviewBody } from "@/components/preview/PreviewBody";
import { PREVIEW_WIDTH_MAX, PREVIEW_WIDTH_MIN } from "@/lib/persist";
import { cn } from "@/lib/utils";
import type { FileEntry } from "@/lib/types";

export function PreviewDrawer({
  entry,
  enabled,
  expanded,
  width,
  canBrowse,
  onExpand,
  onCollapse,
  onWidthChange,
  onBrowse,
  onOpenExternal,
}: {
  /** 焦点窗格主选中（null = 占位提示） */
  entry: FileEntry | null;
  enabled: boolean;
  expanded: boolean;
  width: number;
  /** 当前目录存在可预览条目时才可进入浏览模式 */
  canBrowse: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onWidthChange: (width: number) => void;
  onBrowse: () => void;
  onOpenExternal: (path: string) => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  if (!enabled) return null;

  const startResize = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: width };
  };
  const onResize = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 左缘向左拖 = 变宽
    const next = d.startWidth + (d.startX - e.clientX);
    onWidthChange(Math.min(PREVIEW_WIDTH_MAX, Math.max(PREVIEW_WIDTH_MIN, next)));
  };
  const endResize = () => {
    dragRef.current = null;
  };

  return (
    <>
      {/* 收起态：贴边把手 */}
      {!expanded && (
        <button
          data-testid="preview-handle"
          onClick={onExpand}
          title="展开预览栏（空格）"
          className="absolute right-0 top-1/2 z-40 flex h-16 w-5 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 bg-background/90 text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}

      {/* 拉门面板（收起时平移出视口，保留 200ms 滑动动画） */}
      <div
        data-testid="preview-drawer"
        className={cn(
          "absolute bottom-0 right-0 top-0 z-40 flex flex-col border-l bg-background/95 shadow-2xl backdrop-blur-sm transition-transform duration-200 ease-out",
          expanded ? "translate-x-0" : "translate-x-full",
        )}
        style={{ width }}
        aria-hidden={!expanded}
      >
        {/* 左缘拖宽手柄 */}
        <div
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-ew-resize transition-colors hover:bg-primary/40"
          onPointerDown={startResize}
          onPointerMove={onResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          title="拖拽调宽"
        />

        {/* 头部 */}
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          {entry ? (
            <>
              <FileIcon entry={entry} size={16} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={entry.path}>
                {entry.name}
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">预览</span>
          )}
          <button
            onClick={onCollapse}
            title="收起（空格）"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </header>

        {/* 内容 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <PreviewBody entry={entry} />
        </div>

        {/* 底部操作条 */}
        <footer className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
          <button
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!entry || entry.is_dir}
            onClick={() => entry && onOpenExternal(entry.path)}
          >
            <ExternalLink className="h-3.5 w-3.5" /> 外部打开
          </button>
          <button
            data-testid="preview-browse-btn"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canBrowse}
            title={canBrowse ? "图文浏览模式（mod+shift+e）" : "当前目录没有可预览的图片或文档"}
            onClick={onBrowse}
          >
            <GalleryVertical className="h-3.5 w-3.5" /> 浏览 »
          </button>
        </footer>
      </div>
    </>
  );
}
