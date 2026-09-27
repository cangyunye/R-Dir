import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 无边框窗口（decorations:false）的自绘窗口控制：最小化 / 最大化 / 关闭。
 * 关闭调用 close() 会触发既有 onCloseRequested → 询问保存会话（v0.3.0）链路，
 * 与系统标题栏的 × 行为一致。浏览器环境（无 Tauri internals）不渲染。
 */
export function WindowControls() {
  const [available, setAvailable] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    setAvailable(true);
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  if (!available) return null;

  return (
    <div className="-mr-1.5 ml-1 flex self-stretch items-stretch">
      <button
        title="最小化"
        onClick={() => void getCurrentWindow().minimize().catch(() => {})}
        className="flex w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        title={maximized ? "向下还原" : "最大化"}
        onClick={() => void getCurrentWindow().toggleMaximize().catch(() => {})}
        className="flex w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
      </button>
      <button
        title="关闭"
        onClick={() => void getCurrentWindow().close().catch(() => {})}
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** 浏览器环境安全的最大化/还原切换（无 Tauri internals 时静默忽略），供标签栏双击空白处复用 */
export function toggleWindowMaximize() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void getCurrentWindow().toggleMaximize().catch(() => {});
}
