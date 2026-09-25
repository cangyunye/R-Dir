import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, File as FileIcon2, Folder, Loader2, RefreshCw, X } from "lucide-react";
import type { DiffEntry, DiffLevel } from "@/lib/types";
import { diffDirs, copyEntries, deleteEntries } from "@/lib/api";
import { formatSize, formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LEVELS: { id: DiffLevel; label: string; hint: string }[] = [
  { id: 1, label: "一层·名称", hint: "仅比对文件夹与文件名" },
  { id: 2, label: "二层·大小", hint: "同名文件再比对内容大小" },
  { id: 3, label: "三层·内容", hint: "同名文件再比对 hash 与修改时间" },
];

const STATUS_LABEL: Record<string, string> = {
  "left-only": "仅左侧",
  "right-only": "仅右侧",
  different: "不同",
  same: "相同",
};

const REASON_LABEL: Record<string, string> = {
  size: "大小",
  content: "内容",
  mtime: "时间",
};

function StatusBadge({ entry }: { entry: DiffEntry }) {
  const cls =
    entry.status === "different"
      ? "bg-destructive/10 text-destructive"
      : entry.status === "left-only"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-500"
        : entry.status === "right-only"
          ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
          : "bg-muted text-muted-foreground";
  const reason = entry.reason ? `·${REASON_LABEL[entry.reason] ?? entry.reason}` : "";
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", cls)}>
      {STATUS_LABEL[entry.status] ?? entry.status}
      {reason}
    </span>
  );
}

function SideCell({ side, dim }: { side: DiffEntry["left"]; dim: boolean }) {
  if (!side) return <span className="text-muted-foreground/50">—</span>;
  return (
    <span className={cn("flex items-center justify-end gap-2 tabular-nums", dim && "opacity-50")}>
      <span>{side.is_dir ? "—" : formatSize(side.size)}</span>
      <span className="text-[10px] text-muted-foreground">{formatTime(side.modified)}</span>
    </span>
  );
}

/**
 * 专用差异比对窗口（v0.17）：左右两个目录的条目差异，
 * 一层名称 / 二层大小 / 三层 hash+时间；支持向左/向右同步。
 */
export function DiffDialog({
  leftDir,
  rightDir,
  onClose,
  onSynced,
}: {
  leftDir: string;
  rightDir: string;
  onClose: () => void;
  /** 同步完成后的回调（用于刷新窗格列表） */
  onSynced?: () => void;
}) {
  const [level, setLevel] = useState<DiffLevel>(1);
  const [entries, setEntries] = useState<DiffEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await diffDirs(leftDir, rightDir, level);
      setEntries(list);
      setSelected((prev) => {
        // 保留仍存在且仍有差异的选中项
        const next = new Set<string>();
        for (const e of list) {
          if (prev.has(e.name) && e.status !== "same") next.add(e.name);
        }
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [leftDir, rightDir, level]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    let leftOnly = 0;
    let rightOnly = 0;
    let different = 0;
    let same = 0;
    for (const e of entries) {
      if (e.status === "left-only") leftOnly++;
      else if (e.status === "right-only") rightOnly++;
      else if (e.status === "different") different++;
      else same++;
    }
    return { leftOnly, rightOnly, different, same, diffs: leftOnly + rightOnly + different };
  }, [entries]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAllDiff = () => {
    setSelected(new Set(entries.filter((e) => e.status !== "same").map((e) => e.name)));
  };

  const sync = useCallback(
    async (direction: "left" | "right") => {
      const targets = entries.filter((e) => selected.has(e.name) && e.status !== "same");
      if (targets.length === 0) return;
      const destDir = direction === "right" ? rightDir : leftDir;
      setBusy(true);
      setError(null);
      setNotice(null);
      let done = 0;
      try {
        for (const e of targets) {
          const from = direction === "right" ? e.left : e.right; // 源：另一侧
          const existing = direction === "right" ? e.right : e.left; // 目标侧现有
          if (from) {
            // 源存在 → 覆盖复制到目标侧（含目录递归）
            await copyEntries([from.path], destDir);
          } else if (existing) {
            // 目标侧独有 → 删除以对齐
            await deleteEntries([existing.path]);
          }
          done++;
        }
        setNotice(`已${direction === "right" ? "向右" : "向左"}同步 ${done} 项`);
        onSynced?.();
        await load();
      } catch (err) {
        setError(`同步失败：${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [entries, selected, leftDir, rightDir, load, onSynced],
  );

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[80vh] w-[920px] max-w-[95vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="text-sm font-semibold">差异比对</div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 工具条：层级选择 + 刷新 */}
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLevel(l.id)}
                title={l.hint}
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  level === l.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground">
            {LEVELS.find((l) => l.id === level)?.hint}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1"
            onClick={() => void load()}
            disabled={loading || busy}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            重新比对
          </Button>
        </div>

        {/* 路径 + 统计 */}
        <div className="grid grid-cols-2 gap-2 border-b px-4 py-2 text-[11px]">
          <div className="truncate" title={leftDir}>
            <span className="text-muted-foreground">左：</span>
            <span className="font-mono">{leftDir}</span>
          </div>
          <div className="truncate" title={rightDir}>
            <span className="text-muted-foreground">右：</span>
            <span className="font-mono">{rightDir}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground">
          <span>
            差异 <b className="text-foreground">{stats.diffs}</b> 项
          </span>
          <span>仅左 {stats.leftOnly}</span>
          <span>仅右 {stats.rightOnly}</span>
          <span>不同 {stats.different}</span>
          <span>相同 {stats.same}</span>
          <button
            className="ml-auto rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
            onClick={selectAllDiff}
            disabled={stats.diffs === 0}
          >
            全选差异
          </button>
          <button
            className="rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
          >
            清除选择
          </button>
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在比对…
            </div>
          ) : error ? (
            <div className="p-4 text-xs text-destructive">{error}</div>
          ) : entries.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">两个目录均为空</div>
          ) : (
            <div className="text-xs">
              {entries.map((e) => {
                const checked = selected.has(e.name);
                const clickable = e.status !== "same";
                return (
                  <div
                    key={e.name}
                    className={cn(
                      "grid grid-cols-[28px_1fr_140px_140px_90px] items-center border-b px-2 py-1.5",
                      clickable ? "cursor-pointer hover:bg-muted/40" : "opacity-70",
                    )}
                    onClick={() => clickable && toggle(e.name)}
                  >
                    <span className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!clickable}
                        onChange={() => toggle(e.name)}
                        onClick={(ev) => ev.stopPropagation()}
                      />
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      {e.is_dir ? (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileIcon2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate font-medium" title={e.name}>
                        {e.name}
                      </span>
                    </span>
                    <SideCell side={e.left} dim={!e.left} />
                    <SideCell side={e.right} dim={!e.right} />
                    <span className="flex justify-end">
                      <StatusBadge entry={e} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 border-t px-4 py-2">
          {notice && <span className="text-xs text-emerald-600">{notice}</span>}
          {error && <span className="truncate text-xs text-destructive">{error}</span>}
          <span className="text-[11px] text-muted-foreground">
            已选 {selected.size} 项
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={busy || selected.size === 0}
              onClick={() => void sync("left")}
              title="以右侧为准，同步到左侧（覆盖/删除左侧差异）"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 向左同步
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={busy || selected.size === 0}
              onClick={() => void sync("right")}
              title="以左侧为准，同步到右侧（覆盖/删除右侧差异）"
            >
              向右同步 <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" onClick={onClose} disabled={busy}>
              关闭
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
