import { AlertCircle, Crosshair, FolderOpen, Layers, Loader2, X , Share2 } from "lucide-react";
import { formatSize } from "@/lib/format";
import type { TransferProgress } from "@/lib/types";
import { SyncDiffStatusBar, type SyncDiffSummary } from "@/components/SyncDiffPanel";

const PHASE_LABEL: Record<TransferProgress["phase"], string> = {
  copy: "复制",
  move: "移动",
  upload: "上传",
  download: "下载",
  compress: "压缩",
};

/** 部分后端任务以固定文案作 label（复制/移动/压缩不逐文件改名）；
 *  此时不再拼接阶段名，避免渲染成「复制中：复制中…」（v0.18.1） */
const GENERIC_LABELS = new Set(["下载中…", "上传中…", "复制中…", "移动中…", "压缩中…"]);

export function StatusBar({
  path,
  total,
  selected,
  selectedSize,
  showHidden,
  error,
  notice,
  transfer,
  onCancelDownload,
  onSharePanel,
  syncDiff,
  compareBase,
  baseHint,
}: {
  path: string;
  total: number;
  selected: string[];
  selectedSize: number;
  showHidden: boolean;
  error: string | null;
  notice: string | null;
  transfer?: TransferProgress | null;
  onCancelDownload?: (url: string) => void;
  /** v0.7：打开分享管理面板 */
  onSharePanel?: () => void;
  /** v0.18.2 同步比对摘要段（无链接时不传）：点击打开结果模态 */
  syncDiff?: {
    summary: SyncDiffSummary;
    onOpen: () => void;
  };
  /** v0.19 文本比较基准芯片（未设置时不传） */
  compareBase?: {
    name: string;
    path: string;
    onClear: () => void;
  };
  /** v0.19 设/清基准的瞬时提示（右下角，App 侧定时清除） */
  baseHint?: string | null;
}) {
  const pct =
    transfer && transfer.fileTotal > 0
      ? Math.min(100, Math.round((transfer.fileDone / transfer.fileTotal) * 100))
      : 0;
  return (
    <div data-statusbar="" className="relative shrink-0">
      {transfer && !transfer.done && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="flex h-6 items-center justify-between gap-4 border-t bg-muted/30 px-3 text-[11px] text-muted-foreground select-none">
        <div className="flex min-w-0 items-center gap-2">
          {transfer ? (
            <span className="flex items-center gap-1 truncate">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              {transfer.done
                ? `${PHASE_LABEL[transfer.phase]}完成`
                : GENERIC_LABELS.has(transfer.label)
                  ? `${PHASE_LABEL[transfer.phase]}中…`
                  : `${PHASE_LABEL[transfer.phase]}中：${transfer.label}`}
              {transfer.totalFiles > 1 && !transfer.done && (
                <span className="tabular-nums">
                  {transfer.doneFiles + 1}/{transfer.totalFiles}
                </span>
              )}
              {!transfer.done && pct > 0 && (
                <span className="tabular-nums">{pct}%</span>
              )}
            </span>
          ) : notice ? (
            <span className="flex items-center gap-1 truncate text-amber-600">
              <AlertCircle className="h-3 w-3 shrink-0" /> {notice}
            </span>
          ) : error ? (
            <span className="flex items-center gap-1 truncate text-destructive">
              <AlertCircle className="h-3 w-3 shrink-0" /> {error}
            </span>
          ) : (
            <>
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate" title={path}>{path}</span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {baseHint && (
            <span className="max-w-52 truncate text-primary" title={baseHint}>
              {baseHint}
            </span>
          )}
          {compareBase && (
            <span
              className="flex items-center gap-1 rounded border border-primary/40 px-1.5 py-0.5 text-primary"
              title={`文本比较基准：${compareBase.path}`}
            >
              <Crosshair className="h-3 w-3 shrink-0" />
              <span className="max-w-32 truncate">{compareBase.name}</span>
              <button
                onClick={compareBase.onClear}
                title="清除比较基准"
                className="shrink-0 hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {syncDiff && <SyncDiffStatusBar summary={syncDiff.summary} onOpen={syncDiff.onOpen} />}
          {onSharePanel && (
            <button
              onClick={onSharePanel}
              title="分享管理"
              className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
            >
              <Share2 className="h-3 w-3" /> 分享
            </button>
          )}
          {transfer && !transfer.done && transfer.phase === "download" && transfer.id && onCancelDownload && (
            <button
              onClick={() => onCancelDownload(transfer.id!)}
              title="停止下载"
              className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
            >
              <X className="h-3 w-3" /> 停止
            </button>
          )}
          <span>{total} 项{showHidden ? "（含隐藏）" : ""}</span>
          {selected.length > 0 && (
            <span className="flex items-center gap-1">
              <Layers className="h-3 w-3" />
              已选 {selected.length} 项 · {formatSize(selectedSize)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
