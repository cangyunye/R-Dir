/**
 * 主题包（v0.39）：纯颜色 token 数据包的前端应用层。
 *
 * 安全边界：包内容只经 `style.setProperty` 写到 <html> 内联样式，不拼接 <style>
 * 文本、不执行代码；不在白名单内的 key 一律忽略，值先过 CSS.supports。
 * 设置面板皮肤不开放额外字段——由包调色板自动派生一组 --glass-* 变量
 * （index.css 的 .settings-glass 以 var(--glass-*, 原值) 消费）。
 */

import { invoke } from "@tauri-apps/api/core";

export interface ThemePack {
  /** "$schema"（rdir-theme/1） */
  schema?: string;
  id: string;
  name: string;
  author?: string;
  version?: string;
  /** light | dark：只决定 <html> 是否加 .dark（组件 dark: 变体依赖） */
  base: "light" | "dark";
  tokens: Record<string, string>;
}

export interface ThemeLoadError {
  file: string;
  message: string;
}

export interface ThemesList {
  packs: ThemePack[];
  errors: ThemeLoadError[];
}

/** 允许主题包覆盖的主题 token（与 index.css :root 一致；字体/圆角不开放） */
export const THEME_TOKEN_KEYS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--sidebar",
  "--selected",
  "--folder",
  "--ok",
  "--shadow",
] as const;

/** 当前选中主题包（null/缺失 = 用内置颜色模式） */
export const THEME_PACK_KEY = "rfm.themePack";

type Palette = Record<(typeof THEME_TOKEN_KEYS)[number], string>;

/** 内置浅色（与 index.css :root 逐字一致） */
const LIGHT_BASE: Palette = {
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.21 0.02 260)",
  "--card": "oklch(1 0 0)",
  "--card-foreground": "oklch(0.21 0.02 260)",
  "--popover": "oklch(1 0 0)",
  "--popover-foreground": "oklch(0.21 0.02 260)",
  "--primary": "oklch(0.55 0.14 235)",
  "--primary-foreground": "oklch(0.99 0 0)",
  "--secondary": "oklch(0.965 0.005 260)",
  "--secondary-foreground": "oklch(0.32 0.04 250)",
  "--muted": "oklch(0.97 0.003 260)",
  "--muted-foreground": "oklch(0.55 0.02 260)",
  "--accent": "oklch(0.95 0.02 230)",
  "--accent-foreground": "oklch(0.32 0.08 240)",
  "--destructive": "oklch(0.577 0.2 27)",
  "--border": "oklch(0.92 0.006 260)",
  "--input": "oklch(0.92 0.006 260)",
  "--ring": "oklch(0.6 0.12 235)",
  "--sidebar": "oklch(0.975 0.004 260)",
  "--selected": "oklch(0.93 0.04 235)",
  "--folder": "oklch(0.8 0.15 80)",
  "--ok": "oklch(0.68 0.14 150)",
  "--shadow": "0 12px 32px rgba(15, 23, 42, 0.16)",
};

/** 内置深色（与 index.css .dark 逐字一致） */
const DARK_BASE: Palette = {
  "--background": "oklch(0.145 0.01 260)",
  "--foreground": "oklch(0.96 0.005 260)",
  "--card": "oklch(0.19 0.012 260)",
  "--card-foreground": "oklch(0.96 0.005 260)",
  "--popover": "oklch(0.2 0.012 260)",
  "--popover-foreground": "oklch(0.96 0.005 260)",
  "--primary": "oklch(0.72 0.13 225)",
  "--primary-foreground": "oklch(0.2 0.02 240)",
  "--secondary": "oklch(0.26 0.012 260)",
  "--secondary-foreground": "oklch(0.96 0.005 260)",
  "--muted": "oklch(0.24 0.012 260)",
  "--muted-foreground": "oklch(0.7 0.015 260)",
  "--accent": "oklch(0.28 0.03 240)",
  "--accent-foreground": "oklch(0.95 0 0)",
  "--destructive": "oklch(0.67 0.19 25)",
  "--border": "oklch(1 0 0 / 10%)",
  "--input": "oklch(1 0 0 / 14%)",
  "--ring": "oklch(0.65 0.12 225)",
  "--sidebar": "oklch(0.17 0.011 260)",
  "--selected": "oklch(0.3 0.05 235)",
  "--folder": "oklch(0.83 0.14 80)",
  "--ok": "oklch(0.72 0.13 155)",
  "--shadow": "0 16px 40px rgba(0, 0, 0, 0.55)",
};

/** 设置面板皮肤变量（index.css 消费；由包调色板派生，不单独暴露给包作者） */
const GLASS_KEYS = [
  "--glass-bg",
  "--glass-card",
  "--glass-popover",
  "--glass-muted",
  "--glass-muted-fg",
  "--glass-accent",
  "--glass-accent-fg",
  "--glass-border",
  "--glass-input",
  "--glass-primary",
  "--glass-primary-fg",
  "--glass-ring",
  "--glass-primary-grad",
  "--glass-accent-grad",
  "--glass-primary-grad-wash",
  "--glass-deco",
  "--glass-nav",
  "--glass-ink",
  "--glass-shadow",
] as const;

function supports(property: string, value: string): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  return CSS.supports(property, value);
}

function validValue(key: string, value: string): boolean {
  if (!value.trim() || value.length > 200) return false;
  return supports(key === "--shadow" ? "box-shadow" : "color", value);
}

/** 包调色板 = base 内置色 + 白名单内合法覆盖项（非法颜色跳过，其余照常） */
function resolvePalette(pack: ThemePack): Palette {
  const palette: Palette = {
    ...(pack.base === "dark" ? DARK_BASE : LIGHT_BASE),
  };
  for (const key of THEME_TOKEN_KEYS) {
    const value = pack.tokens?.[key];
    if (typeof value === "string" && validValue(key, value)) palette[key] = value.trim();
  }
  return palette;
}

/** 从调色板派生设置面板皮肤：底色/表面/主色跟包走，装饰用主色低透明光斑 */
function glassOverrides(p: Palette, base: ThemePack["base"]): Record<(typeof GLASS_KEYS)[number], string> {
  const { "--primary": primary, "--sidebar": sidebar, "--foreground": foreground } = p;
  return {
    "--glass-bg": p["--background"],
    "--glass-card": p["--card"],
    "--glass-popover": p["--popover"],
    "--glass-muted": p["--muted"],
    "--glass-muted-fg": p["--muted-foreground"],
    "--glass-accent": p["--accent"],
    "--glass-accent-fg": p["--accent-foreground"],
    "--glass-border": p["--border"],
    "--glass-input": p["--input"],
    "--glass-primary": primary,
    "--glass-primary-fg": p["--primary-foreground"],
    "--glass-ring": p["--ring"],
    "--glass-primary-grad": `linear-gradient(135deg, ${primary}, color-mix(in oklab, ${primary} 78%, black))`,
    "--glass-accent-grad": `linear-gradient(135deg, color-mix(in oklab, ${p["--accent"]} 82%, transparent), color-mix(in oklab, ${p["--accent"]} 58%, transparent))`,
    "--glass-primary-grad-wash": `linear-gradient(135deg, color-mix(in oklab, ${primary} 12%, transparent), color-mix(in oklab, ${primary} 8%, transparent))`,
    "--glass-deco": `radial-gradient(44rem 22rem at 84% -10%, color-mix(in oklab, ${primary} 16%, transparent), transparent 62%), radial-gradient(32rem 26rem at -10% 110%, color-mix(in oklab, ${sidebar} 45%, transparent), transparent 60%)`,
    "--glass-nav": `linear-gradient(180deg, color-mix(in oklab, ${primary} 6%, transparent), transparent)`,
    "--glass-ink": `color-mix(in oklab, ${primary} 55%, ${foreground})`,
    "--glass-shadow":
      base === "dark"
        ? `0 0 0 1px color-mix(in oklab, ${primary} 18%, transparent), 0 0 48px -8px color-mix(in oklab, ${primary} 16%, transparent), 0 28px 72px -20px rgb(0 0 0 / 82%)`
        : `0 0 0 1px rgb(255 255 255 / 55%), 0 24px 64px -16px color-mix(in oklab, ${primary} 22%, transparent)`,
  };
}

let appliedKeys: string[] = [];

/** 应用主题包（null = 清除，回到内置 token）；只写 <html> 内联样式 */
export function applyThemePack(pack: ThemePack | null): void {
  const root = document.documentElement;
  for (const key of appliedKeys) root.style.removeProperty(key);
  appliedKeys = [];
  if (!pack) {
    root.removeAttribute("data-theme");
    return;
  }
  const palette = resolvePalette(pack);
  const values: Record<string, string> = {
    ...palette,
    ...glassOverrides(palette, pack.base),
  };
  for (const [key, value] of Object.entries(values)) {
    root.style.setProperty(key, value);
    appliedKeys.push(key);
  }
  root.dataset.theme = pack.id;
}

/** 读取已安装主题包（坏包进 errors）；非 Tauri 环境返回空列表 */
export async function loadThemePacks(): Promise<ThemesList> {
  try {
    const list = await invoke<ThemesList>("themes_list");
    return {
      packs: Array.isArray(list?.packs) ? list.packs : [],
      errors: Array.isArray(list?.errors) ? list.errors : [],
    };
  } catch {
    return { packs: [], errors: [] };
  }
}

/** 安装本地主题包文件（Rust 侧校验并原子写入配置目录） */
export function installThemePack(path: string): Promise<ThemePack> {
  return invoke<ThemePack>("theme_install", { path });
}

export function deleteThemePack(id: string): Promise<void> {
  return invoke<void>("theme_delete", { id });
}

export function loadActiveThemePackId(): string | null {
  try {
    return localStorage.getItem(THEME_PACK_KEY) || null;
  } catch {
    return null;
  }
}

export function saveActiveThemePackId(id: string | null): void {
  try {
    if (id) localStorage.setItem(THEME_PACK_KEY, id);
    else localStorage.removeItem(THEME_PACK_KEY);
  } catch {
    /* ignore */
  }
}

/** 卡片缩略色：包内已校验的 token，否则回落到 base 内置色 */
export function themeSwatch(pack: ThemePack): { bg: string; sidebar: string; primary: string } {
  const palette = resolvePalette(pack);
  return {
    bg: palette["--background"],
    sidebar: palette["--sidebar"],
    primary: palette["--primary"],
  };
}
