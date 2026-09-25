import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, X } from "lucide-react";
import type { FileEntry, SizeProgress, SizeStat } from "@/lib/types";
import { computeSize, cancelSize } from "@/lib/api";
import { formatSize, formatTime } from "@/lib/format";
import { parentOf } from "@/lib/persist";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/components/FileIcon";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** 单个数字位：垂直排列 0–9，用 transform 滚动到目标位（合成层，轻量） */
function Digit({ d }: { d: number }) {
  return (
    <span
      className="relative inline-block overflow-hidden align-baseline tabular-nums"
      style={{ height: "1em", width: "1ch" }}
    >
      <span
        className="absolute left-0 top-0 flex flex-col transition-transform duration-500 ease-out motion-reduce:transition-none"
        style={{ transform: `translateY(${-d}em)` }}
      >
        {DIGITS.map((n) => (
          <span
            key={n}
            className="flex items-center justify-center"
            style={{ height: "1em" }}
          >
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}

/** 老虎机式滚动数字：逐位上下滚动，数值变化时自动播放 */
export function RollingNumber({ value }: { value: number }) {
  const n = Math.max(0, Math.floor(value));
  const s = n.toLocaleString("en-US");
  return (
    <span
      className="inline-flex items-center tabular-nums"
      data-value={n}
      aria-label={s}
      title={s}
    >
      {s.split("").map((ch, i) =>
        ch >= "0" && ch <= "9" ? (
          <Digit key={i} d={Number(ch)} />
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1 text-xs">
      <span className="w-16 shrink-0 text-right text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all text-foreground">{children}</span>
    </div>
  );
}

/**
 * 属性弹窗（v0.16）：显示单个/多个条目的信息；目录递归统计大小，
 * 统计过程按增量进度刷新，数字用老虎机式滚动动画。
 */
export function PropertiesDialog({
  entries,
  onClose,
}: {
  entries: FileEntry[];
  onClose: () => void;
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
    void computeSize(
      id,
      entries.map((e) => e.path),
    )
      .then((s) => {
        if (disposed) return;
        setStat({ bytes: s.bytes, files: s.files, dirs: s.dirs, computing: false });
      })
      .catch(() => {
        if (!disposed) setStat((p) => ({ ...p, computing: false }));
      });
    return () => {
      disposed = true;
      un?.();
      void cancelSize(id).catch(() => {});
    };
    // 每次挂载只统计一次（弹窗按 key 重新挂载）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const single = entries.length === 1 ? entries[0] : null;
  const title = single ? single.name : `${entries.length} 个项目`;
  const kind = single
    ? single.is_dir
      ? "文件夹"
      : single.extension
        ? `${single.extension.toUpperCase()} 文件`
        : "文件"
    : "多个项目";

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="text-sm font-semibold">属性</div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭（Esc）"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3 flex items-center gap-3">
            {single ? (
              <FileIcon entry={single} size={32} className="shrink-0" />
            ) : (
              <FileIcon
                entry={{ ...entries[0], name: "", path: "", is_dir: true }}
                size={32}
                className="shrink-0"
              />
            )}
            <div className="min-w-0 text-sm font-medium break-all">{title}</div>
          </div>

          <div className="border-t pt-2">
            <Row label="类型">{kind}</Row>
            {single && <Row label="位置">{parentOf(single.path)}</Row>}

            <Row label="大小">
              <span className="flex items-center gap-2">
                <span className="inline-flex items-baseline gap-1 font-mono text-[13px]">
                  <RollingNumber value={stat.bytes} />
                  <span className="text-[10px] text-muted-foreground">字节</span>
                </span>
                <span className="text-muted-foreground">（{formatSize(stat.bytes)}）</span>
                {stat.computing && (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                )}
              </span>
            </Row>

            <Row label="包含">
              <span className="flex items-center gap-1">
                <RollingNumber value={stat.files} />
                <span className="text-muted-foreground">个文件</span>
                <span className="px-1 text-muted-foreground">·</span>
                <RollingNumber value={stat.dirs} />
                <span className="text-muted-foreground">个文件夹</span>
              </span>
            </Row>

            {single && <Row label="修改时间">{formatTime(single.modified)}</Row>}
            {single && <Row label="创建时间">{formatTime(single.created)}</Row>}
            {single && <Row label="权限">{single.permissions || "—"}</Row>}
          </div>

          {stat.computing && (
            <div className="mt-2 text-[11px] text-muted-foreground">正在递归统计…</div>
          )}
        </div>

        <div className="flex justify-end border-t px-4 py-2">
          <Button size="sm" onClick={onClose} autoFocus>
            确定
          </Button>
        </div>
      </div>
    </div>
  );
}
