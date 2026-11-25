/**
 * v0.52 导航诊断浮层（DEBUG 版常驻左下角）：实时显示 当前路径 / 加载状态 / 选中 /
 * 按键与双击事件流 / 加载触发流程。正式包默认隐藏（localStorage rfm.debug-nav=1 打开）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { navDebugSnapshot, navDebugSubscribe } from "@/lib/nav-debug";
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

  const entries = useMemo(() => [...snap.entries].reverse(), [snap.seq]);

  return (
    <div
      data-nav-debug=""
      className="pointer-events-none fixed bottom-2 left-2 z-[200] w-[380px] rounded border border-primary/40 bg-background/95 p-2 font-mono text-[10px] leading-[13px] text-foreground/90 shadow-elevate"
    >
      <div className="mb-0.5 font-semibold text-primary">NAV DEBUG（仅窗口内生效）</div>
      <div className="truncate">PATH {panePath || "—"}</div>
      <div className={cn(loading ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
        LOADING {String(loading)} · SEL {selection.length}
      </div>
      <div className="mt-0.5 max-h-[120px] overflow-y-auto border-t pt-0.5">
        {entries.map((e, i) => (
          <div key={`${e.t}-${i}`} className="truncate">
            {e.kind} {e.detail}
          </div>
        ))}
      </div>
    </div>
  );
}
