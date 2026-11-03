/**
 * 主题调色盘（v0.39）：右侧覆盖式拉门，与预览栏同款开合机制（translate 200ms，贴边把手）。
 * - 非模态：背后就是真实界面，草稿 token 由 App 经 applyThemePack 实时写到 <html>
 * - 收回（快捷键 / 把手）只是滑出视口，草稿与滑杆状态全保留；[×] 才是关闭并放弃草稿
 * - 调色框按 TOKEN_GROUPS 数据驱动渲染：每行 色块 + 名称 + 值，点色块弹 L/C/H(/A) 滑杆
 * - 全局色相滑杆：旋转主题色系，功能色不动（见 themeEditor.rotateHues）
 * 挂载点：内容行容器（relative），与 PreviewDrawer 并列；z-50 压过预览栏 z-40。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Palette, RotateCcw, Save, X } from "lucide-react";
import { Popover } from "radix-ui";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/LanguageProvider";
import {
  ALPHA_KEYS,
  CHROMA_MAX,
  SHADOW_PRESETS,
  THEME_NAME_MAX,
  TOKEN_GROUPS,
  dominantHue,
  formatOklch,
  isSameDraft,
  isValidThemeId,
  parseColor,
  rotateHues,
  setDraftToken,
  validateDraft,
  type DraftSource,
  type Oklch,
  type TokenKey,
} from "@/lib/themeEditor";
import type { ThemePack } from "@/lib/themePacks";

export const THEME_STUDIO_WIDTH = 360;

export interface ThemeStudioSession {
  /** 起点快照：重置 / 单项恢复原值的基准 */
  origin: ThemePack;
  draft: ThemePack;
  /** 起点名称（内置浅色 / 深色 / 包名），显示在"基于" */
  sourceLabel: string;
}

export function ThemeStudioDrawer({
  session,
  expanded,
  packs,
  shortcutLabel,
  onChange,
  onLoadSource,
  onReset,
  onExpand,
  onCollapse,
  onClose,
  onSave,
  onExport,
}: {
  session: ThemeStudioSession | null;
  expanded: boolean;
  /** 已安装主题包：载入起点下拉 + 重名提示 */
  packs: ThemePack[];
  /** 当前平台的快捷键展示串（提示文案用） */
  shortcutLabel: string;
  onChange: (draft: ThemePack) => void;
  onLoadSource: (source: DraftSource) => void;
  onReset: () => void;
  onExpand: () => void;
  onCollapse: () => void;
  onClose: () => void;
  onSave: () => void;
  onExport: () => void;
}) {
  const t = useT();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  /** 色相拖动起点快照：整段拖动相对同一基准旋转，避免逐帧累加舍入漂移 */
  const hueDrag = useRef<{ tokens: Record<string, string>; hue: number } | null>(null);

  const draft = session?.draft ?? null;
  const dominant = useMemo(() => (draft ? dominantHue(draft.tokens) : null), [draft]);

  if (!session || !draft) return null;
  const { origin } = session;

  const dirty = !isSameDraft(draft, origin);
  const invalid = validateDraft(draft);
  const idTaken = packs.some((p) => p.id === draft.id);

  const toggleGroup = (id: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onHueChange = (v: number) => {
    if (dominant === null) return;
    if (!hueDrag.current) hueDrag.current = { tokens: draft.tokens, hue: dominant };
    onChange({ ...draft, tokens: rotateHues(hueDrag.current.tokens, v - hueDrag.current.hue) });
  };

  const handleSourceSelect = (value: string) => {
    if (value === "light" || value === "dark") onLoadSource(value);
    else if (value.startsWith("pack:")) {
      const pack = packs.find((p) => p.id === value.slice(5));
      if (pack) onLoadSource(pack);
    }
  };

  return (
    <>
      {/* 收起态：贴边把手（错开预览栏把手的位置） */}
      {!expanded && (
        <button
          data-testid="theme-studio-handle"
          onClick={onExpand}
          title={t("展开主题调色盘（{key}）", { key: shortcutLabel })}
          className="absolute right-0 top-[calc(50%+3.5rem)] z-50 flex h-16 w-5 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 bg-background/90 text-primary shadow-md backdrop-blur-sm transition-colors hover:bg-accent"
        >
          <Palette className="h-3.5 w-3.5" />
        </button>
      )}

      <div
        data-testid="theme-studio-drawer"
        className={cn(
          "absolute bottom-0 right-0 top-0 z-50 flex flex-col border-l bg-background/95 shadow-2xl backdrop-blur-sm transition-transform duration-200 ease-out",
          expanded ? "translate-x-0" : "translate-x-full",
        )}
        style={{ width: THEME_STUDIO_WIDTH }}
        aria-hidden={!expanded}
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Palette className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{t("主题调色盘")}</span>
          <button
            onClick={onCollapse}
            title={t("收回（{key}）", { key: shortcutLabel })}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            data-testid="theme-studio-close"
            onClick={onClose}
            title={t("关闭调色盘（放弃未保存修改）")}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 元信息：起点 / base / 名称 / id / 作者 */}
          <section className="space-y-2 border-b px-3 py-2.5">
            <Field label={t("基于")}>
              <select
                data-testid="theme-studio-source"
                value=""
                onChange={(e) => handleSourceSelect(e.target.value)}
                className="h-6 w-full min-w-0 rounded border bg-background px-1.5 text-[11px] text-foreground"
              >
                <option value="" disabled>
                  {session.sourceLabel}
                </option>
                <option value="light">{t("内置浅色")}</option>
                <option value="dark">{t("内置深色")}</option>
                {packs.map((p) => (
                  <option key={p.id} value={`pack:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("组件明暗")}>
              <div className="flex gap-1">
                {(["light", "dark"] as const).map((b) => (
                  <button
                    key={b}
                    aria-pressed={draft.base === b}
                    onClick={() => onChange({ ...draft, base: b })}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11px] transition-colors",
                      draft.base === b
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {b === "light" ? t("浅色") : t("深色")}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t("名称")}>
              <input
                data-testid="theme-studio-name"
                value={draft.name}
                maxLength={THEME_NAME_MAX}
                onChange={(e) => onChange({ ...draft, name: e.target.value })}
                className="h-6 w-full rounded border bg-background px-1.5 text-[11px] text-foreground"
              />
            </Field>
            <Field label="id">
              <div className="min-w-0 flex-1">
                <input
                  data-testid="theme-studio-id"
                  value={draft.id}
                  spellCheck={false}
                  onChange={(e) => onChange({ ...draft, id: e.target.value })}
                  className={cn(
                    "h-6 w-full rounded border bg-background px-1.5 font-mono text-[11px] text-foreground",
                    !isValidThemeId(draft.id) && "border-destructive",
                  )}
                />
                {!isValidThemeId(draft.id) ? (
                  <p className="mt-0.5 text-[10px] text-destructive">{t("小写字母 / 数字 / 连字符，≤64 字符")}</p>
                ) : idTaken ? (
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{t("保存将覆盖已安装的同名主题")}</p>
                ) : null}
              </div>
            </Field>
            <Field label={t("作者")}>
              <input
                value={draft.author ?? ""}
                onChange={(e) => onChange({ ...draft, author: e.target.value })}
                className="h-6 w-full rounded border bg-background px-1.5 text-[11px] text-foreground"
              />
            </Field>
          </section>

          {/* 全局色相联动 */}
          <section className="border-b px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between text-[11px]">
              <span className="font-medium text-foreground">{t("全局色相")}</span>
              <span className="font-mono text-muted-foreground">
                {dominant === null ? t("无主题色") : `${Math.round(dominant)}°`}
              </span>
            </div>
            <Slider
              data-testid="theme-studio-hue"
              value={[dominant ?? 0]}
              min={0}
              max={360}
              step={1}
              disabled={dominant === null}
              gradient={hueGradient(0.7, 0.16)}
              onValueChange={([v]) => onHueChange(v)}
              onValueCommit={() => {
                hueDrag.current = null;
              }}
              aria-label={t("全局色相")}
            />
            <p className="mt-1 text-[10px] text-muted-foreground">{t("整体旋转主题色系；文件夹 / 成功 / 危险色不跟随")}</p>
          </section>

          {/* 分组调色框 */}
          {TOKEN_GROUPS.map((group) => {
            const collapsed = collapsedGroups.has(group.id);
            return (
              <section key={group.id} className="border-b last:border-b-0">
                <button
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!collapsed}
                  className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent/50"
                >
                  {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  <span className="flex-1">{t(group.label)}</span>
                  <span className="font-mono text-[10px]">{group.keys.length}</span>
                </button>
                {!collapsed && (
                  <div className="pb-1">
                    {group.keys.map((key) =>
                      key === "--shadow" ? (
                        <ShadowRow
                          key={key}
                          value={draft.tokens[key] ?? ""}
                          onChange={(v) => onChange(setDraftToken(draft, key, v))}
                        />
                      ) : (
                        <TokenRow
                          key={key}
                          tokenKey={key}
                          value={draft.tokens[key] ?? ""}
                          originValue={origin.tokens[key] ?? ""}
                          onChange={(v) => onChange(setDraftToken(draft, key, v))}
                        />
                      ),
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
          <button
            data-testid="theme-studio-reset"
            onClick={onReset}
            disabled={!dirty}
            title={t("恢复到起点配色")}
            className="flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> {t("重置")}
          </button>
          <button
            data-testid="theme-studio-export"
            onClick={onExport}
            disabled={!!invalid}
            title={invalid ? t(invalid) : t("导出为 .rdtheme.json")}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> {t("导出")}
          </button>
          <button
            data-testid="theme-studio-save"
            onClick={onSave}
            disabled={!!invalid}
            title={invalid ? t(invalid) : t("保存到已安装主题包并选用")}
            className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> {t("存为主题包")}
          </button>
        </footer>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-[11px]">
      <span className="w-14 shrink-0 pt-1 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </label>
  );
}

/** 色相轨道：每 30° 一个色标，用固定明度/彩度保证可见 */
function hueGradient(l: number, c: number): string {
  const stops: string[] = [];
  for (let h = 0; h <= 360; h += 30) stops.push(`oklch(${l} ${c} ${h})`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** 透明棋盘格底 + 颜色渐变（A 滑杆） */
const CHECKER = "repeating-conic-gradient(rgb(128 128 128 / 0.35) 0 25%, transparent 0 50%) 0 0 / 8px 8px";

function cssValid(key: string, value: string): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  return CSS.supports(key === "--shadow" ? "box-shadow" : "color", value);
}

function TokenRow({
  tokenKey,
  value,
  originValue,
  onChange,
}: {
  tokenKey: TokenKey;
  value: string;
  originValue: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <Popover.Root>
      <div className="flex items-center gap-2 px-3 py-1 hover:bg-accent/40">
        <Popover.Trigger asChild>
          <button
            data-testid={`theme-swatch-${tokenKey.slice(2)}`}
            aria-label={t("编辑 {name}", { name: tokenKey })}
            className="relative h-6 w-6 shrink-0 overflow-hidden rounded border border-black/10 shadow-sm dark:border-white/15"
            style={{ background: CHECKER }}
          >
            <span className="absolute inset-0" style={{ background: value }} />
          </button>
        </Popover.Trigger>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{tokenKey.slice(2)}</span>
        <span className="max-w-[140px] truncate font-mono text-[10px] text-muted-foreground" title={value}>
          {value}
        </span>
      </div>
      <Popover.Portal>
        <Popover.Content
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-[60] w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-elevate outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <OklchEditor tokenKey={tokenKey} value={value} originValue={originValue} onChange={onChange} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function OklchEditor({
  tokenKey,
  value,
  originValue,
  onChange,
}: {
  tokenKey: TokenKey;
  value: string;
  originValue: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const color = useMemo(() => parseColor(value), [value]);
  const [raw, setRaw] = useState(value);
  useEffect(() => setRaw(value), [value]);

  const update = (patch: Partial<Oklch>) => {
    if (color) onChange(formatOklch({ ...color, ...patch }));
  };
  const commitRaw = () => {
    const v = raw.trim();
    if (v && v !== value && cssValid(tokenKey, v)) onChange(v);
    else setRaw(value);
  };
  const showAlpha = ALPHA_KEYS.has(tokenKey) || (color !== null && color.alpha < 1);
  // 色相轨道在极端明度下会整条发黑/发白，夹到可见区间；彩度也抬到可辨
  const trackL = color ? Math.min(0.85, Math.max(0.35, color.l)) : 0.7;
  const trackC = color ? Math.max(0.1, color.c) : 0.15;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span
          className="h-5 w-5 shrink-0 rounded border border-black/10 dark:border-white/15"
          style={{ background: value }}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">{tokenKey}</span>
      </div>

      {color ? (
        <>
          <Channel
            label="L"
            hint={t("明度")}
            value={color.l}
            min={0}
            max={1}
            step={0.005}
            display={color.l.toFixed(3)}
            gradient={`linear-gradient(to right, oklch(0 ${color.c} ${color.h}), oklch(0.5 ${color.c} ${color.h}), oklch(1 ${color.c} ${color.h}))`}
            onChange={(l) => update({ l })}
          />
          <Channel
            label="C"
            hint={t("彩度")}
            value={color.c}
            min={0}
            max={CHROMA_MAX}
            step={0.001}
            display={color.c.toFixed(3)}
            gradient={`linear-gradient(to right, oklch(${color.l} 0 ${color.h}), oklch(${color.l} ${CHROMA_MAX} ${color.h}))`}
            onChange={(c) => update({ c })}
          />
          <Channel
            label="H"
            hint={t("色相")}
            value={color.h}
            min={0}
            max={360}
            step={1}
            display={`${Math.round(color.h)}°`}
            gradient={hueGradient(trackL, trackC)}
            onChange={(h) => update({ h })}
          />
          {showAlpha && (
            <Channel
              label="A"
              hint={t("不透明度")}
              value={Math.round(color.alpha * 100)}
              min={0}
              max={100}
              step={1}
              display={`${Math.round(color.alpha * 100)}%`}
              gradient={`linear-gradient(to right, transparent, oklch(${color.l} ${color.c} ${color.h})), ${CHECKER}`}
              onChange={(a) => update({ alpha: a / 100 })}
            />
          )}
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">{t("无法解析为 oklch，只能直接编辑原值")}</p>
      )}

      <input
        data-testid="theme-raw-input"
        value={raw}
        spellCheck={false}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commitRaw}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitRaw();
          }
        }}
        className="h-6 w-full rounded border bg-background px-1.5 font-mono text-[10px] text-foreground"
      />

      <div className="flex items-center justify-end">
        <button
          data-testid="theme-restore"
          onClick={() => onChange(originValue)}
          disabled={value === originValue}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" /> {t("恢复原值")}
        </button>
      </div>
    </div>
  );
}

function Channel({
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  gradient,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  gradient: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 shrink-0 font-mono text-[11px] font-medium text-foreground" title={hint}>
        {label}
      </span>
      <Slider
        aria-label={hint}
        value={[value]}
        min={min}
        max={max}
        step={step}
        gradient={gradient}
        onValueChange={([v]) => onChange(v)}
        className="flex-1"
      />
      <span className="w-12 shrink-0 text-right font-mono text-[10px] text-muted-foreground">{display}</span>
    </div>
  );
}

function ShadowRow({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const preset = SHADOW_PRESETS.find((p) => p.value === value);
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <span
        className="h-6 w-6 shrink-0 rounded border border-black/10 bg-card dark:border-white/15"
        style={{ boxShadow: value }}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">shadow</span>
      <select
        data-testid="theme-shadow-select"
        value={preset?.id ?? "custom"}
        onChange={(e) => {
          const next = SHADOW_PRESETS.find((p) => p.id === e.target.value);
          if (next) onChange(next.value);
        }}
        className="h-6 rounded border bg-background px-1 text-[11px] text-foreground"
      >
        {SHADOW_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {t(p.label)}
          </option>
        ))}
        {!preset && (
          <option value="custom" disabled>
            {t("自定义")}
          </option>
        )}
      </select>
    </div>
  );
}
