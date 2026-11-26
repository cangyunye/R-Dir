/**
 * 文件占用详情对话框（feat/file-lock）：列出占用指定路径的进程，支持结束进程。
 *
 * 两个入口：
 * 1. 删除/移动/改名失败且错误码为 IN_USE 时自动弹出（App.tsx 接入，可带「重试」）；
 * 2. 右键菜单「查看占用」手动检查任意本地条目。
 *
 * 数据经后端 probe_file_lock 三平台探测（Windows 共享冲突 + Restart Manager；
 * macOS libproc fd 扫描；Linux /proc fd 扫描）。自身进程已被后端过滤。
 * Esc/点遮罩 = 关闭；不绑 Enter——避免误触「结束进程」这类危险操作。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModalLayer } from "@/hooks/useModalLayer";
import { isTopModalLayer } from "@/lib/modal-stack";
import { useT } from "@/lib/LanguageProvider";
import { killProcess, probeFileLock } from "@/lib/api";
import { isMac } from "@/lib/keymap";
import type { AppConfirmRequest } from "@/components/AppConfirmDialog";
import type { FileLockStatus } from "@/lib/types";

export interface LockInfoRequest {
  paths: string[];
  /** 调用方动作（如删除流程的「重试删除」）；右键手动检查时缺省 */
  onRetry?: () => void;
}

export function LockInfoDialog({
  req,
  appConfirm,
  onClose,
  onError,
}: {
  req: LockInfoRequest;
  /** 结束进程的二次确认（复用 App 的 appConfirm，保持全局弹窗样式统一） */
  appConfirm: (req: AppConfirmRequest) => Promise<boolean>;
  onClose: () => void;
  /** 结束进程/探测失败时的错误出口（App 传 showError，内部会过 terr） */
  onError: (raw: string) => void;
}) {
  // 弹层栈登记：z=65（内容弹层档，同 ConflictDialog）——结束进程的 appConfirm(70)
  // 必须浮在本框之上可点；更高层弹层打开时本框不抢 Esc
  useModalLayer("lockInfo", 65, true);
  const t = useT();

  const [statuses, setStatuses] = useState<FileLockStatus[] | null>(null);
  const [killingPid, setKillingPid] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setStatuses(null);
    try {
      setStatuses(await probeFileLock(req.paths));
    } catch (e) {
      onError(String(e));
      setStatuses([]);
    }
  }, [req.paths, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 键位监听只订阅一次（回调走 ref，同 AppConfirmDialog 的既有做法）
  const actionRef = useRef<(e: KeyboardEvent) => void>(() => {});
  actionRef.current = (e: KeyboardEvent) => {
    if (!isTopModalLayer("lockInfo")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    // 刻意不绑 Enter：对话框内有「结束进程」危险按钮，回车误触代价太高
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => actionRef.current(e);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const killHolder = useCallback(
    async (pid: number, name: string) => {
      const ok = await appConfirm({
        title: t("结束进程"),
        message: t("确定结束「{name}」（PID {pid}）吗？该进程未保存的数据可能丢失。", { name, pid }),
        confirmLabel: t("结束进程"),
        danger: true,
      });
      if (!ok) return;
      setKillingPid(pid);
      try {
        await killProcess(pid);
        await refresh();
      } catch (e) {
        onError(String(e));
      } finally {
        setKillingPid(null);
      }
    },
    [appConfirm, refresh, onError, t],
  );

  return (
    <div
      data-lock-info=""
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col rounded-lg border bg-background p-4 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-amber-500" />
          {t("文件占用详情")}
          <button
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={onClose}
            aria-label={t("关闭")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {statuses === null && (
            <div className="py-6 text-center text-xs text-muted-foreground">{t("正在检查占用…")}</div>
          )}
          {statuses?.map((st) => {
            const name = st.path.split(/[\\/]/).pop() ?? st.path;
            return (
              <div key={st.path} className="rounded-md border p-2.5">
                <div className="truncate text-xs font-medium" title={st.path}>
                  {name}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={st.path}>
                  {st.path}
                </div>
                {st.locked && st.holders.length > 0 ? (
                  <div className="mt-2">
                    <div className="text-[11px] text-muted-foreground">
                      {t("{n} 个进程正在使用此文件", { n: st.holders.length })}
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {st.holders.map((h) => (
                        <li
                          key={`${h.pid}-${h.name}`}
                          className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5 text-xs"
                        >
                          <span className="font-medium">{h.name || `pid ${h.pid}`}</span>
                          <span className="text-[10px] text-muted-foreground">PID {h.pid}</span>
                          {h.command && (
                            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={h.command}>
                              {h.command}
                            </span>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-auto h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                            disabled={killingPid !== null}
                            onClick={() => void killHolder(h.pid, h.name || `pid ${h.pid}`)}
                          >
                            {killingPid === h.pid ? t("结束中…") : t("结束进程")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                    {isMac && (
                      <div className="mt-1.5 text-[10px] text-muted-foreground">
                        {t("macOS / Linux 上打开句柄不会阻止删除或移动，此处仅为提示")}
                      </div>
                    )}
                  </div>
                ) : st.locked ? (
                  <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    {st.isDir
                      ? t("该目录被占用（可能是某进程的工作目录），无法列出具体进程")
                      : t("被占用，但无法确定占用进程（可能是系统句柄或已由当前应用占用）")}
                  </div>
                ) : (
                  <div className="mt-2 text-[11px] text-muted-foreground">{t("未发现占用此文件的进程")}</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={statuses === null}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> {t("重新检查")}
          </Button>
          {req.onRetry && (
            <Button
              size="sm"
              onClick={() => {
                onClose();
                req.onRetry?.();
              }}
            >
              {t("重试")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("关闭")}
          </Button>
        </div>
      </div>
    </div>
  );
}
