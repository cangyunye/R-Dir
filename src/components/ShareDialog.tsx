import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  Share2,
  ShieldCheck,
  Timer,
  Unlock,
} from "lucide-react";
import { shareCreate } from "@/lib/api";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  loadShareAllowParent,
  loadShareDefaultExpires,
  saveShareAllowParent,
  saveShareDefaultExpires,
} from "@/lib/persist";
import type { ShareCreateResult } from "@/lib/types";

/**
 * v0.7 分享弹窗：把当前窗口目录分享为链接。
 * 只读（浏览器可浏览 + Range 断点续传下载）；权限、连接数、有效期创建时固化。
 */
export function ShareDialog({
  open,
  dir,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  dir: string;
  onClose: () => void;
  onCreated?: (r: ShareCreateResult) => void;
  onError?: (msg: string) => void;
}) {
  const [allowParent, setAllowParent] = useState(() => loadShareAllowParent());
  const [maxConns, setMaxConns] = useState(3);
  const [expiresMode, setExpiresMode] = useState<"24" | "custom" | "forever">(
    () => {
      const d = loadShareDefaultExpires();
      if (d == null) return "forever";
      if (d === 24) return "24";
      return "custom";
    }
  );
  const [customHours, setCustomHours] = useState(
    () => String(loadShareDefaultExpires() ?? 24)
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShareCreateResult | null>(null);
  const [copied, setCopied] = useState(false);

  const expiresHours = () => {
    if (expiresMode === "forever") return null;
    if (expiresMode === "24") return 24;
    const n = Number(customHours);
    return Number.isFinite(n) && n > 0 ? n : 24;
  };

  const create = async () => {
    if (!dir) return;
    setBusy(true);
    try {
      const hours = expiresHours();
      saveShareAllowParent(allowParent);
      saveShareDefaultExpires(hours);
      const r = await shareCreate(dir, allowParent, maxConns, hours);
      setResult(r);
      onCreated?.(r);
    } catch (e) {
      onError?.(String(e));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
        className="w-[420px] max-w-[92vw] rounded-xl border bg-popover p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <Share2 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">分享此目录（只读）</h2>
        </div>
        <p
          className="mb-3 truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground"
          title={dir}
        >
          {dir}
        </p>

        {!result ? (
          <div className="space-y-3 text-xs">
            <label className="flex items-center justify-between rounded-lg border px-3 py-2">
              <span className="flex items-center gap-2">
                <Unlock className="h-3.5 w-3.5 text-amber-500" />
                允许接收方上溯到父目录
              </span>
              <input
                type="checkbox"
                checked={allowParent}
                onChange={(e) => setAllowParent(e.target.checked)}
              />
            </label>
            <p className="pl-1 text-[11px] text-muted-foreground">
              默认关闭：对方被锁定在分享根内；开启后父目录及以上仅可浏览（不可写）。
            </p>

            <label className="block">
              <span className="mb-1 flex items-center gap-2 text-muted-foreground">
                <Lock className="h-3.5 w-3.5" /> 并发连接数上限
              </span>
              <select
                value={maxConns}
                onChange={(e) => setMaxConns(Number(e.target.value))}
                className="w-full rounded-lg border bg-background px-3 py-2"
              >
                <option value={1}>1 个连接</option>
                <option value={3}>3 个连接（默认）</option>
                <option value={10}>10 个连接</option>
                <option value={0}>不限</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 flex items-center gap-2 text-muted-foreground">
                <Timer className="h-3.5 w-3.5" /> 有效期
              </span>
              <div className="flex gap-2">
                <select
                  value={expiresMode}
                  onChange={(e) =>
                    setExpiresMode(e.target.value as typeof expiresMode)
                  }
                  className="flex-1 rounded-lg border bg-background px-3 py-2"
                >
                  <option value="24">24 小时（默认）</option>
                  <option value="custom">自定义小时数</option>
                  <option value="forever">永久（直到停止/退出）</option>
                </select>
                {expiresMode === "custom" && (
                  <input
                    type="number"
                    min={1}
                    value={customHours}
                    onChange={(e) => setCustomHours(e.target.value)}
                    className="w-20 rounded-lg border bg-background px-2 py-2"
                  />
                )}
              </div>
            </label>

            <button
              onClick={create}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Share2 className="h-4 w-4" />
              )}
              生成分享链接
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <QRCodeSVG value={result.url} size={104} marginSize={1} />
              <div className="min-w-0 flex-1">
                <p className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  链接即凭证，请勿外泄
                </p>
                <p
                  className="break-all rounded bg-muted px-2 py-1.5 text-[11px]"
                  title={result.url}
                >
                  {result.url}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={copy}
                    className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copied ? "已复制" : "复制链接"}
                  </button>
                  <button
                    onClick={() => void openUrl(result.url)}
                    className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
                  >
                    <ExternalLink className="h-3 w-3" /> 打开验证
                  </button>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              访问者 IP 可在状态栏「分享」面板查看；关闭被分享的窗口/标签或到期即自动停止。
            </p>
            <button
              onClick={onClose}
              className="w-full rounded-lg border py-2 text-xs hover:bg-muted"
            >
              完成
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
