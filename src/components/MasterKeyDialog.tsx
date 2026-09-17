import { useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sftpSetMasterKey } from "@/lib/api";

/**
 * 主密钥（master-key）对话框
 * - 用于 AES-256-GCM 加密/解密保存的服务器密码
 * - 密钥仅存内存、不落盘；应用不关闭则无需重复输入
 * - 首次设置需二次确认；已设置则校验输入是否正确
 */
export function MasterKeyDialog({
  open,
  configured,
  onClose,
  onDone,
}: {
  open: boolean;
  /** 是否已设置过 master-key（后端 masterKeyStatus.configured） */
  configured: boolean;
  onClose: () => void;
  /** 设置/验证成功后回调（ok=true），前端刷新 masterKeyStatus */
  onDone: (ok: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setKey("");
      setConfirm("");
      setError("");
      setLoading(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!key) {
      setError("请输入主密钥");
      return;
    }
    if (!configured && key !== confirm) {
      setError("两次输入不一致");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await sftpSetMasterKey(key);
      onDone(true);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div className="w-[400px] max-w-[92vw] rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            {configured ? "输入主密钥" : "设置主密钥"}
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
            <span>
              主密钥用于加密保存的服务器密码（AES-256-GCM）。
              <br />
              它<b>只存在内存中、不会写入磁盘</b>；应用不关闭则无需重复输入。
              <br />
              验证通过后将自动重新连接未完成的远程目录；取消则保持当前布局、不连接。
            </span>
          </div>
          <label className="grid grid-cols-[64px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">主密钥</span>
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              placeholder={configured ? "输入主密钥" : "至少 4 位，请牢记"}
              autoFocus
            />
          </label>
          {!configured && (
            <label className="grid grid-cols-[64px_1fr] items-center gap-2 text-xs">
              <span className="text-muted-foreground">确认</span>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
                placeholder="再次输入确认"
              />
            </label>
          )}

          {error && (
            <div className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
              取消
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={loading}>
              {loading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {configured ? "解锁" : "设置并保存"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
