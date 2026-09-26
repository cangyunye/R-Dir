import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Copy,
  File as FileIcon2,
  Folder,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import type { DiffEntry, DiffLevel, DiffProgress } from "@/lib/types";
import { diffDirs, cancelDiff, copyEntries, deleteEntries } from "@/lib/api";
import { formatSize, formatTime } from "@/lib/format";
import {
  loadDiffLevel,
  saveDiffLevel,
  loadDiffCaseSensitive,
  saveDiffCaseSensitive,
  loadDiffMtimeTolerance,
  saveDiffMtimeTolerance,
} from "@/lib/persist";
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
  type: "类型",
};

/** mtime 容差可选值（秒） */
const MTIME_CHOICES = [0, 1, 2, 5, 30] as const;

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
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", reason && entry.reason === "type" && "ring-1 ring-destructive/40", cls)}>
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

interface SyncResult {
  name: string;
  action: "copy" | "delete";
  ok: boolean;
  error?: string;
}

/**
 * 专用差异比对窗口（v0.17；v0.18 进度/停止/类型冲突/只看差异/大小写/时间容差/同步确认与日志）。
 */
export function DiffDialog({
  leftDir,
  rightDir,
  onClose,
  onSynced,
  onLocate,
}: {
  leftDir: string;
  rightDir: string;
  onClose: () => void;
  /** 同步完成后的回调（用于刷新窗格列表） */
  onSynced?: () => void;
  /** 双击差异项：在对应窗格定位（进入其父目录并选中） */
  onLocate?: (side: "left" | "right", path: string, isDir: boolean) => void;
}) {
  const [level, setLevel] = useState<DiffLevel>(() => loadDiffLevel());
  const [caseSensitive, setCaseSensitive] = useState<boolean>(() => loadDiffCaseSensitive());
  const [mtimeSec, setMtimeSec] = useState<number>(() => loadDiffMtimeTolerance());
  const [entries, setEntries] = useState<DiffEntry[]>([]);
  const [comparing, setComparing] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<DiffProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pending, setPending] = useState<{ direction: "left" | "right"; copy: number; del: number } | null>(null);
  const [syncResults, setSyncResults] = useState<SyncResult[] | null>(null);
  const [logOpen, setLogOpen] = useState(true);

  /** 当前比对任务 id（取消与进度过滤用） */
  const idRef = useRef<string>("");

  // 监听比对进度（常驻监听，按 id 过滤）
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    void listen<DiffProgress>("diff-progress", (e) => {
      if (disposed || e.payload.id !== idRef.current) return;
      setProgress(e.payload);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // 关闭窗口 / 卸载时取消进行中的比对
  useEffect(
    () => () => {
      if (idRef.current) void cancelDiff(idRef.current).catch(() => {});
    },
    [],
  );

  const runCompare = useCallback(async () => {
    const id = `diff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    idRef.current = id;
    setComparing(true);
    setCancelling(false);
    setError(null);
    setProgress(null);
    try {
      const outcome = await diffDirs(
        id,
        leftDir,
        rightDir,
        level,
        caseSensitive,
        Math.round(mtimeSec * 1000),
      );
      if (outcome.cancelled) {
        setNotice("已停止比对（结果不完整）");
        return;
      }
      setEntries(outcome.entries);
      setSelected((prev) => {
        const next = new Set<string>();
        for (const e of outcome.entries) {
          if (prev.has(e.name) && e.status !== "same") next.add(e.name);
        }
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setComparing(false);
      setProgress(null);
    }
  }, [leftDir, rightDir, level, caseSensitive, mtimeSec]);

  useEffect(() => {
    void runCompare();
  }, [runCompare]);

  // 偏好持久化
  useEffect(() => saveDiffLevel(level), [level]);
  useEffect(() => saveDiffCaseSensitive(caseSensitive), [caseSensitive]);
  useEffect(() => saveDiffMtimeTolerance(mtimeSec), [mtimeSec]);

  // 比对选项变化时清除上一次的同步提示/日志
  useEffect(() => {
    setNotice(null);
    setSyncResults(null);
  }, [level, caseSensitive, mtimeSec]);

  const stop = useCallback(() => {
    setCancelling(true);
    if (idRef.current) void cancelDiff(idRef.current).catch(() => {});
  }, []);

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

  const visible = useMemo(
    () => (onlyDiff ? entries.filter((e) => e.status !== "same") : entries),
    [entries, onlyDiff],
  );

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

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const targetsFor = () =>
    entries.filter((e) => selected.has(e.name) && e.status !== "same");

  /** 同步前先汇总并确认（覆盖复制 / 删除目标侧独有） */
  const requestSync = (direction: "left" | "right") => {
    const targets = targetsFor();
    if (targets.length === 0) return;
    let copy = 0;
    let del = 0;
    for (const e of targets) {
      const from = direction === "right" ? e.left : e.right;
      if (from) copy++;
      else del++;
    }
    setPending({ direction, copy, del });
  };

  const confirmSync = useCallback(async () => {
    if (!pending) return;
    const { direction } = pending;
    const targets = targetsFor();
    setPending(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    setSyncResults(null);
    const destDir = direction === "right" ? rightDir : leftDir;
    const results: SyncResult[] = [];
    for (const e of targets) {
      const from = direction === "right" ? e.left : e.right;
      const existing = direction === "right" ? e.right : e.left;
      const action: "copy" | "delete" = from ? "copy" : "delete";
      try {
        if (from) {
          await copyEntries([from.path], destDir);
        } else if (existing) {
          await deleteEntries([existing.path]);
        }
        results.push({ name: e.name, action, ok: true });
      } catch (err) {
        results.push({ name: e.name, action, ok: false, error: String(err) });
      }
    }
    setSyncResults(results);
    onSynced?.();
    await runCompare();
    const failed = results.filter((r) => !r.ok).length;
    setNotice(
      `已${direction === "right" ? "向右" : "向左"}同步 ${results.length - failed} 项${
        failed ? `，失败 ${failed} 项` : ""
      }`,
    );
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, entries, selected, leftDir, rightDir, runCompare, onSynced]);

  const copyLog = () => {
    if (!syncResults) return;
    const text = syncResults
      .map(
        (r) =>
          `${r.ok ? "OK" : "FAIL"}\t${r.action === "copy" ? "覆盖复制" : "删除"}\t${r.name}${
            r.error ? `\t${r.error}` : ""
          }`,
      )
      .join("\n");
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  const locatable = !!onLocate;

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl",
          maximized ? "h-[calc(100vh-24px)] w-[calc(100vw-24px)]" : "h-[80vh] w-[960px] max-w-[95vw]",
        )}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="text-sm font-semibold">差异比对</div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMaximized((m) => !m)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={maximized ? "还原窗口" : "最大化"}
            >
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 工具条：层级 / 名称匹配 / 时间容差 / 只看差异 / 重新比对 */}
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLevel(l.id)}
                title={l.hint}
                disabled={comparing || busy}
                className={cn(
                  "rounded px-2 py-1 transition-colors disabled:opacity-50",
                  level === l.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground">{LEVELS.find((l) => l.id === level)?.hint}</span>

          <button
            onClick={() => setCaseSensitive((v) => !v)}
            disabled={comparing || busy}
            title={caseSensitive ? "名称匹配区分大小写（点击改为不区分）" : "名称匹配不区分大小写（点击改为区分）"}
            className={cn(
              "rounded border px-2 py-1 font-mono disabled:opacity-50",
              caseSensitive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            Aa
          </button>

          {level === 3 && (
            <label className="flex items-center gap-1 text-muted-foreground" title="修改时间差在此容差内视为相同（跨文件系统精度差异）">
              时间容差
              <select
                value={mtimeSec}
                disabled={comparing || busy}
                onChange={(e) => setMtimeSec(Number(e.target.value))}
                className="rounded border bg-background px-1 py-0.5 text-xs disabled:opacity-50"
              >
                {MTIME_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            onClick={() => setOnlyDiff((v) => !v)}
            disabled={stats.diffs === 0}
            title="仅显示差异条目"
            className={cn(
              "rounded border px-2 py-1 disabled:opacity-50",
              onlyDiff
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            只看差异
          </button>

          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1"
            onClick={() => {
              setNotice(null);
              setSyncResults(null);
              void runCompare();
            }}
            disabled={comparing || busy}
          >
            {comparing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
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
          {comparing && entries.length === 0 ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在比对…
            </div>
          ) : error ? (
            <div className="p-4 text-xs text-destructive">{error}</div>
          ) : visible.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {entries.length === 0
                ? "两个目录均为空"
                : onlyDiff
                  ? "没有差异条目"
                  : "无条目"}
            </div>
          ) : (
            <div className="text-xs">
              {visible.map((e) => {
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
                    onDoubleClick={() => {
                      if (!locatable) return;
                      const side = e.left ? "left" : "right";
                      const s = e.left ?? e.right;
                      if (s) onLocate?.(side, s.path, s.is_dir);
                    }}
                    title={locatable ? "双击在对应窗格定位" : undefined}
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

        {/* 比对进度（进行中显示在下方） */}
        {comparing && (
          <div className="flex items-center gap-2 border-t bg-muted/10 px-4 py-2 text-xs">
            <span className="shrink-0 text-muted-foreground">
              {progress ? (progress.phase === "hash" ? "哈希比对" : "逐条比对") : "准备中"}
            </span>
            <span className="w-20 shrink-0 tabular-nums text-muted-foreground">
              {progress ? `${progress.done}/${progress.total}` : "—"}
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums">{pct}%</span>
            <span className="max-w-40 shrink-0 truncate text-muted-foreground">{progress?.current ?? ""}</span>
            <Button variant="outline" size="sm" className="h-7" onClick={stop} disabled={cancelling}>
              {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "停止"}
            </Button>
          </div>
        )}

        {/* 同步确认 */}
        {pending && (
          <div className="border-t bg-amber-500/5 px-4 py-2.5 text-xs">
            <div className="font-medium">
              确认{pending.direction === "right" ? "向右" : "向左"}同步？
            </div>
            <div className="mt-1 text-muted-foreground">
              以{pending.direction === "right" ? "左" : "右"}侧为准：覆盖复制{" "}
              <b className="text-foreground">{pending.copy}</b> 项
              {pending.del > 0 && (
                <>
                  ，删除 <b className="text-destructive">{pending.del}</b> 项（移入回收站）
                </>
              )}
              。
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button
                variant={pending.del > 0 ? "destructive" : "default"}
                size="sm"
                onClick={() => void confirmSync()}
              >
                确认同步
              </Button>
            </div>
          </div>
        )}

        {/* 同步结果日志 */}
        {syncResults && (
          <div className="border-t px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                成功 {syncResults.filter((r) => r.ok).length} / {syncResults.length}
              </span>
              {syncResults.some((r) => !r.ok) && (
                <span className="flex items-center gap-1 text-destructive">
                  <XCircle className="h-3.5 w-3.5" /> 失败 {syncResults.filter((r) => !r.ok).length}
                </span>
              )}
              <button className="rounded px-2 py-0.5 hover:bg-accent" onClick={() => setLogOpen((o) => !o)}>
                {logOpen ? "收起" : "展开"}
              </button>
              <button className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-accent" onClick={copyLog}>
                <Copy className="h-3 w-3" /> 复制日志
              </button>
              <button className="ml-auto rounded px-2 py-0.5 hover:bg-accent" onClick={() => setSyncResults(null)}>
                清除
              </button>
            </div>
            {logOpen && (
              <div className="mt-1 max-h-28 overflow-y-auto rounded border bg-muted/20 p-1.5 font-mono text-[11px]">
                {syncResults.map((r, i) => (
                  <div key={`${r.name}-${i}`} className={cn(!r.ok && "text-destructive")}>
                    {r.ok ? "✓" : "✗"} {r.action === "copy" ? "覆盖复制" : "删除"} {r.name}
                    {r.error ? ` — ${r.error}` : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 底部操作 */}
        <div className="flex items-center gap-2 border-t px-4 py-2">
          {notice && <span className="truncate text-xs text-emerald-600">{notice}</span>}
          {error && <span className="truncate text-xs text-destructive">{error}</span>}
          <span className="text-[11px] text-muted-foreground">已选 {selected.size} 项</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={busy || comparing || selected.size === 0}
              onClick={() => requestSync("left")}
              title="以右侧为准，同步到左侧（覆盖/删除左侧差异）"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 向左同步
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={busy || comparing || selected.size === 0}
              onClick={() => requestSync("right")}
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
