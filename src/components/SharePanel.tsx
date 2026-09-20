import { useEffect, useState } from "react";
import {
  Copy,
  ExternalLink,
  Loader2,
  MonitorDown,
  RefreshCw,
  Share2,
  Square,
} from "lucide-react";
import { shareList, shareStop } from "@/lib/api";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ShareSessionView } from "@/lib/types";

function fmtTime(unix: number | null): string {
  if (!unix) return "永久";
  const d = new Date(unix * 1000);
  const now = Date.now() / 1000;
  if (unix < now) return "已过期";
  const h = Math.floor((unix - now) / 3600);
  if (h < 24) return `${h} 小时后`;
  return `${Math.floor(h / 24)} 天后 · ${d.toLocaleString()}`;
}

/**
 * v0.7 分享面板：活跃分享列表 + 访问者 IP 日志 + 停止。
 * 状态栏「分享」按钮打开；监听 share://changed 事件自动刷新。
 */
export function SharePanel({
  open,
  onClose,
  onNewShare,
}: {
  open: boolean;
  onClose: () => void;
  onNewShare?: () => void;
}) {
  const [sessions, setSessions] = useState<ShareSessionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setSessions(await shareList());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
    // 面板打开期间每 5s 轮询；创建/到期/停止由 App 层 share://changed 事件
    // 通过 key={shareVer} 重建本组件触发刷新。
    const iv = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      window.clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stop = async (id: string) => {
    setBusyId(id);
    try {
      await shareStop(id);
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setBusyId(null);
    }
  };

  const copy = async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* ignore */
    }
  };

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[94vw] rounded-xl border bg-popover p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">分享管理</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {sessions.length} 个活跃
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              title="刷新"
              className="rounded p-1 hover:bg-muted"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
            </button>
            <button
              onClick={onNewShare}
              className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
            >
              <Share2 className="h-3 w-3" /> 新建分享
            </button>
          </div>
        </div>

        {sessions.length === 0 && !loading ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            暂无活跃分享。右键文件夹或点「新建分享」把目录分享为链接。
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {sessions.map((s) => (
              <div key={s.id} className="rounded-lg border p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-xs font-medium" title={s.dir}>
                    {s.dir}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      只读
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        s.allowParent ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
                      }`}
                      title={
                        s.allowParent
                          ? "允许上溯父目录（只读）"
                          : "锁定分享根内"
                      }
                    >
                      {s.allowParent ? "可上溯" : "锁定根"}
                    </span>
                  </div>
                </div>
                <p className="mb-2 break-all text-[11px] text-muted-foreground" title={s.url}>
                  {s.url}
                </p>
                <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>
                    连接 {s.conns.length}/{s.maxConns === 0 ? "∞" : s.maxConns}
                  </span>
                  <span>· 有效期 {fmtTime(s.expiresAt)}</span>
                </div>
                {s.conns.length > 0 && (
                  <div className="mb-2 max-h-24 overflow-y-auto rounded bg-muted/50 p-2 text-[10px]">
                    <p className="mb-1 flex items-center gap-1 text-muted-foreground">
                      <MonitorDown className="h-3 w-3" /> 访问者
                    </p>
                    {s.conns.map((c, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 py-0.5">
                        <span className="font-mono">{c.ip}</span>
                        <span className="truncate text-muted-foreground" title={c.ua}>
                          {c.ua || "未知客户端"}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {new Date(c.lastActive * 1000).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => void copy(s.url, s.id)}
                    className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
                  >
                    <Copy className="h-3 w-3" />
                    {copiedId === s.id ? "已复制" : "复制"}
                  </button>
                  <button
                    onClick={() => void openUrl(s.url)}
                    className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
                  >
                    <ExternalLink className="h-3 w-3" /> 打开
                  </button>
                  <button
                    onClick={() => void stop(s.id)}
                    disabled={busyId === s.id}
                    className="ml-auto flex items-center gap-1 rounded border px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    {busyId === s.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Square className="h-3 w-3" />
                    )}
                    停止
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
