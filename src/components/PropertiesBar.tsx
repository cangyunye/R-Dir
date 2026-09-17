import { Info } from "lucide-react";
import type { FileEntry } from "@/lib/types";
import { formatSize, formatTime } from "@/lib/format";
import { fileKindClass } from "@/components/FileIcon";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </span>
  );
}

/** 底部属性栏：选中单个文件时显示详细属性 */
export function PropertiesBar({
  entries,
  selection,
}: {
  entries: FileEntry[];
  selection: string[];
}) {
  const selectedEntries = selection
    .map((p) => entries.find((e) => e.path === p))
    .filter((e): e is FileEntry => Boolean(e));

  return (
    <div className="flex h-8 shrink-0 items-center gap-4 overflow-x-auto border-t bg-muted/15 px-3 text-xs">
      {selectedEntries.length === 1 ? (
        (() => {
          const e = selectedEntries[0];
          const kind = e.is_dir
            ? "目录"
            : e.extension
              ? `${e.extension.toUpperCase()} 文件`
              : "文件";
          return (
            <>
              <Row label="名称" value={e.name} />
              <Row label="类型" value={kind} />
              <Row
                label="大小"
                value={e.is_dir ? "—" : formatSize(e.size)}
              />
              <Row label="修改" value={formatTime(e.modified)} />
              <Row label="创建" value={formatTime(e.created)} />
              <Row label="权限" value={e.permissions} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-muted-foreground">路径</span>
                <span className="truncate font-mono text-[11px] text-foreground" title={e.path}>
                  {e.path}
                </span>
              </span>
            </>
          );
        })()
      ) : selectedEntries.length > 1 ? (
        <span className="text-muted-foreground">
          已选 {selectedEntries.length} 项，共 {formatSize(selectedEntries.reduce((s, e) => s + e.size, 0))}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          选中文件后在此显示详细属性
        </span>
      )}
      {selectedEntries.length === 1 && selectedEntries[0].is_dir && (
        <span className={`ml-auto shrink-0 text-[11px] ${fileKindClass(selectedEntries[0])}`}>
          ● 目录
        </span>
      )}
    </div>
  );
}
