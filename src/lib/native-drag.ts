import { isMac } from "./keymap";
import { dragOutFiles } from "./api";

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

/** 一次原生拖出会话：发起时设置，drop 回落本窗格或拖拽结束后清除 */
export interface NativeDragOut {
  sourcePaneId: number;
  paths: string[];
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
