import { AlertCircle, FolderOpen, Layers, Loader2, X } from "lucide-react";
import { formatSize } from "@/lib/format";
import type { TransferProgress } from "@/lib/types";

const PHASE_LABEL: Record<TransferProgress["phase"], string> = {
  copy: "复制",
  move: "移动",
  upload: "上传",
  download: "下载",
};

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
}) {
  const pct =
    transfer && transfer.fileTotal > 0
      ? Math.min(100, Math.round((transfer.fileDone / transfer.fileTotal) * 100))
      : 0;
  return (
    <div className="relative shrink-0">
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
