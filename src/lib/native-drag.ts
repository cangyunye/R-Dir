import { isMac } from "./keymap";
import { dragOutFiles } from "./api";
import type { FileEntry } from "./types";

/**
 * 原生拖出（Windows OLE CF_HDROP / macOS NSDraggingSession file URL）能力探测
 * 与会话标记。
 *
 * 为什么必须原生拖出：HTML5 dragstart 的 dataTransfer 只能放文本格式——
 * - Windows：WebView2 转成 OLE 拖拽后不带 CF_HDROP，浏览器上传投放区（检查
 *   Files）与资源管理器一律按纯文本拒收；
 * - macOS：WKWebView 的 uri-list 拖出是纯文本载荷，Finder 收到的是文本剪辑、
 *   Dock 废纸篓直接拒收。两平台理论上都必须用原生命令 drag_out_files 发起
 *   携带文件引用的拖拽。
 *
 * 能力探测：启动时对 drag_out_files([]) 做一次空列表 no-op 调用 ——
 * - 真实 Windows 应用 → 成功 → 走原生拖出；
 * - jsdom 单测 / vite 纯浏览器预览 / e2e 的 tauri-mock（未桩化命令直接 throw）→
 *   失败 → 回落 HTML5 路径，e2e 继续覆盖 dragstart → dragover → drop 事件链。
 *
 * ⚠️ v0.52 曾在 macOS 启用 NSDraggingSession 原生拖出（修「拖到废纸篓无效」），
 * 真机拖动文件即崩溃退出（objc 侧 panic，未定位到具体调用点），已按用户要求
 * 回退：mac 恢复 HTML5 拖出短路，Rust 侧 mac_imp/命令保留但不再被前端触发
 * （canNativeDragOut 恒 false）。重新启用前必须先在真机定位崩溃点。
 */

let supported = false;
let probed = false;

/**
 * file:// URI 列表（macOS HTML5 拖出：WKWebView 把 file:// URI 映射为 NSURL 放进
 * 系统拖拽 pasteboard，Finder / Dock 废纸篓按文件收投）。两条硬规则：
 * - 路径必须经 URL 构造器百分号编码——中文/空格文件名裸拼进 uri-list 是非法
 *   URI，NSURL 解析失败后拖拽载荷退化为纯文本：拖到 Finder 变成文本剪辑、
 *   拖到 Dock 废纸篓被直接拒收（mac 拖不进废纸篓的根因）；
 * - 每条以 CRLF 结尾（RFC 2483 uri-list 条目分隔），部分接收方按结尾 CRLF 断条。
 */
export function fileUriList(paths: string[]): string {
  return (
    paths
      .map((p) => {
        const posix = p.replace(/\\/g, "/");
        const segs = posix.split("/");
        // 逐段百分号编码：new URL() 不编路径里的保留字（#/? 会被当 URI 定界符
        // 吞掉后半段路径），必须手动逐段 encodeURIComponent（其保留字集中
        // A-Za-z0-9-_.!~*'() 均为路径段安全字符）。盘符段（"C:"）不编码——
        // 冒号是 file:///C:/… 形态的一部分
        const encoded = segs
          .map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
          .join("/");
        return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
      })
      .join("\r\n") + "\r\n"
  );
}

export const probeNativeDragOut = async () => {
  // macOS 短路：NSDraggingSession 原生拖出真机崩溃（见模块注释），恢复 HTML5 拖出。
  // （拖到 Dock 废纸篓暂不可用，回到 HTML5 纯文本载荷的旧状态。）
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
