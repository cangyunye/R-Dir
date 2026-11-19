import { isMac } from "./keymap";
import { dragOutFiles } from "./api";
import type { FileEntry } from "./types";

/**
 * Windows 原生拖出（OLE 拖拽携带 CF_HDROP）能力探测与会话标记。
 *
 * 为什么必须原生拖出：HTML5 dragstart 的 dataTransfer 只能放文本格式，WebView2
 * 转成 OLE 拖拽后不带 CF_HDROP，浏览器上传投放区（检查 Files）与资源管理器
 * 一律按纯文本拒收 —— 必须用原生命令 drag_out_files 发起携带文件引用的拖拽。
 *
 * 能力探测：启动时对 drag_out_files([]) 做一次空列表 no-op 调用 ——
 * - 真实 Windows 应用 → 成功 → 走原生拖出；
 * - jsdom 单测 / vite 纯浏览器预览 / e2e 的 tauri-mock（未桩化命令直接 throw）→
 *   失败 → 回落 HTML5 路径，e2e 继续覆盖 dragstart → dragover → drop 事件链
 *   （这条链同时也是 macOS 生产路径）；
 * - macOS 直接短路（WKWebView 的 HTML5 file:// uri-list 拖出）。
 */

let supported = false;
let probed = false;

export const probeNativeDragOut = async () => {
  if (isMac) {
    probed = true;
    return;
  }
  try {
    await dragOutFiles([]);
    supported = true;
  } catch {
    supported = false;
  } finally {
    probed = true;
    console.info(
      supported
        ? "[rdir] 原生拖出能力探测：可用（Windows CF_HDROP）"
        : "[rdir] 原生拖出能力探测：不可用（回落 HTML5 文本拖拽）",
    );
  }
};

export const canNativeDragOut = () => probed && supported;

/**
 * 侧栏服务器拖拽换组的指针链可用性（v0.34 Windows 原生拖放接管后 HTML5
 * dragover/drop 不再进页面，见 Sidebar.tsx 顶部注释）。
 *
 * 窄谓词、不并入 canNativeDragOut()：e2e 逃生舱旗标只翻转侧栏分支，
 * 若并入会连带翻转 FileList/IconGrid/App 的原生拖放分支、破坏既有 e2e。
 * 各环境：真实 Windows 壳=true（探测成功）；macOS / web / jsdom=false；
 * e2e 默认 false，仅 addInitScript 预置 rdir.e2e.force-native-drag 的新用例为 true。
 */
export const canPointerDnd = () => {
  try {
    if (sessionStorage.getItem("rdir.e2e.force-native-drag") === "1") return true;
  } catch {
    /* jsdom 等无 sessionStorage 场景照走探测结果 */
  }
  return canNativeDragOut();
};

/** 一次原生拖出会话：发起时设置，drop 回落本窗格或拖拽结束后清除 */
export interface NativeDragOut {
  sourcePaneId: number;
  paths: string[];
  /** 搜索结果拖拽会话（feat/search-drag）：App 拖放事件据此分流专属落点解析
   *  （垃圾箱/取消区）与收尾通报；见 src/lib/search-drag.ts */
  search?: boolean;
  /** 拖影回查元数据：搜索行（索引/fd/内容命中）不在窗格条目表里，由面板合成带来 */
  entries?: FileEntry[];
}

let active: NativeDragOut | null = null;

export const setNativeDragOut = (d: NativeDragOut | null) => {
  active = d;
};

export const getNativeDragOut = (): NativeDragOut | null => active;

/**
 * 一次 HTML5 应用内拖拽会话（macOS WKWebView / 原生拖出不可用的回落路径）：
 * dragstart 记录，drop / dragend 清除。dragover 阶段 dataTransfer 只能读 types
 * 读不到值，「拖到自身文件夹」的悬停排除靠这里拿 paths。
 */
let html5: NativeDragOut | null = null;

export const setHtml5Drag = (d: NativeDragOut | null) => {
  html5 = d;
};

export const getHtml5Drag = (): NativeDragOut | null => html5;
