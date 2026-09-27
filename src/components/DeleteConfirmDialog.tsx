import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Trash2 } from "lucide-react";
import type { FileEntry, SizeProgress, SizeStat } from "@/lib/types";
import { computeSize, cancelSize } from "@/lib/api";
import { formatSize } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/components/FileIcon";
import { RollingNumber } from "@/components/PropertiesDialog";

/**
 * 删除确认弹窗：与右键「属性」同一套统计引擎（compute_size 递归统计），
 * 文件夹在确认前即展示内部包含的文件数/文件夹数/大小；进度增量刷新。
 * 删除进回收站（可 Ctrl+Z 撤销）。
 */
export function DeleteConfirmDialog({
  entries,
  onConfirm,
  onCancel,
}: {
  entries: FileEntry[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [stat, setStat] = useState<SizeStat & { computing: boolean }>(() => ({
    // 文件大小已知，先显示；目录由后端递归统计
    bytes: entries.filter((e) => !e.is_dir).reduce((s, e) => s + e.size, 0),
    files: 0,
    dirs: 0,
    computing: true,
  }));

  useEffect(() => {
    const id = `size-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let disposed = false;
    let un: (() => void) | undefined;
    void listen<SizeProgress>("size-progress", (e) => {
      if (disposed || e.payload.id !== id) return;
      setStat({
        bytes: e.payload.bytes,
        files: e.payload.files,
        dirs: e.payload.dirs,
        computing: !e.payload.done,
      });
    }).then((u) => {
      un = u;
    });
    void computeSize(id, entries.map((e) => e.path))
      .then((s) => {
        if (disposed) return;
        setStat({ bytes: s.bytes, files: s.files, dirs: s.dirs, computing: false });
      })
      .catch(() => {
        if (!disposed) setStat((p) => ({ ...p, computing: false }));
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      un?.();
      window.removeEventListener("keydown", onKey);
      void cancelSize(id).catch(() => {});
    };
    // 每次挂载只统计一次（弹窗按 key 重新挂载）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const single = entries.length === 1 ? entries[0] : null;
  const title = single ? single.name : `${entries.length} 个项目`;
  const preview = entries.slice(0, 5);
  const rest = entries.length - preview.length;

  return (
    <div
      data-delete-confirm=""
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[380px] max-w-[92vw] rounded-lg border bg-background p-4 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Trash2 className="h-4 w-4 text-destructive" /> 确认删除
        </div>

        <div className="mt-2.5 flex items-center gap-2.5">
          {single ? (
            <FileIcon entry={single} size={20} className="shrink-0" />
          ) : (
            <FileIcon
              entry={{ ...entries[0], name: "", path: "", is_dir: true }}
              size={20}
              className="shrink-0"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={single?.path}>
            {title}
          </span>
        </div>

        {/* 内部统计：与右键「属性」同一套递归引擎，增量刷新 */}
        <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <span className="flex items-center gap-1">
            <RollingNumber value={stat.files} />
            <span className="text-muted-foreground">个文件</span>
            <span className="px-1 text-muted-foreground">·</span>
            <RollingNumber value={stat.dirs} />
            <span className="text-muted-foreground">个文件夹</span>
            <span className="px-1 text-muted-foreground">·</span>
            <span className="inline-flex items-baseline gap-1 font-mono">
              <RollingNumber value={stat.bytes} />
              <span className="text-[10px] text-muted-foreground">
                字节（{formatSize(stat.bytes)}）
              </span>
            </span>
            {stat.computing && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
          </span>
          {!single && (
            <div className="mt-1.5 min-w-0 break-all text-[11px] leading-relaxed text-muted-foreground">
              {preview.map((e) => e.name).join("、")}
              {rest > 0 && ` 等 ${entries.length} 项`}
            </div>
          )}
        </div>

        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          将移入回收站，可随时按 Ctrl+Z 撤销恢复。
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} autoFocus>
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}
