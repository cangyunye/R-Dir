/**
 * v0.52 批量改名对话框（计划3）：左规则面板 + 右统计/分页预览表 + 预览/执行/撤销。
 *
 * - 来源两态：窗格多选条目 ⇄ 当前目录按特征匹配（通配符/正则/包含，零新增后端调用）
 * - 执行 = 前端顺序循环单条改名（App 侧按 scheme 路由，本地/SFTP/NFS 全支持），逐行状态翻转
 * - 撤销仅窗口内可用（成功名单逆序改回旧名），关窗即弃、不写全局 FileOp 栈
 * - 快捷键仅在窗口内生效：capture 阶段拦截 + isTopModalLayer 守卫（仿 DeleteConfirmDialog）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/LanguageProvider";
import { terr } from "@/lib/i18n";
import { isMac } from "@/lib/keymap";
import { useModalLayer } from "@/hooks/useModalLayer";
import { isTopModalLayer } from "@/lib/modal-stack";
import type { FileEntry } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyRules,
  DEFAULT_RULES,
  matchEntries,
  summarize,
  targetPlatformFor,
  validateRows,
  type MatchMode,
  type RenameRules,
  type RowStatus,
} from "@/lib/batch-rename";

const PAGE_SIZE = 20;

type RunState = { state: "running" | "success" | "error"; error?: string };
interface SuccessPair {
  /** 改名后的完整路径（撤销时对它再改回旧名） */
  newPath: string;
  restoreName: string;
}

export function BatchRenameDialog({
  paneId: _paneId,
  dirPath,
  dirEntries,
  selection,
  renameOne,
  onAfterMutation,
  refreshDir,
  onClose,
}: {
  paneId: number;
  /** 目标目录（= 窗格当前目录；匹配模式与磁盘冲突名单都基于它） */
  dirPath: string;
  /** 打开时窗格当前目录的全量条目（磁盘名单 + 目录匹配候选） */
  dirEntries: FileEntry[];
  /** 打开时窗格多选条目（来源=所选 的初始名单） */
  selection: FileEntry[];
  /** 单条改名（App 侧按 scheme 路由 + ensureConnected），返回新完整路径 */
  renameOne: (path: string, newName: string) => Promise<string>;
  /** 执行/撤销造成磁盘变化后回调（App 侧 noteSelfMutatedDirs + refreshPane） */
  onAfterMutation: () => void;
  /** 重新拉取当前目录条目（执行/撤销后刷新候选与磁盘名单） */
  refreshDir: () => Promise<FileEntry[]>;
  onClose: () => void;
}) {
  const t = useT();
  useModalLayer("batchRename", 66, true);

  const [source, setSource] = useState<"selection" | "dir">(selection.length > 0 ? "selection" : "dir");
  const [matchMode, setMatchMode] = useState<MatchMode>("glob");
  const [matchPattern, setMatchPattern] = useState("");
  const [matchHidden, setMatchHidden] = useState(false);
  const [rules, setRules] = useState<RenameRules>({ ...DEFAULT_RULES });
  const [entries, setEntries] = useState<FileEntry[]>(dirEntries);
  const [page, setPage] = useState(0);
  const [runStates, setRunStates] = useState<Record<number, RunState>>({});
  const [successPairs, setSuccessPairs] = useState<SuccessPair[]>([]);
  const [executing, setExecuting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [notice, setNotice] = useState("");
  const [previewNonce, setPreviewNonce] = useState(0);

  const platform = useMemo(() => targetPlatformFor(dirPath), [dirPath]);

  // ── 预览行（规则/来源变化即时重算；previewNonce 供「预览改名」手动重算） ──
  const rows = useMemo(() => {
    void previewNonce;
    const candidates =
      source === "selection"
        ? selection
        : matchEntries(entries, { mode: matchMode, pattern: matchPattern, includeHidden: matchHidden });
    const pairs = applyRules(candidates, rules);
    const diskNames = new Set(entries.map((e) => e.name));
    return validateRows(pairs, platform, diskNames);
  }, [source, selection, entries, matchMode, matchPattern, matchHidden, rules, platform, previewNonce]);

  const stats = useMemo(() => summarize(rows), [rows]);
  /** 可执行数 = 就绪且尚未执行的行 */
  const executableCount = useMemo(
    () => rows.reduce((n, r, i) => (r.status === "ready" && !runStates[i] ? n + 1 : n), 0),
    [rows, runStates],
  );
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [totalPages, page]);

  // ── 执行：顺序循环就绪行，逐行翻转状态 ──
  const execute = async () => {
    if (executing || undoing) return;
    const targets = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => r.status === "ready" && !runStates[i]);
    if (targets.length === 0) return;
    setExecuting(true);
    setNotice("");
    const success: SuccessPair[] = [];
    for (const { r, i } of targets) {
      setRunStates((s) => ({ ...s, [i]: { state: "running" } }));
      try {
        const newPath = await renameOne(r.entry.path, r.newName);
        success.push({ newPath, restoreName: r.entry.name });
        setRunStates((s) => ({ ...s, [i]: { state: "success" } }));
      } catch (e) {
        setRunStates((s) => ({ ...s, [i]: { state: "error", error: terr(String(e)) } }));
      }
    }
    setExecuting(false);
    if (success.length > 0) setSuccessPairs((p) => [...p, ...success]);
    onAfterMutation();
    void refreshDir()
      .then(setEntries)
      .catch(() => {});
  };

  // ── 撤销：成功名单逆序改回旧名（仅窗口内；关窗即弃） ──
  const undo = async () => {
    if (executing || undoing || successPairs.length === 0) return;
    setUndoing(true);
    setNotice("");
    let failed = 0;
    for (const p of [...successPairs].reverse()) {
      try {
        await renameOne(p.newPath, p.restoreName);
      } catch {
        failed += 1;
      }
    }
    setUndoing(false);
    if (failed === 0) {
      setRunStates({});
      setSuccessPairs([]);
    } else {
      setNotice(t("{n} 项撤销失败，可重试；失败的行仍保留新名", { n: failed }));
    }
    onAfterMutation();
    void refreshDir()
      .then(setEntries)
      .catch(() => {});
  };

  // ── 作用域快捷键（仅窗口内生效；capture 拦截防泄漏到全局 keymap） ──
  const actionRef = useRef<(e: KeyboardEvent) => void>(() => {});
  actionRef.current = (e: KeyboardEvent) => {
    if (!isTopModalLayer("batchRename")) return;
    if (e.isComposing || e.keyCode === 229) return;
    const inInput = (e.target as HTMLElement | null)?.closest?.("input,textarea,select");
    if (e.key === "Escape") {
      if (executing || undoing) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void execute();
    } else if (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey)) {
      // 输入框内放行原生文本撤销
      if (inInput || !successPairs.length || executing || undoing) return;
      e.preventDefault();
      e.stopPropagation();
      void undo();
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      e.stopPropagation();
      setPage((p) => Math.min(totalPages - 1, Math.max(0, p + (e.key === "PageDown" ? 1 : -1))));
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => actionRef.current(e);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const modKey = isMac ? "⌘" : "Ctrl";
  const statusText = (i: number, status: RowStatus, reason: string): { text: string; cls: string } => {
    const run = runStates[i];
    if (run?.state === "running") return { text: t("改名中…"), cls: "text-muted-foreground" };
    if (run?.state === "success") return { text: t("成功"), cls: "text-emerald-600 dark:text-emerald-400" };
    if (run?.state === "error") return { text: `${t("失败")}·${run.error ?? ""}`, cls: "text-red-600 dark:text-red-400" };
    switch (status) {
      case "unchanged":
        return { text: t("未修改"), cls: "text-muted-foreground" };
      case "ready":
        return { text: t("待改名"), cls: "text-amber-600 dark:text-amber-400" };
      case "conflict":
        return { text: `${t("冲突")}·${t(reason)}`, cls: "text-red-600 dark:text-red-400" };
      default:
        return { text: `${t("非法名称")}·${t(reason)}`, cls: "text-red-600 dark:text-red-400" };
    }
  };

  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const busy = executing || undoing;
  const platformHint =
    platform === "windows"
      ? t("Windows 目标：禁用 <>:\"/\\|?* 与控制字符；结尾不能为点/空格；不能用保留名（CON、NUL 等）；重名不分大小写")
      : platform === "macos"
        ? t("macOS 目标：名称不能含 /；重名不分大小写")
        : t("Linux 远端（SFTP/NFS）：名称不能含 /；重名区分大小写");

  const ruleField =
    "grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-xs text-muted-foreground";

  return (
    <div
      data-testid="batch-rename-dialog"
      className="fixed inset-0 z-[66] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex h-[70vh] max-h-[640px] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
        {/* 头部 */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <div className="text-sm font-semibold">{t("批量改名")}</div>
            <div className="text-[11px] text-muted-foreground">{t("仅当前窗格 · 改名后扩展名保持不变")}</div>
          </div>
          <button
            onClick={() => !busy && onClose()}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("关闭（Esc）")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 来源条 */}
        <div className="flex items-center gap-2 border-b px-4 py-2 text-xs">
          <span className="text-muted-foreground">{t("来源")}</span>
          <div className="flex gap-1">
            {(
              [
                { v: "selection" as const, label: t("所选 {n} 项", { n: selection.length }) },
                { v: "dir" as const, label: t("当前目录匹配") },
              ]
            ).map(({ v, label }) => (
              <button
                key={v}
                type="button"
                data-testid={`br-source-${v}`}
                aria-pressed={source === v}
                disabled={busy}
                onClick={() => setSource(v)}
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  source === v
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {source === "dir" && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <select
                data-testid="br-match-mode"
                value={matchMode}
                disabled={busy}
                onChange={(e) => setMatchMode(e.target.value as MatchMode)}
                className="rounded border bg-background px-1.5 py-1 outline-none"
              >
                <option value="glob">{t("通配符")}</option>
                <option value="regex">{t("正则")}</option>
                <option value="substr">{t("包含文本")}</option>
              </select>
              <Input
                data-testid="br-pattern"
                value={matchPattern}
                disabled={busy}
                onChange={(e) => setMatchPattern(e.target.value)}
                placeholder={t("匹配特征（如 *.txt）")}
                className="h-7 max-w-56 text-xs"
              />
              <label className="flex items-center gap-1 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={matchHidden}
                  disabled={busy}
                  onChange={(e) => setMatchHidden(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t("含隐藏文件")}
              </label>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {t("匹配 {n} 项", {
                  n: matchEntries(entries, { mode: matchMode, pattern: matchPattern, includeHidden: matchHidden }).length,
                })}
              </span>
            </div>
          )}
        </div>

        {/* 主体：左规则 + 右预览 */}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[248px] shrink-0 flex-col gap-3 overflow-y-auto border-r px-3 py-3">
            <div className="text-xs font-semibold text-foreground">{t("改名规则")}</div>
            <div className={ruleField}>
              <span>{t("查找文本")}</span>
              <Input
                data-testid="br-find"
                value={rules.find}
                disabled={busy}
                onChange={(e) => setRules((r) => ({ ...r, find: e.target.value }))}
                className="h-7 text-xs"
              />
            </div>
            <div className={ruleField}>
              <span>{t("替换为")}</span>
              <Input
                data-testid="br-replace"
                value={rules.replace}
                disabled={busy}
                onChange={(e) => setRules((r) => ({ ...r, replace: e.target.value }))}
                className="h-7 text-xs"
              />
            </div>
            <div className={ruleField}>
              <span>{t("添加前缀")}</span>
              <Input
                data-testid="br-prefix"
                value={rules.prefix}
                disabled={busy}
                onChange={(e) => setRules((r) => ({ ...r, prefix: e.target.value }))}
                className="h-7 text-xs"
              />
            </div>
            <div className={ruleField}>
              <span>{t("添加后缀")}</span>
              <Input
                data-testid="br-suffix"
                value={rules.suffix}
                disabled={busy}
                onChange={(e) => setRules((r) => ({ ...r, suffix: e.target.value }))}
                className="h-7 text-xs"
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="br-numbering"
                checked={rules.numbering}
                disabled={busy}
                onChange={(e) => setRules((r) => ({ ...r, numbering: e.target.checked }))}
                className="h-3.5 w-3.5 accent-primary"
              />
              {t("连续编号")}
            </label>
            {rules.numbering && (
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t("起始序号")}
                  <Input
                    data-testid="br-number-start"
                    inputMode="numeric"
                    value={String(rules.numberStart)}
                    disabled={busy}
                    onChange={(e) =>
                      setRules((r) => ({ ...r, numberStart: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    className="h-7 text-xs"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t("最少位数")}
                  <select
                    data-testid="br-number-digits"
                    value={String(rules.numberMinDigits)}
                    disabled={busy}
                    onChange={(e) => setRules((r) => ({ ...r, numberMinDigits: Number(e.target.value) }))}
                    className="h-7 rounded border bg-background px-1.5 text-xs outline-none"
                  >
                    {[1, 2, 3, 4, 5, 6].map((d) => (
                      <option key={d} value={d}>
                        {t("{d} 位", { d })}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="br-keep-stem"
                checked={rules.keepStem}
                disabled={busy}
                onChange={(e) => setRules((r) => ({ ...r, keepStem: e.target.checked }))}
                className="h-3.5 w-3.5 accent-primary"
              />
              {t("保留原文件主名")}
            </label>
            <div className="mt-auto rounded border bg-muted/40 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {platformHint}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* 统计行 */}
            <div className="flex items-center gap-6 border-b px-4 py-2">
              {(
                [
                  [t("参与改名"), stats.total, "text-foreground"],
                  [t("待改名"), stats.ready, "text-amber-600 dark:text-amber-400"],
                  [t("冲突"), stats.conflict, "text-red-600 dark:text-red-400"],
                ] as [string, number, string][]
              ).map(([label, n, cls]) => (
                <div key={label} className="flex items-baseline gap-1.5">
                  <span className={cn("text-lg font-semibold tabular-nums", cls)}>{n}</span>
                  <span className="text-[11px] text-muted-foreground">{label}</span>
                </div>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {t("每页 {n} 条", { n: PAGE_SIZE })}
              </span>
            </div>

            {/* 表格 */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div
                className="sticky top-0 z-10 grid items-center border-b bg-muted/40 px-4 py-1.5 text-[11px] font-medium text-muted-foreground"
                style={{ gridTemplateColumns: "32px minmax(0,1fr) minmax(0,1fr) 132px" }}
              >
                <span>#</span>
                <span>{t("原名")}</span>
                <span>{t("变更后")}</span>
                <span>{t("状态")}</span>
              </div>
              {pageRows.map(({ entry, newName, status, reason }, pi) => {
                const i = page * PAGE_SIZE + pi;
                const st = statusText(i, status, reason);
                return (
                  <div
                    key={entry.path}
                    data-testid="br-row"
                    data-br-status={runStates[i]?.state ?? status}
                    className="grid h-[26px] items-center border-b px-4 text-xs hover:bg-muted/40"
                    style={{ gridTemplateColumns: "32px minmax(0,1fr) minmax(0,1fr) 132px" }}
                  >
                    <span className="tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className="truncate">{entry.name}</span>
                    <span className={cn("truncate", status === "unchanged" && runStates[i]?.state !== "success" && runStates[i]?.state !== "error" ? "text-muted-foreground" : "font-medium")}>
                      {newName}
                    </span>
                    <span className={cn("truncate", st.cls)} title={st.text}>
                      {st.text}
                    </span>
                  </div>
                );
              })}
              {rows.length === 0 && (
                <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                  {t("没有参与改名的条目")}
                </div>
              )}
            </div>

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-end gap-2 border-t px-4 py-1.5 text-xs">
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="br-page-prev"
                  disabled={page === 0 || busy}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> {t("上一页")}
                </Button>
                <span className="tabular-nums text-muted-foreground">
                  {t("第 {a} / {b} 页", { a: page + 1, b: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="br-page-next"
                  disabled={page >= totalPages - 1 || busy}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                >
                  {t("下一页")} <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* 底部：提示 + 操作 */}
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2">
          <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {notice || t("{mod}+Enter 直接改名 · {mod}+Z 撤销 · PgUp/PgDn 翻页 · Esc 关闭（仅窗口内生效；关窗后撤销方案不留存）", { mod: modKey })}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <Button
              variant="outline"
              size="sm"
              data-testid="br-undo"
              disabled={!successPairs.length || busy}
              onClick={() => void undo()}
            >
              {t("撤销改名")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="br-preview"
              disabled={busy}
              onClick={() => setPreviewNonce((n) => n + 1)}
            >
              {t("预览改名")}
            </Button>
            <Button
              size="sm"
              data-testid="br-execute"
              disabled={executableCount === 0 || busy}
              onClick={() => void execute()}
            >
              {t("直接改名·{n}", { n: executableCount })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
