import { dropTargetAt, type DropTarget } from "./drop-target";
import type { FileEntry } from "./types";

/**
 * 搜索结果拖拽会话（feat/search-drag）：搜索行发起的文件拖拽在拖动期间的全局标记。
 *
 * 与 native-drag.ts 的会话标记配合：nativeDragOut / html5Drag 描述「一次原生/HTML5
 * 拖拽」的载体，searchDrag 描述这次拖拽来自搜索面板（面板据此隐藏自身、渲染右上角
 * 取消区与右下角垃圾箱），并承载拖影回查用的条目元数据——搜索行（全盘索引/fd/内容
 * 命中）不在窗格条目表里，窗格回查会拿到空拖影。
 *
 * 生命周期：面板 dragstart 时 setSearchDrag(...) → 拖动期间 App 的拖放事件（原生 /
 * HTML5 链路，OLE 拖拽时页面收不到鼠标事件、悬停只能在这里解析）或面板自身鼠标链
 * （虚拟路径的引擎 A 分支）经 emitSearchDragHover 通报落点 → 任一方先收尾：
 * finishSearchDrag(result) 恰好生效一次（首个调用者定结果），面板订阅 finish 恢复
 * 显示并做乐观行移除；OLE promise 收尾读到 finished=true 时不再重复收尾。
 */
export type SearchDragResult = "deleted" | "cancelled" | "copied";
export type SearchDropKind = "trash" | "cancel";

export interface SearchDragSession {
  paths: string[];
  /** 拖影回查元数据：搜索行由面板合成（索引/fd/内容命中不在窗格条目表） */
  entries: FileEntry[];
  /** 收尾只生效一次（App 拖放事件与 OLE promise 收尾竞态） */
  finished: boolean;
  result?: SearchDragResult;
}

let active: SearchDragSession | null = null;

export const setSearchDrag = (s: SearchDragSession | null) => {
  active = s;
};

export const getSearchDrag = (): SearchDragSession | null => active;

/** 悬停通报：App 原生/HTML5 链路 ↔ 面板渲染（zone 高亮/拖影提示行） */
type HoverListener = (kind: SearchDropKind | null) => void;
const hoverListeners = new Set<HoverListener>();

export const onSearchDragHover = (fn: HoverListener) => {
  hoverListeners.add(fn);
  return () => {
    hoverListeners.delete(fn);
  };
};

export const emitSearchDragHover = (kind: SearchDropKind | null) => {
  hoverListeners.forEach((fn) => fn(kind));
};

/** 收尾通报：面板恢复显示 / 乐观行移除都挂在 finish 事件上 */
type FinishListener = (s: SearchDragSession) => void;
const finishListeners = new Set<FinishListener>();

export const onSearchDragFinish = (fn: FinishListener) => {
  finishListeners.add(fn);
  return () => {
    finishListeners.delete(fn);
  };
};

/** 恰好收尾一次：首个调用者定结果，后续调用（OLE promise 收尾兜底）no-op */
export const finishSearchDrag = (result: SearchDragResult): boolean => {
  const s = active;
  if (!s || s.finished) return false;
  s.finished = true;
  s.result = result;
  active = null;
  finishListeners.forEach((fn) => fn(s));
  return true;
};

export interface SearchDropAt {
  /** 命中搜索拖拽专属投放区：垃圾箱 / 取消区；null = 落点按窗格/目录解析 */
  kind: SearchDropKind | null;
  /** kind 为 null 时的窗格/文件夹落点（复用 drop-target.ts） */
  target: DropTarget | null;
}

/**
 * 搜索拖拽的落点解析（App 原生/HTML5 链路与面板鼠标链共用）：
 * 先认专属投放区（[data-search-drop]，右上角取消区 / 右下角垃圾箱，portal 在 body、
 * 悬浮于一切窗格之上），否则回落通用窗格/文件夹解析（drop-target.ts）。
 * 垃圾箱禁用态（会话含远程路径——回收站是本地文件系统概念，data-disabled 标记）
 * 按取消处理：禁用区不承接删除。
 */
export const resolveSearchDropAt = (
  x: number,
  y: number,
  excludePaths: readonly string[],
): SearchDropAt => {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const zone = el?.closest("[data-search-drop]") as HTMLElement | null;
  const kind = zone?.dataset.searchDrop;
  if (kind === "trash" || kind === "cancel") {
    if (kind === "trash" && zone?.hasAttribute("data-disabled")) return { kind: "cancel", target: null };
    return { kind, target: null };
  }
  return { kind: null, target: dropTargetAt(x, y, excludePaths) };
};
