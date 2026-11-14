import type { RefObject } from "react";
import { CornerDownRight } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { useT } from "@/lib/LanguageProvider";
import type { FileEntry } from "@/lib/types";

/**
 * 拖拽拖影（v0.49 特性4）：Explorer 式堆叠卡 + 数量徽章 + 落点行。
 * - 位置仍由 useDragRubberBand 经 ghostRef 命令式 transform 驱动（逐帧不进 React）；
 * - 内容由引擎 onDragActiveChange 的状态渲染（仅起拖/操作切换/结束时重渲染，
 *   逐帧链路零开销）；dropDir = 当前悬停的文件夹名（仅 IconGrid 引擎 A 会命中，
 *   FileList 引擎 A 不解析目录落点恒传 null，不给误导反馈）。
 * - data-drag-ghost：e2e 定位锚（旧实现靠「复制 N 项」文案匹配，内容升级后改锚点）。
 * - 容器挂 transition opacity var(--rdir-anim-dur)：雅=透明度平滑显隐，素=瞬时。
 */
export function DragGhost({
  ghostRef,
  paths,
  op,
  entries,
  dropDir = null,
}: {
  ghostRef: RefObject<HTMLDivElement | null>;
  paths: string[];
  op: "copy" | "move";
  /** 本窗格条目（引擎 A 拖拽候选恒来自本窗格目录，按路径回查元数据） */
  entries: FileEntry[];
  /** 悬停文件夹名（目录落点确认行）；null = 无目录落点 */
  dropDir?: string | null;
}) {
  const t = useT();
  const shown = paths
    .slice(0, 3)
    .map((p) => entries.find((e) => e.path === p))
    .filter((e): e is FileEntry => !!e);
  const primary = shown[0];
  return (
    <div
      ref={ghostRef}
      data-drag-ghost=""
      className="pointer-events-none fixed left-0 top-0 z-50 opacity-0 [transition:opacity_var(--rdir-anim-dur)_linear]"
      style={{ transform: "translate(0px, 0px)" }}
    >
      {/* 堆叠层留位：pl/pt 给后层卡片偏移，主卡盖在其上 */}
      <div className="relative pl-1.5 pt-1.5">
        {shown.slice(1, 3).map((e, i) => (
          <div
            key={e.path}
            aria-hidden
            className="absolute left-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md border bg-popover/90 shadow-elevate"
            style={{ transform: `translate(${6 * (i + 1)}px, ${6 * (i + 1)}px)` }}
          >
            <FileIcon entry={e} size={16} />
          </div>
        ))}
        <div className="relative flex max-w-56 items-center gap-1.5 rounded-md border bg-popover px-2 py-1.5 shadow-elevate">
          {primary && <FileIcon entry={primary} size={18} className="shrink-0" />}
          <span className="min-w-0 truncate text-xs">{primary ? primary.name : "…"}</span>
          {paths.length > 1 && (
            <span className="ml-0.5 flex shrink-0 items-center gap-1">
              <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground">
                {paths.length}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {op === "move" ? t("移动") : t("复制")}
              </span>
            </span>
          )}
        </div>
        {dropDir && (
          <div className="mt-1 flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary shadow-elevate backdrop-blur-sm">
            <CornerDownRight className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {op === "move"
                ? t("移动到「{name}」", { name: dropDir })
                : t("复制到「{name}」", { name: dropDir })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
