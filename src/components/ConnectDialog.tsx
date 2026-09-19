import { useCallback, useEffect, useState } from "react";
import { FolderCog, KeyRound, Loader2, Lock, Server, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { sftpConnect } from "@/lib/api";
import type { MasterKeyStatus, SftpServerConfig, SftpServerView } from "@/lib/types";

/** 连接对话框的预填信息（来自地址栏 sftp:// 或侧边栏；编辑模式带完整字段） */
export interface SftpConnectInitial {
  id?: string;
  host?: string;
  port?: number;
  user?: string;
  name?: string;
  /** 默认远程目录（编辑回填） */
  root?: string;
  group?: string;
  /** "password" | "publicKey"（编辑回填；缺省视为密码） */
  auth?: "password" | "publicKey";
}

/**
 * SFTP 连接对话框（v0.2）
 * - 认证：密码（可记住并加密保存）或 OpenSSH 私钥（可留空自动探测 ~/.ssh）
 * - 服务器可归组（分组名可选）
 * - 保存/解密密码需要 master-key：未设置或未输入时调 onNeedMasterKey
 *   （由 App 层弹出主密钥框；设置成功后自动重试连接）
 */
export function ConnectDialog({
  open,
  initial,
  masterKey,
  onNeedMasterKey,
  onClose,
  onConnected,
}: {
  open: boolean;
  initial?: SftpConnectInitial | null;
  /** master-key 状态（configured/active） */
  masterKey: MasterKeyStatus;
  /** 需要主密钥（连接解密或保存密码时）→ App 弹出主密钥框 */
  onNeedMasterKey: (config: SftpServerConfig) => void;
  onClose: () => void;
  onConnected: (server: SftpServerConfig, view: SftpServerView) => void;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [root, setRoot] = useState("");
  const [authMode, setAuthMode] = useState<"Password" | "PublicKey">("Password");
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(true);
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [savePassphrase, setSavePassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setHost(initial?.host ?? "");
      setPort(initial?.port ?? 22);
      setUser(initial?.user ?? "");
      setName(initial?.name ?? "");
      setRoot(initial?.root ?? "");
      setGroup(initial?.group ?? "");
      setPassword("");
      setPassphrase("");
      setAuthMode(initial?.auth === "publicKey" ? "PublicKey" : "Password");
      setError("");
      setLoading(false);
    }
  }, [open, initial]);

  const buildConfig = useCallback((): SftpServerConfig | null => {
    if (!host.trim() || !user.trim()) {
      setError("主机与用户名必填");
      return null;
    }
    return {
      id: `${user.trim()}@${host.trim()}:${port || 22}`,
      name: name.trim() || `${user.trim()}@${host.trim()}:${port || 22}`,
      host: host.trim(),
      port: port || 22,
      user: user.trim(),
      root: root.trim() || null,
      group: group.trim(),
      auth: authMode === "Password" ? "password" : "publicKey",
      ...(authMode === "Password"
        ? { password, savePassword }
        : {
            keyPath: keyPath.trim(),
            passphrase: passphrase || undefined,
            savePassphrase,
          }),
    };
  }, [host, port, user, name, group, root, authMode, password, savePassword, keyPath, passphrase, savePassphrase]);

  const submit = useCallback(
    async (config?: SftpServerConfig) => {
      const cfg = config ?? buildConfig();
      if (!cfg) return;
      setLoading(true);
      setError("");
      try {
        const view = await sftpConnect(cfg);
        onConnected(cfg, view);
        onClose();
      } catch (e) {
        const msg = String(e);
        if (msg.includes("NEED_MASTER_KEY")) {
          setError("需要设置/输入主密钥以解密保存的密码");
          onNeedMasterKey(cfg);
        } else {
          setError(msg);
        }
        setLoading(false);
      }
    },
    [buildConfig, onConnected, onClose, onNeedMasterKey],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div className="w-[460px] max-w-[94vw] rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Server className="h-4 w-4 text-muted-foreground" />
            SFTP 连接
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 px-4 py-4">
          <label className="col-span-2 grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">显示名</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="可选，默认 user@host" />
          </label>
          <label className="col-span-2 grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">分组</span>
            <Input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="可选，用于侧边栏分组管理"
              className="pr-7"
            />
          </label>
          <label className="grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">主机</span>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
          </label>
          <label className="grid grid-cols-[48px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">端口</span>
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 22)}
            />
          </label>
          <label className="col-span-2 grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">用户名</span>
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="登录用户" />
          </label>
          <label className="col-span-2 grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">根目录</span>
            <Input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="可选，默认远程家目录" />
          </label>

          {/* 认证方式切换 */}
          <div className="col-span-2 mt-1 flex gap-1">
            <Button
              type="button"
              variant={authMode === "Password" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1 text-xs"
              onClick={() => setAuthMode("Password")}
            >
              <Lock className="mr-1 h-3 w-3" /> 密码
            </Button>
            <Button
              type="button"
              variant={authMode === "PublicKey" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1 text-xs"
              onClick={() => setAuthMode("PublicKey")}
            >
              <KeyRound className="mr-1 h-3 w-3" /> 私钥
            </Button>
          </div>

          {authMode === "Password" ? (
            <div className="col-span-2 grid gap-2">
              <label className="grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
                <span className="text-muted-foreground">密码</span>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={savePassword}
                  onCheckedChange={(v) => setSavePassword(v === true)}
                />
                记住密码（主密钥加密后保存到配置目录）
              </label>
            </div>
          ) : (
            <div className="col-span-2 grid gap-2">
              <label className="grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
                <span className="text-muted-foreground">私钥</span>
                <Input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="留空自动探测 ~/.ssh/id_*"
                />
              </label>
              <label className="grid grid-cols-[70px_1fr] items-center gap-2 text-xs">
                <span className="text-muted-foreground">口令</span>
                <Input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="加密私钥口令（可选）"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={savePassphrase}
                  onCheckedChange={(v) => setSavePassphrase(v === true)}
                />
                记住口令（主密钥加密后保存到配置目录）
              </label>
            </div>
          )}

          {error && (
            <div className="col-span-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="col-span-2 mt-1 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <FolderCog className="h-3 w-3" />
              {masterKey.active ? "主密钥已解锁（本会话）" : masterKey.configured ? "已设置主密钥" : "未设置主密钥"}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
                取消
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={loading}>
                {loading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                连接
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
