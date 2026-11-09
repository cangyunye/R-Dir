/**
 * IPC 传输适配层：桌面（Tauri invoke/event）与 Web（HTTP/WS）双传输。
 *
 * 背景：web 子命令（规划中，见 feat/portable-and-web-foundation）以独立二进制
 * 托管同一套前端，后端命令经 POST /api/invoke 透传、事件经 WS /api/events 推送。
 * 全前端对 Tauri API 的 invoke/listen 引用统一收敛到本模块，业务代码零感知：
 *
 * - invoke：错误契约与 Tauri 一致——reject 后端原始字符串（`CODE|详情`，terr 按码翻译）；
 *   传输层自身失败同样以码化字符串 reject（WEB_OFFLINE / WEB_BAD_RESPONSE）。
 * - listen：Tauri 分支原样转发；Web 分支共享单条 WebSocket，按事件名扇出，
 *   断线指数退避重连（仍有订阅者时），全部退订后断开。
 *
 * 桌面专属 API（窗口控制 / 原生对话框 / 拖放）不经过本模块，调用方沿用
 * `"__TAURI_INTERNALS__" in window` 能力探测（WindowControls / TabBar 先例）。
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { t } from "@/lib/i18n";

/** Tauri 事件模块的退订函数签名（两端一致） */
export type UnlistenFn = () => void;

/** 与 Tauri `Event<T>` 结构兼容的最小事件形态（业务 handler 只消费 payload） */
export interface IpcEvent<T = unknown> {
  payload: T;
}

/** 传输探测：jsdom 测试环境由 setup.ts 预置 stub 按 Tauri 处理，Web 用例自行删除 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ==================== invoke：命令透传 ====================

const WEB_API_BASE = "/api";

/** 调用后端命令；args 的键名与 Tauri 一致（camelCase，后端 serde rename_all 对齐） */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri()) return tauriInvoke<T>(cmd, args);
  return webInvoke<T>(cmd, args);
}

async function webInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${WEB_API_BASE}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
  } catch (e) {
    throw `WEB_OFFLINE|无法连接服务（${e instanceof Error ? e.message : e}）`;
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: boolean; data?: T; error?: unknown }
    | null;
  if (body && typeof body === "object" && "ok" in body) {
    if (body.ok) return body.data as T;
    throw typeof body.error === "string"
      ? body.error
      : JSON.stringify(body.error ?? t("未知错误"));
  }
  throw `WEB_BAD_RESPONSE|服务响应异常（HTTP ${res.status}）`;
}

// ==================== listen：事件订阅 ====================

export async function listen<T>(
  event: string,
  handler: (e: IpcEvent<T>) => void,
): Promise<UnlistenFn> {
  if (isTauri()) return tauriListen(event, handler);
  return webListen(event, handler as (e: IpcEvent) => void);
}

// ---- Web 分支：共享单条 WS + 按事件名扇出 + 指数退避重连 ----
// 无需订阅报文：fs_watch 等监视集合经 invoke（fsWatchSet）注册，服务端向所有
// 客户端广播同帧事件；连接只承担「推」，断线重连后由前端既有刷新逻辑补偿。

const WEB_WS_PATH = "/api/events";
const WS_RECONNECT_MAX_MS = 8000;

type FrameHandler = (frame: { event: string; payload: unknown }) => void;
const webSubs = new Map<string, Set<FrameHandler>>();
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ensureWs(): void {
  if (ws || typeof WebSocket === "undefined") return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}${WEB_WS_PATH}`);
  ws.onopen = () => {
    reconnectAttempts = 0;
  };
  ws.onmessage = (msg) => {
    let frame: { event?: string; payload?: unknown };
    try {
      frame = JSON.parse(String(msg.data));
    } catch {
      return; // 非法帧静默丢弃
    }
    if (typeof frame.event !== "string") return;
    const set = webSubs.get(frame.event);
    if (!set) return;
    for (const h of set) {
      try {
        h(frame as { event: string; payload: unknown });
      } catch {
        // 单个订阅者异常不阻断其余订阅者
      }
    }
  };
  ws.onclose = () => {
    ws = null;
    if (webSubs.size > 0) {
      const delay = Math.min(500 * 2 ** reconnectAttempts++, WS_RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(ensureWs, delay);
    }
  };
  // onerror 之后浏览器必然回调 onclose，重连统一在 onclose 收口
  ws.onerror = () => ws?.close();
}

function closeWs(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (ws) {
    ws.close();
    ws = null;
  }
}

function webListen(
  event: string,
  handler: FrameHandler,
): UnlistenFn {
  let set = webSubs.get(event);
  if (!set) {
    set = new Set();
    webSubs.set(event, set);
  }
  set.add(handler);
  ensureWs();
  return () => {
    set.delete(handler);
    if (set.size === 0) webSubs.delete(event);
    if (webSubs.size === 0) closeWs();
  };
}
