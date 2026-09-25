import { useEffect, useRef, useState } from "react";
import { ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PaneListItem {
  tabId: number;
  paneId: number;
  title: string;
  path: string;
  active: boolean;
}

/**
 * 「已连接的路径（窗格列表）」下拉（v0.9 引入，v0.15 修复溢出）。
 *
 * 修复说明：应用在 documentElement 上设了 CSS `zoom`（界面字体缩放），
 * 而 Radix DropdownMenu 走 Portal 渲染到 body，Floating UI 用未缩放的视口
 * 计算碰撞、用缩放后的坐标定位，二者不一致 → 右对齐下拉会跑到窗口外。
 * 这里改为「非 Portal 的绝对定位面板」（锚定在按钮的 relative 容器内，
 * right-0 贴右缘），坐标与按钮同处一个 zoom 坐标系，天然不出窗口。
 */
export function PaneListMenu({
  panes,
  onActivate,
}: {
  panes: PaneListItem[];
  onActivate: (tabId: number, paneId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7", open && "bg-accent text-accent-foreground")}
        title="已连接的路径（窗格列表）"
        onClick={() => setOpen((v) => !v)}
      >
        <ListTree className="h-4 w-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-72 w-80 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {panes.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无窗格</div>
          ) : (
            panes.map((p) => (
              <button
                key={`${p.tabId}:${p.paneId}`}
                type="button"
                onClick={() => {
                  onActivate(p.tabId, p.paneId);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="w-3 shrink-0 text-center font-mono text-primary">
                  {p.active ? "*" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{p.title}</span>
                <span className="max-w-44 truncate text-[10px] text-muted-foreground">
                  {p.path}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
