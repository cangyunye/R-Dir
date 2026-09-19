import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Keyboard,
  Moon,
  Puzzle,
  RotateCcw,
  Share2,
  Sun,
  Type,
  X,
} from "lucide-react";
import {
  ACTIONS,
  bindingOf,
  clearUserBinding,
  findConflicts,
  formatBinding,
  hasCustomBinding,
  isMac,
  keyEventString,
  resetUserBindings,
  setUserBinding,
} from "@/lib/keymap";
import { cn } from "@/lib/utils";
import type { PluginInfo } from "@/lib/openerApi";
import {
  loadShareAllowParent,
  saveShareAllowParent,
  loadShareDefaultExpires,
  saveShareDefaultExpires,
} from "@/lib/persist";

/**
 * 设置对话框（M5 P2）
 * - 外观：浅色 / 深色主题（持久化到 localStorage）
 * - 快捷键：点击"录制"按组合键自定义（当前平台），Esc 取消，冲突检测，恢复默认
 */
export function SettingsDialog({
  open,
  onClose,
  dark,
  onToggleTheme,
  onBindingsChanged,
  plugins,
  onTogglePlugin,
  uiFontSize,
  onUiFontChange,
}: {
  open: boolean;
  onClose: () => void;
  dark: boolean;
  onToggleTheme: () => void;
  onBindingsChanged: () => void;
  /** v0.5 插件清单（设置 → 插件分区） */
  plugins: PluginInfo[] | null;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  /** v0.8 界面字体大小（10–18，默认 13，作用于整个界面） */
  uiFontSize: number;
  onUiFontChange: (n: number) => void;
}) {
  /** v0.7 分享设置 */
  const [shareAllowParent, setShareAllowParent] = useState(() => loadShareAllowParent());
  const [shareExpiresHours, setShareExpiresHours] = useState<number | null>(() => loadShareDefaultExpires());
  /** 正在录制键位的 actionId（null = 未录制） */
  const [recordingId, setRecordingId] = useState<string | null>(null);
  /** v0.8 分类导航当前分区 */
  const [section, setSection] = useState<"appearance" | "keys" | "share" | "plugins">("appearance");
  /** 冲突提示（combo → 占用者 label） */
  const [conflict, setConflict] = useState<string | null>(null);
  /** 本地操作反馈（已绑定 / 已恢复） */
  const [tip, setTip] = useState<string | null>(null);
  const tipTimer = useRef<number | null>(null);

  const flashTip = useCallback((msg: string) => {
    setTip(msg);
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(null), 2500);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setRecordingId(null);
        setConflict(null);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // 打开/关闭时重置录制状态
  useEffect(() => {
    if (!open) {
      setRecordingId(null);
      setConflict(null);
    }
  }, [open]);

  const startRecording = useCallback((actionId: string) => {
    setRecordingId(actionId);
    setConflict(null);
  }, []);

  // 录制监听：全局捕获按键
  useEffect(() => {
    if (recordingId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const combo = keyEventString(e);
      if (!combo) return;
      const taken = findConflicts(combo, recordingId);
      if (taken.length > 0) {
        setConflict(`${formatBinding(combo)} 已被「${taken[0].label}」使用，请换一个组合键`);
        return;
      }
      setUserBinding(recordingId, combo);
      setRecordingId(null);
      setConflict(null);
      onBindingsChanged();
      flashTip(`已为「${ACTIONS.find((a) => a.id === recordingId)?.label}」绑定 ${formatBinding(combo)}`);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingId, onBindingsChanged, flashTip]);

  const handleResetOne = useCallback(
    (actionId: string) => {
      clearUserBinding(actionId);
      onBindingsChanged();
    },
    [onBindingsChanged],
  );

  const handleResetAll = useCallback(() => {
    resetUserBindings();
    setRecordingId(null);
    setConflict(null);
    onBindingsChanged();
    flashTip("已恢复全部默认键位");
  }, [onBindingsChanged, flashTip]);

  if (!open) return null;

  const groups = [...new Set(ACTIONS.map((a) => a.group))];

  const sections: { id: "appearance" | "keys" | "share" | "plugins"; label: string; icon: React.ReactNode }[] = [
    { id: "appearance", label: "外观", icon: <Sun className="h-4 w-4" /> },
    { id: "keys", label: "快捷键", icon: <Keyboard className="h-4 w-4" /> },
    { id: "share", label: "分享", icon: <Share2 className="h-4 w-4" /> },
    { id: "plugins", label: "插件", icon: <Puzzle className="h-4 w-4" /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[82vh] w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Keyboard className="h-4 w-4" /> 设置
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭（Esc）"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左侧分类导航 */}
          <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r p-2">
            {sections.map((sec) => (
              <button
                key={sec.id}
                onClick={() => setSection(sec.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                  section === sec.id
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {sec.icon}
                {sec.label}
              </button>
            ))}
          </nav>

          {/* 右侧内容区 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {section === "appearance" && (
              <>
                {/* 外观：主题 */}
                <div className="mb-4">
                  <div className="mb-1.5 text-xs font-semibold text-primary">主题</div>
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                    <span className="text-foreground">颜色模式</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          if (dark) onToggleTheme();
                        }}
                        className={cn(
                          "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
                          !dark
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-accent",
                        )}
                      >
                        <Sun className="h-3.5 w-3.5" /> 浅色
                      </button>
                      <button
                        onClick={() => {
                          if (!dark) onToggleTheme();
                        }}
                        className={cn(
                          "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
                          dark
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-accent",
                        )}
                      >
                        <Moon className="h-3.5 w-3.5" /> 深色
                      </button>
                    </div>
                  </div>
                </div>

                {/* 外观：界面字体（v0.8，整体缩放等效，13px = 100%） */}
                <div className="mb-4">
                  <div className="mb-1.5 text-xs font-semibold text-primary">界面字体</div>
                  <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                    <span className="flex items-center gap-1.5 text-foreground">
                      <Type className="h-3.5 w-3.5 text-muted-foreground" />
                      字体大小（整体缩放，作用于整个界面）
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={10}
                        max={18}
                        step={1}
                        value={uiFontSize}
                        onChange={(e) => onUiFontChange(Number(e.target.value))}
                        className="w-32"
                        title="10–18px（默认 13）"
                      />
                      <span className="w-9 rounded border bg-muted px-1 py-0.5 text-center font-mono text-[11px]">
                        {uiFontSize}px
                      </span>
                    </div>
                  </div>
                  <p className="mt-1 pl-1 text-[11px] text-muted-foreground">
                    默认 13px；与窗口内 Ctrl+滚轮缩放相互叠加（如 80% 字体 × 130% 窗口 = 104%）。
                  </p>
                </div>
              </>
            )}

            {section === "keys" && (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold text-primary">快捷键</div>
                  <button
                    onClick={handleResetAll}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="恢复全部默认键位"
                  >
                    <RotateCcw className="h-3 w-3" /> 恢复默认
                  </button>
                </div>

                {conflict && (
                  <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    ⚠ {conflict}
                  </div>
                )}

                {recordingId !== null && (
                  <div className="mb-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground">
                    🎹 正在为「{ACTIONS.find((a) => a.id === recordingId)?.label}」录制新键位 —— 请按下组合键（Esc 取消）
                  </div>
                )}

                {tip && (
                  <div className="mb-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground">
                    ✓ {tip}
                  </div>
                )}

                <p className="mb-3 text-xs text-muted-foreground">
                  点击每行右侧的“录制”可自定义当前平台键位（{isMac ? "macOS" : "Windows"}）；带 ● 的为已自定义项，再点“×”恢复默认。
                </p>

                {groups.map((g) => (
                  <div key={g} className="mb-4">
                    <div className="mb-1.5 text-xs font-semibold text-primary">{g}</div>
                    <div className="overflow-hidden rounded-md border">
                      {ACTIONS.filter((a) => a.group === g).map((a, i, arr) => {
                        const custom = hasCustomBinding(a.id);
                        const recording = recordingId === a.id;
                        return (
                          <div
                            key={a.id}
                            className={
                              "flex items-center justify-between gap-3 px-3 py-1.5 text-xs " +
                              (i < arr.length - 1 ? "border-b " : "") +
                              (i % 2 === 0 ? "bg-muted/30" : "")
                            }
                          >
                            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
                              {custom && (
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                                  title="已自定义"
                                />
                              )}
                              <span className="truncate">{a.label}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <kbd
                                className={cn(
                                  "rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground",
                                  recording && "animate-pulse border-primary/60",
                                )}
                              >
                                {formatBinding(bindingOf(a))}
                              </kbd>
                              {recording ? (
                                <span className="px-1 text-[11px] text-primary">按下组合键…</span>
                              ) : (
                                <>
                                  <button
                                    onClick={() => startRecording(a.id)}
                                    className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                    title="录制新键位"
                                  >
                                    录制
                                  </button>
                                  {custom && (
                                    <button
                                      onClick={() => handleResetOne(a.id)}
                                      className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                      title="恢复此动作默认键位"
                                    >
                                      ×
                                    </button>
                                  )}
                                </>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </>
            )}

            {section === "share" && (
              <>
                <div className="mb-4">
                  <div className="mb-1.5 text-xs font-semibold text-primary">分享</div>
                  <div className="mb-2 rounded-md border px-3 py-2 text-[11px] text-muted-foreground">
                    分享为链接时的默认行为：是否允许接收方上溯父目录（默认关闭，严格锁定分享根内）、默认有效期。
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span>允许接收方上溯到父目录（仅浏览）</span>
                      <input
                        type="checkbox"
                        checked={shareAllowParent}
                        onChange={(e) => {
                          setShareAllowParent(e.target.checked);
                          saveShareAllowParent(e.target.checked);
                        }}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                      <span>默认有效期（小时）</span>
                      <input
                        type="number"
                        min={1}
                        placeholder="永久"
                        value={shareExpiresHours ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          const n = Number(v);
                          if (v === "" || !Number.isFinite(n) || n <= 0) {
                            setShareExpiresHours(null);
                            saveShareDefaultExpires(null);
                          } else {
                            setShareExpiresHours(n);
                            saveShareDefaultExpires(n);
                          }
                        }}
                        className="w-24 rounded border bg-background px-2 py-1 text-right"
                      />
                    </label>
                    <p className="pl-1 text-[11px] text-muted-foreground">
                      留空 = 永久（直到关闭客户端或主动停止分享）。
                    </p>
                  </div>
                </div>
              </>
            )}

            {section === "plugins" && (
              <>
                <div className="mb-4">
                  <div className="mb-1.5 text-xs font-semibold text-primary">插件</div>
                  <div className="mb-2 rounded-md border px-3 py-2 text-[11px] text-muted-foreground">
                    内置插件按统一契约登记（协议前缀 + 操作集 + 启用开关）。禁用后对应入口隐藏、
                    路由拒绝；未来外置插件（如 http-autoindex）沿用同一注册表接入。
                  </div>
                  <div className="space-y-2">
                    {plugins === null ? (
                      <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                        正在加载插件清单…
                      </div>
                    ) : (
                      plugins.map((p) => (
                        <div key={p.id} className="rounded-md border px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-xs font-medium">{p.name}</span>
                              <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                v{p.version}
                              </span>
                              <span className="shrink-0 rounded-sm bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
                                {p.source === "builtin" ? "内置" : "外置"}
                              </span>
                              {p.configurable && (
                                <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                  可配置
                                </span>
                              )}
                            </div>
                            <button
                              role="switch"
                              aria-checked={p.enabled}
                              onClick={() => onTogglePlugin(p.id, !p.enabled)}
                              className={cn(
                                "relative h-4.5 w-8 shrink-0 rounded-full transition-colors",
                                p.enabled ? "bg-primary" : "bg-muted",
                              )}
                            >
                              <span
                                className={cn(
                                  "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-all",
                                  p.enabled ? "left-4" : "left-0.5",
                                )}
                              />
                            </button>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">{p.description}</div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {p.protocols.map((proto) => (
                              <span
                                key={proto}
                                className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                              >
                                {proto}
                              </span>
                            ))}
                            {p.operations.map((op) => (
                              <span
                                key={op}
                                className="rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                              >
                                {op}
                              </span>
                            ))}
                            {p.protocols.length === 0 && p.operations.length === 0 && (
                              <span className="text-[10px] text-muted-foreground">无协议 / 无操作声明</span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Check className="h-3 w-3" /> 配置自动保存在本机（localStorage）
          </span>
          <span>{isMac ? "macOS" : "Windows"} 键位</span>
        </div>
      </div>
    </div>
  );
}
