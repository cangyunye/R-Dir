import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/LanguageProvider";

/**
 * 通用主密码输入框（v0.31 服务器清单导入用）：
 * 与 MasterKeyDialog 同款手写模态，但不设置/不校验本机主密钥——
 * 只是收集一个密码交给调用方异步校验（resolve = 成功并关闭，reject = 框内展示错误）。
 */
export function PasswordDialog({
  open,
  title,
  description,
  placeholder,
  submitLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  /** 说明文案（为什么要这个密码） */
  description: React.ReactNode;
  placeholder?: string;
  submitLabel: string;
  /** 提交密码；抛错 = 校验失败（错误显示在框内，输入框保持打开） */
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
      setLoading(false);
      // radix 外无 Dialog 包装：手动延迟聚焦，避开遮罩 mousedown 关闭的焦点竞争
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!password || loading) return;
    setLoading(true);
    setError("");
    try {
      await onSubmit(password);
      onClose();
    } catch (e) {
      setError(String(e));
      setLoading(false);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  return (
    <div
      data-password-dialog=""
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div className="w-[400px] max-w-[92vw] rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            {title}
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 px-4 py-4">
          <div className="flex items-start gap-2 rounded border bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{description}</span>
          </div>
          <label className="grid grid-cols-[64px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("主密码")}</span>
            <Input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder={placeholder ?? t("输入主密码")}
              autoFocus
            />
          </label>

          {error && (
            <div className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
              {t("取消")}
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={loading || !password}>
              {loading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
