/**
 * M5 配置持久化：文件标签（Finder 风格）+ 自定义快捷访问
 * 均存 localStorage，结构简单、可安全忽略失败。
 *
 * v0.14：标签相关配置（重命名名、文件标签、快捷访问）额外写盘到 prefs.json，
 * 作为 WebView localStorage 的可靠备份——避免本地存储被清理后配置丢失。
 * 写盘尽力而为（失败静默），测试环境（jsdom 无 Tauri）不影响。
 */

import { invoke } from "@tauri-apps/api/core";

/** 磁盘偏好快照：与 prefs.json 字段对齐（v0.14） */
export interface PrefsDisk {
  tagNames?: TagNames;
  fileTags?: FileTags;
  customQuick?: string[];
}

/** 当前 localStorage 中的标签配置快照 */
function prefsSnapshot(): PrefsDisk {
  return {
    tagNames: loadTagNames(),
    fileTags: loadFileTags(),
    customQuick: loadCustomQuick(),
  };
}

let prefsWriteChain: Promise<void> = Promise.resolve();

/** 将当前标签配置写盘（串行队列，避免并发写坏文件；失败静默） */
export function flushPrefsToDisk(): void {
  const snap = prefsSnapshot();
  prefsWriteChain = prefsWriteChain
    .catch(() => undefined)
    .then(() => invoke("prefs_save", { value: snap }).then(() => undefined).catch(() => undefined));
}

/** 从磁盘读取偏好；非 Tauri 环境或读取失败返回 null */
export async function loadPrefsFromDisk(): Promise<PrefsDisk | null> {
  try {
    const v = await invoke<PrefsDisk | null>("prefs_load");
    if (!v || typeof v !== "object") return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * 把磁盘快照合并回 localStorage（磁盘优先、缺失键回落本地），
 * 随后调用 loadXxx 即可取到合并后的完整值。
 */
export function mergeDiskPrefs(disk: PrefsDisk): void {
  if (disk.tagNames && Object.keys(disk.tagNames).length > 0) {
    localStorage.setItem(TAG_NAMES_KEY, JSON.stringify({ ...loadTagNames(), ...disk.tagNames }));
  }
  if (disk.fileTags && Object.keys(disk.fileTags).length > 0) {
    localStorage.setItem(TAGS_KEY, JSON.stringify({ ...loadFileTags(), ...disk.fileTags }));
  }
  if (disk.customQuick && disk.customQuick.length > 0) {
    localStorage.setItem(
      QUICK_KEY,
      JSON.stringify([...new Set([...loadCustomQuick(), ...disk.customQuick])]),
    );
  }
}

/** 预设标签（参照 macOS Finder 彩色标签） */
export interface TagDef {
  id: string;
  label: string;
  color: string;
}

export const TAG_DEFS: TagDef[] = [
  { id: "red", label: "红色", color: "#ff3b30" },
  { id: "orange", label: "橙色", color: "#ff9500" },
  { id: "yellow", label: "黄色", color: "#ffcc00" },
  { id: "green", label: "绿色", color: "#34c759" },
  { id: "blue", label: "蓝色", color: "#007aff" },
  { id: "purple", label: "紫色", color: "#af52de" },
  { id: "gray", label: "灰色", color: "#8e8e93" },
];

export function tagById(id: string): TagDef | undefined {
  return TAG_DEFS.find((t) => t.id === id);
}

/** 用户自定义标签名（颜色 id → 显示名），v0.6.4 起支持右键重命名标签 */
export type TagNames = Record<string, string>;

const TAG_NAMES_KEY = "rfm.tag-names";

export function loadTagNames(): TagNames {
  try {
    const raw = localStorage.getItem(TAG_NAMES_KEY);
    return raw ? (JSON.parse(raw) as TagNames) : {};
  } catch {
    return {};
  }
}

export function saveTagNames(names: TagNames): void {
  try {
    localStorage.setItem(TAG_NAMES_KEY, JSON.stringify(names));
  } catch {
    /* ignore */
  }
  flushPrefsToDisk();
}

/** 标签显示名：优先用户自定义，回落预设 */
export function tagLabel(def: TagDef, names: TagNames): string {
  const c = names[def.id]?.trim();
  return c || def.label;
}

/** 文件路径 → 标签 id 列表 */
export type FileTags = Record<string, string[]>;

const TAGS_KEY = "rfm.tags";
const QUICK_KEY = "rfm.quick";

export function loadFileTags(): FileTags {
  try {
    const raw = localStorage.getItem(TAGS_KEY);
    return raw ? (JSON.parse(raw) as FileTags) : {};
  } catch {
    return {};
  }
}

export function saveFileTags(t: FileTags): void {
  try {
    localStorage.setItem(TAGS_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
  flushPrefsToDisk();
}

/** 用户自定义快捷访问路径列表（追加在内置快捷访问下方） */
export type CustomQuick = string[];

export function loadCustomQuick(): CustomQuick {
  try {
    const raw = localStorage.getItem(QUICK_KEY);
    return raw ? (JSON.parse(raw) as CustomQuick) : [];
  } catch {
    return [];
  }
}

export function saveCustomQuick(q: CustomQuick): void {
  try {
    localStorage.setItem(QUICK_KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
  flushPrefsToDisk();
}

/** 路径的父目录（纯字符串处理，供标签跳转使用） */
export function parentOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i <= 0) return "/";
  return norm.slice(0, i);
}

// ---- v0.7 分享设置 ----
const SHARE_ALLOW_PARENT_KEY = "rfm.share-allow-parent";
const SHARE_DEFAULT_EXPIRES_KEY = "rfm.share-default-expires";

/** 分享是否允许接收方上溯到父目录（默认 false：严格锁定分享根内） */
export function loadShareAllowParent(): boolean {
  try {
    return localStorage.getItem(SHARE_ALLOW_PARENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShareAllowParent(v: boolean): void {
  try {
    localStorage.setItem(SHARE_ALLOW_PARENT_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** 分享默认有效期（小时）；null = 永久（直到关闭客户端/主动停止） */
export function loadShareDefaultExpires(): number | null {
  try {
    const raw = localStorage.getItem(SHARE_DEFAULT_EXPIRES_KEY);
    if (!raw) return 24; // 默认 24 小时
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return 24;
  }
}

export function saveShareDefaultExpires(hours: number | null): void {
  try {
    if (hours == null) {
      localStorage.removeItem(SHARE_DEFAULT_EXPIRES_KEY);
    } else {
      localStorage.setItem(SHARE_DEFAULT_EXPIRES_KEY, String(hours));
    }
  } catch {
    /* ignore */
  }
}

// ---- v0.8 界面字体大小（整体缩放等效，13px = 100%，范围 10–18） ----
const UI_FONT_KEY = "rfm.ui-font";

export const UI_FONT_MIN = 10;
export const UI_FONT_MAX = 18;
export const UI_FONT_DEFAULT = 15;

/** 根据屏幕宽度自动推荐默认字体大小（全屏不出现滚动条） */
export function autoUiFontSize(): number {
  try {
    const w = window.innerWidth || screen.width || 1440;
    if (w < 1280) return 13;
    if (w < 1600) return 14;
    if (w < 2000) return 15;
    return 16;
  } catch {
    return UI_FONT_DEFAULT;
  }
}

/** 迁移标记：v0.8.0 前默认 13px，之后默认 15px。老用户首次启动升级到 15。 */
const UI_FONT_MIGRATED_KEY = "rfm.ui-font-migrated-v080";

export function loadUiFontSize(): number {
  try {
    const raw = localStorage.getItem(UI_FONT_KEY);
    // 首次启动（从未设置过字体）→ 根据屏幕宽度自动推荐
    if (!raw) {
      const auto = autoUiFontSize();
      localStorage.setItem(UI_FONT_KEY, String(auto));
      return auto;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return UI_FONT_DEFAULT;
    // 老用户：存了旧默认 13px 且未迁移过 → 根据屏幕宽度自动推荐
    const migrated = localStorage.getItem(UI_FONT_MIGRATED_KEY) === "1";
    if (n <= 13 && !migrated) {
      localStorage.setItem(UI_FONT_MIGRATED_KEY, "1");
      const auto = autoUiFontSize();
      localStorage.setItem(UI_FONT_KEY, String(auto));
      return auto;
    }
    return Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, n));
  } catch {
    return UI_FONT_DEFAULT;
  }
}

export function saveUiFontSize(n: number): void {
  try {
    const v = Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, n));
    localStorage.setItem(UI_FONT_KEY, String(v));
  } catch {
    /* ignore */
  }
}

/** 字体大小 → 根缩放系数（13px = 1.0，分母固定为原始基准，不随默认值变） */
export function uiFontZoom(n: number): number {
  return n / 13;
}

// ---- v0.8.1 字体族 ----
export const UI_FONT_FAMILIES: { id: string; label: string; stack: string }[] = [
  { id: "system", label: "系统默认", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "msyahei", label: "微软雅黑", stack: '"Microsoft YaHei", "微软雅黑", system-ui, sans-serif' },
  { id: "pingfang", label: "苹方", stack: '"PingFang SC", "Hiragino Sans GB", system-ui, sans-serif' },
  { id: "simsun", label: "宋体", stack: '"SimSun", "宋体", serif' },
  { id: "menlo", label: "等宽", stack: '"JetBrains Mono", Menlo, Consolas, monospace' },
  { id: "custom", label: "自定义...", stack: "" },
];

const UI_FONT_FAMILY_KEY = "rfm.ui-font-family";

export function loadUiFontFamily(): string {
  try {
    const raw = localStorage.getItem(UI_FONT_FAMILY_KEY);
    if (!raw) {
      // 默认：Windows 用微软雅黑，macOS 用苹方
      const isMac = /Mac|iPhone/.test(navigator.platform);
      return isMac ? "pingfang" : "msyahei";
    }
    return raw;
  } catch {
    return "system";
  }
}

export function saveUiFontFamily(id: string): void {
  try {
    localStorage.setItem(UI_FONT_FAMILY_KEY, id);
  } catch {
    /* ignore */
  }
}

export function uiFontFamilyStack(id: string): string {
  if (id === "custom") {
    try {
      const custom = localStorage.getItem("rfm.ui-font-family-custom") || "Arial";
      return `"${custom}", system-ui, sans-serif`;
    } catch {
      return UI_FONT_FAMILIES[0].stack;
    }
  }
  const f = UI_FONT_FAMILIES.find((x) => x.id === id);
  return f ? f.stack : UI_FONT_FAMILIES[0].stack;
}

export function saveUiFontFamilyCustom(name: string): void {
  try {
    localStorage.setItem("rfm.ui-font-family-custom", name);
  } catch {
    /* ignore */
  }
}

// ---- v0.14 显示文件扩展名（默认显示；关闭后文件列表隐藏扩展名） ----
const SHOW_EXTENSIONS_KEY = "rfm.show-extensions";

export function loadShowExtensions(): boolean {
  try {
    return localStorage.getItem(SHOW_EXTENSIONS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveShowExtensions(v: boolean): void {
  try {
    localStorage.setItem(SHOW_EXTENSIONS_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}