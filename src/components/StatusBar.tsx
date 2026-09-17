import { AlertCircle, FolderOpen, Layers } from "lucide-react";
import { formatSize } from "@/lib/format";

export function StatusBar({
  path,
  total,
  selected,
  selectedSize,
  showHidden,
  error,
  notice,
}: {
  path: string;
  total: number;
  selected: string[];
  selectedSize: number;
  showHidden: boolean;
  error: string | null;
  notice: string | null;
}) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-4 border-t bg-muted/30 px-3 text-[11px] text-muted-foreground select-none">
      <div className="flex min-w-0 items-center gap-2">
        {notice ? (
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
        <span>{total} 项{showHidden ? "（含隐藏）" : ""}</span>
        {selected.length > 0 && (
          <span className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            已选 {selected.length} 项 · {formatSize(selectedSize)}
          </span>
        )}
      </div>
    </div>
  );
}
