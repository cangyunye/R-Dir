import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  Download,
  ExternalLink,
  Eye,
  Globe,
  Info,
  Keyboard,
  Monitor,
  Moon,
  Plus,
  Star,
  Wrench,
  Puzzle,
  RotateCcw,
  Settings,
  Share2,
  Sun,
  Trash2,
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
import type { ThemeMode } from "@/lib/types";
import { quickInitials, quickTileColor } from "@/components/EntryContextMenu";
import type { QuickToolItem, EditorCandidate } from "@/lib/openerApi";
import type { OpenerItem, PluginInfo } from "@/lib/openerApi";
import { normalizeExts } from "@/lib/openers";
import { useModalLayer } from "@/hooks/useModalLayer";
import { isTopModalLayer } from "@/lib/modal-stack";
import {
  PREVIEW_WIDTH_MAX,
  PREVIEW_WIDTH_MIN,
  loadShareAllowParent,
  saveShareAllowParent,
  loadShareDefaultExpires,
  saveShareDefaultExpires,
  saveUiFontFamilyCustom,
} from "@/lib/persist";

/** 设置分区标识（左栏导航 + 右栏锚点共用） */
export type SectionId = "appearance" | "preview" | "keys" | "openers" | "quickTools" | "favorites" | "share" | "plugins" | "about";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "外观", icon: <Sun className="h-4 w-4" /> },
  { id: "preview", label: "预览", icon: <Eye className="h-4 w-4" /> },
  { id: "keys", label: "快捷键", icon: <Keyboard className="h-4 w-4" /> },
  { id: "openers", label: "打开方式", icon: <ExternalLink className="h-4 w-4" /> },
  { id: "quickTools", label: "常用工具", icon: <Wrench className="h-4 w-4" /> },
  { id: "favorites", label: "收藏夹", icon: <Star className="h-4 w-4" /> },
  { id: "share", label: "分享", icon: <Share2 className="h-4 w-4" /> },
  { id: "plugins", label: "插件", icon: <Puzzle className="h-4 w-4" /> },
  { id: "about", label: "关于", icon: <Info className="h-4 w-4" /> },
];

/**
 * 设置对话框（M5 P2）
 * - 外观：颜色模式 浅色 / 深色 / 跟随系统（持久化到 localStorage，system 随系统实时切换）
 * - 快捷键：点击"录制"按组合键自定义（当前平台），Esc 取消，冲突检测，恢复默认
 */
export function SettingsDialog({
  open,
  onClose,
  themeMode,
  onThemeModeChange,
  onBindingsChanged,
  previewEnabled,
  onPreviewEnabledChange,
  previewWidth,
  onPreviewWidthChange,
  plugins,
  onTogglePlugin,
  uiFontSize,
  onUiFontChange,
  uiFontFamily,
  onUiFontFamilyChange,
  fontFamilies,
  openers,
  onAddOpener,
  onRemoveOpener,
  onSetOpenerExtensions,
  jumpTo,
  quickTools,
  editorSuggestions,
  onAddQuickTool,
  onAddSuggestedTool,
  onRemoveQuickTool,
  onMoveQuickTool,
  onSetQuickToolArgs,
  appName,
  appVersion,
  onOpenRepo,
  onOpenDocs,
  onCheckUpdate,
  onOpenFavorites,
}: {
  open: boolean;
  onClose: () => void;
  /** 主题颜色模式：显式浅色/深色，或跟随系统 */
  themeMode: ThemeMode;
  onThemeModeChange: (m: ThemeMode) => void;
  onBindingsChanged: () => void;
  /** v0.28 预览栏总开关（默认关）与默认宽度 */
  previewEnabled: boolean;
  onPreviewEnabledChange: (v: boolean) => void;
  previewWidth: number;
  onPreviewWidthChange: (n: number) => void;
  /** v0.5 插件清单（设置 → 插件分区） */
  plugins: PluginInfo[] | null;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  /** v0.8 界面字体大小（10–18，默认 13，作用于整个界面） */
  uiFontSize: number;
  onUiFontChange: (n: number) => void;
  uiFontFamily: string;
  onUiFontFamilyChange: (id: string) => void;
  fontFamilies: { id: string; label: string }[];
  /** v0.11 打开方式（扩展名关联管理） */
  openers: OpenerItem[];
  onAddOpener: () => void;
  onRemoveOpener: (id: string) => void;
  onSetOpenerExtensions: (id: string, extensions: string[]) => void;
  /** v0.29.0 打开时跳转到的分区（常用条「＋」入口；null = 从头显示） */
  jumpTo?: SectionId | null;
  /** v0.29.0 常用工具条（右键菜单第一行横排图标） */
  quickTools: QuickToolItem[];
  editorSuggestions: EditorCandidate[];
  onAddQuickTool: () => void;
  onAddSuggestedTool: (c: EditorCandidate) => void;
  onRemoveQuickTool: (id: string) => void;
  onMoveQuickTool: (id: string, up: boolean) => void;
  /** v0.31.1 启动参数串（占位符 {path} / {dir} / $pwd / {name}；空 = 默认行为） */
  onSetQuickToolArgs?: (id: string, args: string) => void;
  /** 应用名 / 版本（getVersion = tauri.conf.json 版本，随 tag 同步） */
  appName: string;
  appVersion: string;
  onOpenRepo: () => void;
  /** 打开使用指南站点 */
  onOpenDocs: () => void;
  onCheckUpdate: () => void;
  /** 打开收藏夹面板（收藏夹分区入口按钮；先关设置再弹面板） */
  onOpenFavorites: () => void;
}) {
  /** v0.7 分享设置 */
  const [shareAllowParent, setShareAllowParent] = useState(() => loadShareAllowParent());
  const [shareExpiresHours, setShareExpiresHours] = useState<number | null>(() => loadShareDefaultExpires());
  /** 正在录制键位的 actionId（null = 未录制） */
  const [recordingId, setRecordingId] = useState<string | null>(null);
  /** v0.8 分类导航当前分区（由滚动位置反推，用于左栏高亮） */
  const [section, setSection] = useState<SectionId>("appearance");
  /** 右栏滚动容器 + 各分区锚点（左栏点击 → 滚动定位） */
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLDivElement | null>>>({});
  /** v0.11 每个打开方式的「新增扩展名」输入草稿 */
  const [extInput, setExtInput] = useState<Record<string, string>>({});
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

  /** 点击左栏 → 平滑滚动到对应分区 */
  const scrollToSection = useCallback((id: SectionId) => {
    setSection(id);
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // v0.29.0 外部指定分区（常用条「＋」→ 设置 → 常用工具）：打开时滚动定位
  useEffect(() => {
    if (!open || !jumpTo) return;
    if (SECTIONS.some((sec) => sec.id === jumpTo)) scrollToSection(jumpTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jumpTo]);

  /** 右栏滚动 → 反推当前分区，同步左栏高亮 */
  const handleScroll = useCallback(() => {
    const c = scrollRef.current;
    if (!c) return;
    const cTop = c.getBoundingClientRect().top;
    let current: SectionId = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = sectionRefs.current[s.id];
      if (el && el.getBoundingClientRect().top - cTop <= 24) current = s.id;
    }
    setSection((prev) => (prev === current ? prev : current));
  }, []);

  // v0.34.1 弹层栈登记：本框 Esc 只在栈顶时生效（更高层弹层打开时让位）
  useModalLayer("settings", 50, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 录制中 Esc = 取消录制，由下方录制监听器处理，不关整个对话框
        // （此前监听注册顺序更早先执行，按 Esc 会把整个设置一起关掉）
        if (recordingId !== null) return;
        // 栈顶仲裁：更高层弹层打开时让位，避免一次 Esc 关多层
        if (!isTopModalLayer("settings")) return;
        e.stopPropagation();
        setConflict(null);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, recordingId]);

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

  return (
    <div
      className="settings-overlay fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-glass flex h-[min(600px,85vh)] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Settings className="h-4 w-4" /> 设置
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
          <nav className="flex w-36 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                onClick={() => scrollToSection(sec.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                  section === sec.id
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {sec.icon}
                {sec.label}
              </button>
            ))}
          </nav>

          {/* 右侧内容区 */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          >
            <div
              ref={(el) => { sectionRefs.current.appearance = el; }}
              data-settings-section="appearance"
              className="scroll-mt-3 mb-6"
            >
                {/* 外观：主题（浅色 / 深色 / 跟随系统） */}
                <div className="mb-5">
                  <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">主题</div>
                  <div className="overflow-hidden rounded-md border bg-card">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
                      <span className="text-foreground">颜色模式</span>
                      <div className="flex gap-1">
                        {(
                          [
                            ["light", <Sun key="s" className="h-3.5 w-3.5" />, "浅色"],
                            ["dark", <Moon key="m" className="h-3.5 w-3.5" />, "深色"],
                            ["system", <Monitor key="w" className="h-3.5 w-3.5" />, "跟随系统"],
                          ] as [ThemeMode, React.ReactNode, string][]
                        ).map(([mode, icon, label]) => (
                          <button
                            key={mode}
                            aria-pressed={themeMode === mode}
                            onClick={() => onThemeModeChange(mode)}
                            className={cn(
                              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
                              themeMode === mode
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:bg-accent",
                            )}
                          >
                            {icon} {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 外观：界面字体（v0.8，整体缩放等效，13px = 100%） */}
                <div>
                  <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">界面字体</div>
                  <div className="overflow-hidden rounded-md border bg-card">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
                      <span className="flex items-center gap-1.5 text-foreground">
                        <Type className="h-3.5 w-3.5 text-muted-foreground" />
                        字体大小
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
                        <span className="w-9 rounded bg-muted px-1 py-0.5 text-center font-mono text-[11px] tabular-nums">
                          {uiFontSize}px
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5 text-xs">
                      <span className="flex items-center gap-1.5 text-foreground">
                        <Type className="h-3.5 w-3.5 text-muted-foreground" />
                        字体族
                      </span>
                      <div className="flex items-center gap-2">
                        <select
                          value={uiFontFamily}
                          onChange={(e) => onUiFontFamilyChange(e.target.value)}
                          className="rounded border bg-background px-2 py-1 text-xs"
                        >
                          {fontFamilies.map((f) => (
                            <option key={f.id} value={f.id}>{f.label}</option>
                          ))}
                        </select>
                        {uiFontFamily === "custom" && (
                          <input
                            type="text"
                            placeholder="输入字体名，如 Consolas"
                            className="w-40 rounded border bg-background px-2 py-1 text-xs"
                            onBlur={(e) => {
                              if (e.target.value.trim()) {
                                saveUiFontFamilyCustom(e.target.value.trim());
                                // 触发重渲染
                                onUiFontFamilyChange("custom");
                              }
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    整体缩放，作用于整个界面；默认 13px，与窗口内 Ctrl+滚轮缩放相互叠加（如 80% 字体 × 130% 窗口 = 104%）。
                  </p>
                </div>
            </div>

            {/* v0.28 预览：右侧拉门总开关 + 键位 + 默认宽度（总开关默认关，点文件不直接预览） */}
            <div
              ref={(el) => { sectionRefs.current.preview = el; }}
              data-settings-section="preview"
              className="scroll-mt-3 mb-6"
            >
                <div className="mb-5">
                  <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">预览栏</div>
                  <div className="overflow-hidden rounded-md border bg-card">
                    <label
                      role="switch"
                      aria-checked={previewEnabled}
                      data-testid="preview-toggle"
                      className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-xs"
                      onClick={() => onPreviewEnabledChange(!previewEnabled)}
                    >
                      <span>启用预览栏</span>
                      <SwitchVisual checked={previewEnabled} />
                    </label>
                    <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5 text-xs">
                      <span>预览栏默认宽度</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={PREVIEW_WIDTH_MIN}
                          max={PREVIEW_WIDTH_MAX}
                          step={8}
                          value={previewWidth}
                          onChange={(e) => onPreviewWidthChange(Number(e.target.value))}
                          className="w-32"
                          title={`${PREVIEW_WIDTH_MIN}–${PREVIEW_WIDTH_MAX}px`}
                        />
                        <span className="w-12 rounded bg-muted px-1 py-0.5 text-center font-mono text-[11px] tabular-nums">
                          {previewWidth}px
                        </span>
                      </div>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    开启后右侧滑出预览栏（悬浮拉门，不挤压布局；全应用共用，跟随焦点窗格的选中项），点文件不会直接预览；图片/文本/PDF/Office 可预览，其余类型显示信息卡。
                  </p>
                </div>

                <div>
                  <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">预览键位</div>
                  <div className="overflow-hidden rounded-md border bg-card">
                    {["togglePreview", "toggleBrowse"].map((id, i, arr) => {
                      const a = ACTIONS.find((x) => x.id === id);
                      if (!a) return null;
                      const custom = hasCustomBinding(a.id);
                      const recording = recordingId === a.id;
                      return (
                        <div
                          key={a.id}
                          className={
                            "flex items-center justify-between gap-3 px-3 py-1.5 text-xs " +
                            (i < arr.length - 1 ? "border-b" : "")
                          }
                        >
                          <span className="flex min-w-0 items-center gap-1.5 text-foreground">
                            {custom && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="已自定义" />}
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
                  <p className="mt-1 pl-1 text-[11px] text-muted-foreground">
                    图文浏览模式：在图片/文档为主的目录进入沉浸浏览（中央大图 + 底部缩略图条）。
                  </p>
                </div>
            </div>

            <div
              ref={(el) => { sectionRefs.current.keys = el; }}
              data-settings-section="keys"
              className="scroll-mt-3 mb-6"
            >
                <div className="mb-2 flex items-center justify-between">
                  <div className="sec-t text-[11px] font-medium text-muted-foreground">快捷键</div>
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
                    <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">{g}</div>
                    <div className="overflow-hidden rounded-md border bg-card">
                      {ACTIONS.filter((a) => a.group === g).map((a, i, arr) => {
                        const custom = hasCustomBinding(a.id);
                        const recording = recordingId === a.id;
                        return (
                          <div
                            key={a.id}
                            className={
                              "flex items-center justify-between gap-3 px-3 py-1.5 text-xs " +
                              (i < arr.length - 1 ? "border-b" : "")
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
            </div>

            <div
              ref={(el) => { sectionRefs.current.openers = el; }}
              data-settings-section="openers"
              className="scroll-mt-3 mb-6"
            >
                <div className="mb-2 flex items-center justify-between">
                  <div className="sec-t text-[11px] font-medium text-muted-foreground">打开方式</div>
                  <button
                    onClick={onAddOpener}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="选择应用程序添加"
                  >
                    <Plus className="h-3 w-3" /> 添加
                  </button>
                </div>
                <p className="mb-3 text-[11px] text-muted-foreground">
                  每个打开方式只对已关联的扩展名生效（<span className="font-mono">*</span> 表示所有类型）。
                  右键文件 → 打开方式 → 选择其他应用… 会自动关联该文件的扩展名。
                </p>

                {openers.length === 0 ? (
                  <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                    还没有自定义打开方式。右键文件 → 打开方式 → 选择其他应用… 添加。
                  </div>
                ) : (
                  <div className="space-y-2">
                    {openers.map((o) => (
                      <div key={o.id} className="rounded-md border bg-card px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-xs font-medium">{o.name}</span>
                            {!o.detected && (
                              <span className="shrink-0 rounded-sm bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive">
                                未找到
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => onRemoveOpener(o.id)}
                            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            title="删除此打开方式"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={o.exec ?? ""}>
                          {o.exec}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          {o.extensions.length === 0 ? (
                            <span className="text-[10px] text-muted-foreground">
                              未关联任何类型（不会出现在右键）
                            </span>
                          ) : (
                            o.extensions.map((ext) => (
                              <span
                                key={ext}
                                className="flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                              >
                                {ext}
                                <button
                                  onClick={() =>
                                    onSetOpenerExtensions(
                                      o.id,
                                      o.extensions.filter((x) => x !== ext),
                                    )
                                  }
                                  className="text-muted-foreground transition-colors hover:text-destructive"
                                  title="移除该扩展名"
                                >
                                  ×
                                </button>
                              </span>
                            ))
                          )}
                        </div>
                        <form
                          className="mt-1.5 flex items-center gap-1.5"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const parts = (extInput[o.id] ?? "")
                              .split(/[\s,，、;；]+/)
                              .filter(Boolean);
                            if (parts.length === 0) return;
                            onSetOpenerExtensions(
                              o.id,
                              normalizeExts([...o.extensions, ...parts]),
                            );
                            setExtInput((s) => ({ ...s, [o.id]: "" }));
                          }}
                        >
                          <input
                            value={extInput[o.id] ?? ""}
                            onChange={(e) =>
                              setExtInput((s) => ({ ...s, [o.id]: e.target.value }))
                            }
                            placeholder="如 json, yaml（逗号/空格分隔，回车添加）"
                            className="w-72 rounded border bg-background px-2 py-1 text-[11px]"
                          />
                          <button
                            type="submit"
                            className="shrink-0 rounded border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            添加
                          </button>
                        </form>
                      </div>
                    ))}
                  </div>
                )}
            </div>

            <div
              ref={(el) => { sectionRefs.current.quickTools = el; }}
              data-settings-section="quickTools"
              className="scroll-mt-3 mb-6"
            >
                <div className="mb-2 flex items-center justify-between">
                  <div className="sec-t text-[11px] font-medium text-muted-foreground">常用工具</div>
                  <button
                    onClick={onAddQuickTool}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="选择应用程序添加"
                  >
                    <Plus className="h-3 w-3" /> 添加
                  </button>
                </div>
                <p className="mb-3 text-[11px] text-muted-foreground">
                  右键菜单第一行按此顺序横排显示（最多 10 个）：点图标直接用该工具打开当前目录（作为工作区）或文件。
                  与「打开方式」的按扩展名关联互不影响。
                </p>
                <p className="mb-3 text-[11px] text-muted-foreground">
                  每个工具可填<b>启动参数</b>，支持占位符
                  <code className="mx-0.5 rounded bg-muted px-1">$pwd</code>/
                  <code className="mx-0.5 rounded bg-muted px-1">{"{dir}"}</code>（当前目录）、
                  <code className="mx-0.5 rounded bg-muted px-1">{"{path}"}</code>（当前目录或所选文件完整路径）、
                  <code className="mx-0.5 rounded bg-muted px-1">{"{name}"}</code>（文件名）。
                  留空 = 默认：终端类（Git Bash / cmd / PowerShell / bash…）直接在当前目录开窗，其余工具以路径为参数打开；
                  非终端工具的参数里没写占位符时，路径自动补在末尾。
                </p>

                {quickTools.length === 0 ? (
                  <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                    还没有常用工具。点右上角「添加」选择应用，或从下方检测列表一键加入。
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {quickTools.map((t, i) => (
                      <div key={t.id} className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5">
                        <span
                          className={cn(
                            "flex h-6 w-6 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white",
                            !t.detected && "opacity-40",
                          )}
                          style={{ background: quickTileColor(t.name) }}
                        >
                          {quickInitials(t.name)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-medium">{t.name}</span>
                            {!t.detected && (
                              <span className="shrink-0 rounded-sm bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive">
                                未找到
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground" title={t.exec}>
                            {t.exec}
                          </div>
                          <QuickToolArgsInput
                            toolId={t.id}
                            value={t.args ?? ""}
                            onCommit={(v) => onSetQuickToolArgs?.(t.id, v)}
                          />
                        </div>
                        <button
                          onClick={() => onMoveQuickTool(t.id, true)}
                          disabled={i === 0}
                          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
                          title="上移"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => onMoveQuickTool(t.id, false)}
                          disabled={i === quickTools.length - 1}
                          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
                          title="下移"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => onRemoveQuickTool(t.id)}
                          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          title="移除此常用工具"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {editorSuggestions.filter((c) => !quickTools.some((q) => q.id === c.id)).length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1.5 text-[10px] text-muted-foreground">
                      检测到本机已安装（点击一键加入）：
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {editorSuggestions
                        .filter((c) => !quickTools.some((q) => q.id === c.id))
                        .map((c) => (
                          <button
                            key={c.id}
                            onClick={() => onAddSuggestedTool(c)}
                            title={c.exec}
                            className="flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <span
                              className="flex h-4 w-4 items-center justify-center rounded text-[8px] font-bold text-white"
                              style={{ background: quickTileColor(c.name) }}
                            >
                              {quickInitials(c.name)}
                            </span>
                            {c.name}
                            <Plus className="h-3 w-3" />
                          </button>
                        ))}
                    </div>
                  </div>
                )}
            </div>

            <div
              ref={(el) => { sectionRefs.current.favorites = el; }}
              data-settings-section="favorites"
              className="scroll-mt-3 mb-6"
            >
                <div>
                  <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">收藏夹</div>
                  <p className="mb-2.5 text-[11px] text-muted-foreground">
                    收藏 = 单个标签页的命名布局快照：全部窗格路径、分屏结构、视图/缩放状态。
                    打开收藏会在新标签页还原（本地路径直接加载，SFTP 窗格自动重连）。
                    与「保存并退出」的整体会话互不影响。
                  </p>
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      入口：右键标签页「收藏此标签页」、空白处右键「收藏夹…」、
                      快捷键
                      <kbd className="mx-1 rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                        {formatBinding(bindingOf(ACTIONS.find((a) => a.id === "openFavorites")!))}
                      </kbd>
                      （可在「快捷键」分区改键）、或下方按钮。
                    </p>
                    <button
                      onClick={() => {
                        onClose();
                        onOpenFavorites();
                      }}
                      className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Star className="h-3.5 w-3.5" />
                      打开收藏夹面板…
                    </button>
                  </div>
                </div>
            </div>

            <div
              ref={(el) => { sectionRefs.current.share = el; }}
              data-settings-section="share"
              className="scroll-mt-3 mb-6"
            >
                <div>
                  <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">分享</div>
                  <p className="mb-2.5 text-[11px] text-muted-foreground">
                    分享为链接时的默认行为：是否允许接收方上溯父目录（默认关闭，严格锁定分享根内）、默认有效期。
                  </p>
                  <div className="overflow-hidden rounded-md border bg-card">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
                      <span>允许接收方上溯到父目录（仅浏览）</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={shareAllowParent}
                        aria-label="允许接收方上溯到父目录"
                        className="flex cursor-pointer"
                        onClick={() => {
                          setShareAllowParent(!shareAllowParent);
                          saveShareAllowParent(!shareAllowParent);
                        }}
                      >
                        <SwitchVisual checked={shareAllowParent} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5 text-xs">
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
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    留空 = 永久（直到关闭客户端或主动停止分享）。
                  </p>
                </div>
            </div>

            <div
              ref={(el) => { sectionRefs.current.plugins = el; }}
              data-settings-section="plugins"
              className="scroll-mt-3 mb-6"
            >
                <div>
                  <div className="sec-t mb-1.5 text-[11px] font-medium text-muted-foreground">插件</div>
                  <p className="mb-2.5 text-[11px] text-muted-foreground">
                    内置插件按统一契约登记（协议前缀 + 操作集 + 启用开关）。禁用后对应入口隐藏、
                    路由拒绝；未来外置插件（如 http-autoindex）沿用同一注册表接入。
                  </p>
                  <div className="space-y-2">
                    {plugins === null ? (
                      <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                        正在加载插件清单…
                      </div>
                    ) : (
                      plugins.map((p) => (
                        <div key={p.id} className="rounded-md border bg-card px-3 py-2">
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
                              type="button"
                              role="switch"
                              aria-checked={p.enabled}
                              onClick={() => onTogglePlugin(p.id, !p.enabled)}
                              className="flex shrink-0 cursor-pointer"
                            >
                              <SwitchVisual checked={p.enabled} />
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
            </div>

            <div
              ref={(el) => { sectionRefs.current.about = el; }}
              data-settings-section="about"
              className="scroll-mt-3"
            >
              <div className="space-y-3">
                <div className="flex items-center gap-3 rounded-md border px-3 py-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Info className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">{appName}</div>
                    <div className="text-xs text-muted-foreground">
                      版本 v{appVersion || "—"} · Tauri 2 + React
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={onCheckUpdate}
                    className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
                  >
                    <Download className="h-3.5 w-3.5" /> 检查更新
                  </button>
                  <button
                    onClick={onOpenDocs}
                    className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
                  >
                    <BookOpen className="h-3.5 w-3.5" /> 使用指南
                  </button>
                  <button
                    onClick={onOpenRepo}
                    className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
                  >
                    <Globe className="h-3.5 w-3.5" /> GitHub 仓库
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  版本号取自应用元数据（tauri.conf.json），随发布 tag 同步。
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Check className="h-3 w-3" /> 更改会自动保存
          </span>
          <span>
            {appName} v{appVersion || "—"} · {isMac ? "macOS" : "Windows"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 开关视觉：填充轨道 + 滑块（交互语义由外层 label / button 承担）。
 *  滑块用白色（而非 --background）：深色主题下关闭态轨道与背景同层，深色滑块会看不清。 */
function SwitchVisual({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "flex h-4.5 w-8 shrink-0 items-center rounded-full border px-0.5 transition-colors",
        checked ? "border-transparent bg-primary" : "border-border bg-muted",
      )}
    >
      <span
        className={cn(
          "h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-3" : "translate-x-0",
        )}
      />
    </span>
  );
}

/** 常用工具的启动参数输入（v0.31.1）：本地编辑，失焦 / Enter 提交。
 *  受控值随外部清单刷新同步，避免提交后被旧值覆盖。（Esc 由对话框统一处理 = 关闭设置） */
function QuickToolArgsInput({
  toolId,
  value,
  onCommit,
}: {
  toolId: string;
  value: string;
  onCommit: (args: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v !== value) onCommit(v);
  };
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <span className="shrink-0 text-[10px] text-muted-foreground">启动参数</span>
      <input
        data-testid={`quick-tool-args-${toolId}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
        placeholder="留空 = 默认；例：--cd=$pwd 或 --new-window {path}"
        spellCheck={false}
        className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary"
      />
    </div>
  );
}
