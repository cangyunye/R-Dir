/**
 * M5 配置持久化：文件标签（Finder 风格）+ 自定义快捷访问
 * 均存 localStorage，结构简单、可安全忽略失败。
 */

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

export function loadUiFontSize(): number {
  try {
    const raw = localStorage.getItem(UI_FONT_KEY);
    if (!raw) return UI_FONT_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return UI_FONT_DEFAULT;
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

/** 字体大小 → 根缩放系数（13px = 1.0） */
export function uiFontZoom(n: number): number {
  return n / UI_FONT_DEFAULT;
}
