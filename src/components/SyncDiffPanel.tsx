import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  FolderPlus,
  Link2,
  Link2Off,
  Loader2,
  Undo2,
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
      <span className="max-w-40 truncate">{basename(path) || path}</span>
    </span>
  );
}

export interface SyncDiffPanelProps {
  link: SyncLink;
  leftPath: string;
  rightPath: string;
  alignment: LinkAlignment;
  status: "running" | "done" | "cancelled" | "error";
  entries: DiffEntry[] | null;
  error?: string | null;
  /** 未对齐时「在对侧新建并进入」是否可用（对侧 canMkdir） */
  canCreateMissing: boolean;
  onRealign: () => void;
  onSwap: () => void;
  onCreateMissing: () => void;
  onReturnAlign: () => void;
  onUnlink: () => void;
}

/** v0.18 底部实时比对面板（同步浏览）：跨全宽横条，可折叠，关闭 = 断开链接。 */
export function SyncDiffPanel({
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
}: SyncDiffPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(false);

  const aligned = alignment.state === "aligned";
  const rows = useMemo(() => {
    if (!entries) return [];
    return onlyDiff ? entries.filter((e) => e.status !== "same") : entries;
  }, [entries, onlyDiff]);

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
      data-sync-diff-panel=""
      data-link-tab={link.tabId}
      className="shrink-0 border-t bg-muted/20 text-[13px]"
    >
      {/* 头部（折叠后仅存此行） */}
      <div className="flex h-9 items-center gap-2 px-2">
        <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-semibold">同步比对</span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium",
            aligned ? "bg-green-500/15 text-green-700 dark:text-green-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
          )}
        >
          {aligned ? "已对齐" : "未对齐"}
        </span>
        <SideChip side="left" path={leftPath} />
        <span className="text-[10px] text-muted-foreground">⇄</span>
        <SideChip side="right" path={rightPath} />
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          {status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === "error" && <span className="text-red-600 dark:text-red-400">{statusText}{error ? `：${error}` : ""}</span>}
          {status !== "error" && statusText}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 px-2 text-xs", onlyDiff && "bg-accent text-accent-foreground")}
            onClick={() => setOnlyDiff((v) => !v)}
            title="只显示存在差异的条目"
          >
            只看差异
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onSwap} title="交换左右">
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRealign} title="重新对齐（两侧跳回链接锚点）">
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "展开面板" : "折叠面板"}
          >
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-red-600 hover:text-red-700 dark:text-red-400"
            onClick={onUnlink}
            title="断开链接并关闭面板"
          >
            <Link2Off className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      {/* 未对齐横幅 */}
      {!collapsed && missingText && (
        <div className="flex items-center gap-2 border-t bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
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

      {/* 条目列表 */}
      {!collapsed && (
        <div className="max-h-56 overflow-y-auto border-t">
          <div
            className="sticky top-0 grid items-center border-b bg-muted/40 text-[11px] font-medium text-muted-foreground"
            style={{ gridTemplateColumns: "minmax(0,1fr) 110px 110px 92px" }}
          >
            <span className="px-2 py-1">名称</span>
            <span className="px-2 py-1 text-right">左大小</span>
            <span className="px-2 py-1 text-right">右大小</span>
            <span className="px-2 py-1">状态</span>
          </div>
          {rows.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {status === "running" ? "正在比对…" : entries && entries.length > 0 ? "没有差异条目" : "（空目录）"}
            </div>
          ) : (
            rows.map((e) => {
              const st = statusLabel(e);
              return (
                <div
                  key={`${e.name}:${e.left?.path ?? ""}:${e.right?.path ?? ""}`}
                  className="grid items-center border-b text-xs hover:bg-muted/40"
                  style={{ gridTemplateColumns: "minmax(0,1fr) 110px 110px 92px" }}
                  title={e.left?.path && e.right?.path ? `${e.left.path} ⇄ ${e.right.path}` : e.left?.path ?? e.right?.path}
                >
                  <span className={cn("truncate px-2 py-1", e.is_dir && "font-medium")}>{e.name}</span>
                  <span className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {e.left ? (e.left.is_dir ? "—" : formatSize(e.left.size)) : "—"}
                  </span>
                  <span className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {e.right ? (e.right.is_dir ? "—" : formatSize(e.right.size)) : "—"}
                  </span>
                  <span className={cn("px-2 py-1", st.className)}>{st.text}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
