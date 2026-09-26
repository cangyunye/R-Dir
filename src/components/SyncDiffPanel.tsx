import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  FolderPlus,
  GitCompare,
  Link2,
  Link2Off,
  Loader2,
  Undo2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { basename, formatSize } from "@/lib/format";
import type { DiffEntry } from "@/lib/types";
import type { DiffMark, LinkAlignment, SyncLink } from "@/lib/sync-link";

/** 行首色条与方位点标配色（仅左=琥珀 / 仅右=天蓝 / 不同=红） */
export const MARK_COLORS = {
  "left-only": "#f59e0b",
  "right-only": "#0ea5e9",
  different: "#ef4444",
} as const;

export function markColor(mark: DiffMark): string {
  return MARK_COLORS[mark.status];
}

export function markTooltip(mark: DiffMark): string {
  switch (mark.status) {
    case "left-only":
      return "仅左侧有此条目";
    case "right-only":
      return "仅右侧有此条目";
    default:
      if (mark.reason === "type") return "类型不同（一侧为文件夹）";
      if (mark.reason === "size") {
        return `两侧大小不同（左 ${formatSize(mark.leftSize ?? 0)} · 右 ${formatSize(mark.rightSize ?? 0)}）`;
      }
      return "两侧内容不同";
  }
}

function statusLabel(e: DiffEntry): { text: string; className: string } {
  switch (e.status) {
    case "left-only":
      return { text: "仅左侧", className: "text-amber-600 dark:text-amber-400" };
    case "right-only":
      return { text: "仅右侧", className: "text-sky-600 dark:text-sky-400" };
    case "same":
      return { text: "相同", className: "text-muted-foreground" };
    default:
      if (e.reason === "type") return { text: "类型不同", className: "text-red-600 dark:text-red-400" };
      return { text: "不同", className: "text-red-600 dark:text-red-400" };
  }
}

/** 侧路径缩略:方位点标 + 末段名 */
function SideChip({ side, path }: { side: "left" | "right"; path: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs" title={path}>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: side === "left" ? MARK_COLORS["left-only"] : MARK_COLORS["right-only"] }}
      />
      <span className="max-w-52 truncate">{basename(path) || path}</span>
    </span>
  );
}

export type SyncDiffStatus = "running" | "done" | "cancelled" | "error";

/** 状态栏摘要段的数据(不感知比对细节) */
export interface SyncDiffSummary {
  status: SyncDiffStatus;
  total: number;
  diffCount: number;
  diverged: boolean;
  error?: string | null;
}

/** v0.18.2 状态栏摘要段:实时显示比对概况,点击打开结果模态 */
export function SyncDiffStatusBar({
  summary,
  onOpen,
}: {
  summary: SyncDiffSummary;
  onOpen: () => void;
}) {
  const tone =
    summary.status === "error" ? "error" : summary.diverged ? "warn" : "ok";
  const text =
    summary.status === "running"
      ? "比对中…"
      : summary.status === "error"
        ? "比对失败"
        : summary.status === "cancelled"
          ? "已取消"
          : summary.diverged
            ? `未对齐 · ${summary.total} 项`
            : summary.diffCount > 0
              ? `${summary.total} 项 · ${summary.diffCount} 差异`
              : `${summary.total} 项 · 一致`;
  return (
    <button
      data-sync-diff-status={tone}
      onClick={onOpen}
      title="查看同步比对结果（Ctrl+Shift+X）"
      className={cn(
        "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted",
        tone === "error" && "border-red-500/40 text-red-600 dark:text-red-400",
        tone === "warn" && "border-amber-500/40 text-amber-700 dark:text-amber-400",
      )}
    >
      {summary.status === "running" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : (
        <Link2 className="h-3 w-3 shrink-0" />
      )}
      <span className="max-w-44 truncate">{text}</span>
    </button>
  );
}

export interface SyncDiffModalProps {
  open: boolean;
  link: SyncLink;
  leftPath: string;
  rightPath: string;
  alignment: LinkAlignment;
  status: SyncDiffStatus;
  entries: DiffEntry[] | null;
  error?: string | null;
  /** 未对齐时「在对侧新建并进入」是否可用（对侧 canMkdir） */
  canCreateMissing: boolean;
  onRealign: () => void;
  onSwap: () => void;
  onCreateMissing: () => void;
  onReturnAlign: () => void;
  onUnlink: () => void;
  /** v0.19 双击/点图标对两侧同名文件直接文本比较（免基准）；左右路径取条目自带的完整路径 */
  onCompare?: (left: string, right: string, name: string) => void;
  onClose: () => void;
}

const GRID_COLS = "minmax(0,1fr) 130px 130px 100px";

/** v0.18.2 同步比对结果模态:按需打开,实时更新;Esc/遮罩空白/X 关闭 */
export function SyncDiffModal({
  open,
  link,
  leftPath,
  rightPath,
  alignment,
  status,
  entries,
  error,
  canCreateMissing,
  onRealign,
  onSwap,
  onCreateMissing,
  onReturnAlign,
  onUnlink,
  onCompare,
  onClose,
}: SyncDiffModalProps) {
  const [onlyDiff, setOnlyDiff] = useState(false);

  // Esc 关闭(捕获阶段,与 SettingsDialog 同模式)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const rows = useMemo(() => {
    if (!entries) return [];
    return onlyDiff ? entries.filter((e) => e.status !== "same") : entries;
  }, [entries, onlyDiff]);

  if (!open) return null;

  const aligned = alignment.state === "aligned";
  const missingText =
    alignment.state === "diverged" && alignment.outsideRoot
      ? "一侧已离开链接根目录"
      : alignment.state === "diverged" && alignment.missing
        ? `两侧不同层：${alignment.missingSide === "left" ? "右侧" : "左侧"}无 "${alignment.missing}"`
        : null;
  const canReturn = alignment.state === "diverged" && !!alignment.missingSide;
  const canCreate =
    alignment.state === "diverged" && !!alignment.missing && canCreateMissing;

  const statusText =
    status === "running"
      ? "比对中…"
      : status === "error"
        ? "比对失败"
        : status === "cancelled"
          ? "已取消"
          : `${entries?.length ?? 0} 项`;

  return (
    <div
      data-sync-diff-modal=""
      data-link-tab={link.tabId}
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        style={{
          width: "calc(min(720px, 94vw) / var(--rdir-zoom, 1))",
          height: "calc(min(600px, 85vh) / var(--rdir-zoom, 1))",
        }}
      >
        {/* 头部 */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-sm font-semibold">同步比对</span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium",
              aligned
                ? "bg-green-500/15 text-green-700 dark:text-green-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
            )}
          >
            {aligned ? "已对齐" : "未对齐"}
          </span>
          <SideChip side="left" path={leftPath} />
          <span className="text-[10px] text-muted-foreground">⇄</span>
          <SideChip side="right" path={rightPath} />
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            {status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
            {status === "error" && (
              <span className="text-red-600 dark:text-red-400">
                {statusText}
                {error ? `：${error}` : ""}
              </span>
            )}
            {status !== "error" && statusText}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onClose}
            title="关闭（Esc）"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 未对齐横幅 */}
        {missingText && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{missingText}，更深层暂不比对。</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {canCreate && (
                <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onCreateMissing}>
                  <FolderPlus className="mr-1 h-3 w-3" /> 在对侧新建并进入
                </Button>
              )}
              {canReturn && (
                <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onReturnAlign}>
                  返回对齐
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onUnlink}>
                断开链接
              </Button>
            </span>
          </div>
        )}

        {/* 工具行 */}
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 px-2 text-xs", onlyDiff && "bg-accent text-accent-foreground")}
            onClick={() => setOnlyDiff((v) => !v)}
            title="只显示存在差异的条目"
          >
            只看差异
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onSwap} title="交换左右方位后重算">
            <ArrowLeftRight className="mr-1 h-3 w-3" /> 交换左右
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onRealign} title="两侧跳回链接锚点">
            <Undo2 className="mr-1 h-3 w-3" /> 重新对齐
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs text-red-600 hover:text-red-700 dark:text-red-400"
            onClick={onUnlink}
            title="断开链接并关闭面板"
          >
            <Link2Off className="mr-1 h-3 w-3" /> 断开链接
          </Button>
        </div>

        {/* 条目列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="sticky top-0 grid items-center border-b bg-muted/40 text-[11px] font-medium text-muted-foreground"
            style={{ gridTemplateColumns: GRID_COLS }}
          >
            <span className="px-2 py-1">名称</span>
            <span className="px-2 py-1 text-right">左大小</span>
            <span className="px-2 py-1 text-right">右大小</span>
            <span className="px-2 py-1">状态</span>
          </div>
          {rows.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {status === "running" ? "正在比对…" : entries && entries.length > 0 ? "没有差异条目" : "（空目录）"}
            </div>
          ) : (
            rows.map((e) => {
              const st = statusLabel(e);
              // v0.19 两侧都存在且都是文件 → 可直接同名文本比较（免基准）
              const comparable =
                !!onCompare &&
                !!e.left &&
                !!e.right &&
                !e.is_dir &&
                !e.left.is_dir &&
                !e.right.is_dir;
              return (
                <div
                  key={`${e.name}:${e.left?.path ?? ""}:${e.right?.path ?? ""}`}
                  className="group grid items-center border-b text-xs hover:bg-muted/40"
                  style={{ gridTemplateColumns: GRID_COLS }}
                  title={
                    comparable
                      ? "双击直接文本比较两侧同名文件"
                      : e.left?.path && e.right?.path
                        ? `${e.left.path} ⇄ ${e.right.path}`
                        : e.left?.path ?? e.right?.path
                  }
                  onDoubleClick={() => {
                    if (comparable) onCompare!(e.left!.path, e.right!.path, e.name);
                  }}
                >
                  <span className={cn("truncate px-2 py-1", e.is_dir && "font-medium")}>{e.name}</span>
                  <span className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {e.left ? (e.left.is_dir ? "—" : formatSize(e.left.size)) : "—"}
                  </span>
                  <span className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {e.right ? (e.right.is_dir ? "—" : formatSize(e.right.size)) : "—"}
                  </span>
                  <span className={cn("flex items-center gap-1 px-2 py-1", st.className)}>
                    {st.text}
                    {comparable && (
                      <button
                        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-70"
                        title="文本比较这两个文件"
                        onClick={() => onCompare!(e.left!.path, e.right!.path, e.name)}
                      >
                        <GitCompare className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
