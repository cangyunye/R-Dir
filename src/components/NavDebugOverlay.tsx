/**
 * v0.52 导航诊断浮层（DEBUG 版常驻左下角）：实时显示 当前路径 / 加载状态 /
 * 原始输入事件流（按下/抬起/单击/双击，含目标行路径与连击序号）/ 加载触发流程。
 * 捕获监听挂在 window capture 阶段（优先于应用处理器，专抓“事件被谁吞了”）。
 * 正式包默认隐藏（localStorage rfm.debug-nav=1 打开）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  navDebugPush,
  navDebugSnapshot,
  navDebugSubscribe,
} from "@/lib/nav-debug";
import { cn } from "@/lib/utils";

export function NavDebugOverlay({
  panePath,
  loading,
  selection,
}: {
  panePath: string;
  loading: boolean;
  selection: string[];
}) {
  const snap = useSyncExternalStore(navDebugSubscribe, navDebugSnapshot);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(timer);
  }, []);

  // 原始输入事件捕获：mousedown/up/click/dblclick + 按键（F5/mod+r 刷新）
  useEffect(() => {
    const tag = (e: Event) => {
      const el = e.target as HTMLElement | null;
      return (
        el?.closest?.("[data-path]")?.getAttribute("data-path") ??
        el?.getAttribute?.("data-path") ??
        el?.tagName ??
        "?"
      );
    };
    const onDown = (e: MouseEvent) =>
      navDebugPush(
        `down b${e.button}`,
        `${tag(e)} d=${e.detail} @${Math.round(e.clientX)},${Math.round(e.clientY)}`,
      );
    const onUp = (e: MouseEvent) =>
      navDebugPush(`up b${e.button}`, `${tag(e)} d=${e.detail}`);
    const onClick = (e: MouseEvent) =>
      navDebugPush(`click b${e.button}`, `${tag(e)} d=${e.detail}`);
    const onDbl = (e: MouseEvent) => navDebugPush("dblclick", tag(e));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" || (e.key === "r" && (e.metaKey || e.ctrlKey)))
        navDebugPush(`key ${e.key}${e.metaKey ? " meta" : ""}${e.ctrlKey ? " ctrl" : ""}`);
    };
    window.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("mouseup", onUp, { capture: true });
    window.addEventListener("click", onClick, { capture: true });
    window.addEventListener("dblclick", onDbl, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown, { capture: true } as EventListenerOptions);
      window.removeEventListener("mouseup", onUp, { capture: true } as EventListenerOptions);
      window.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
      window.removeEventListener("dblclick", onDbl, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
    };
  }, []);

  const entries = useMemo(() => [...snap.entries].reverse(), [snap.seq]);

  return (
    <div
      data-nav-debug=""
      className="pointer-events-none fixed bottom-2 left-2 z-[200] w-[420px] rounded border border-primary/40 bg-background/95 p-2 font-mono text-[10px] leading-[13px] text-foreground/90 shadow-elevate"
    >
      <div className="mb-0.5 font-semibold text-primary">NAV DEBUG（仅窗口内生效）</div>
      <div className="truncate">PATH {panePath || "—"}</div>
      <div className={cn(loading ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
        LOADING {String(loading)} · SEL {selection.length}
      </div>
      <div className="mt-0.5 max-h-[150px] overflow-hidden border-t pt-0.5">
        {entries.map((e, i) => (
          <div key={`${e.t}-${i}`} className="truncate">
            {e.kind} {e.detail}
          </div>
        ))}
      </div>
    </div>
  );
}
