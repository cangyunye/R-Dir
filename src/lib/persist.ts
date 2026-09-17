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
