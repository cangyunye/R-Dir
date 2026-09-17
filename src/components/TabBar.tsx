import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface TabItem {
  id: number;
  title: string;
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onReorder,
}: {
  tabs: TabItem[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onReorder: (from: number, to: number) => void;
}) {
  /** 正在拖拽的标签索引（激活后） */
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const dragStartRef = useRef<{ idx: number; x: number } | null>(null);

  const endDrag = () => {
    dragStartRef.current = null;
    setDragIdx(null);
  };

  useEffect(() => {
    if (dragStartRef.current === null) return;
    const onMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      // 未激活时需超过阈值才开始拖拽
      if (dragIdx === null && Math.abs(e.clientX - start.x) < 5) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const tabEl = el?.closest?.("[data-tab-idx]") as HTMLElement | null;
      if (!tabEl) return;
      const idx = Number(tabEl.dataset.tabIdx);
      if (!Number.isNaN(idx) && idx !== start.idx) {
        onReorder(start.idx, idx);
        dragStartRef.current = { idx, x: e.clientX };
        setDragIdx(idx);
      }
    };
    const onUp = () => endDrag();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIdx, onReorder]);

  return (
    <div className="flex items-end gap-0.5 border-b bg-muted/20 px-1.5 pt-1 select-none">
      {tabs.map((tab, idx) => (
        <div
          key={tab.id}
          role="button"
          tabIndex={0}
          data-tab-idx={idx}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSelect(tab.id);
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            dragStartRef.current = { idx, x: e.clientX };
          }}
          className={cn(
            "group flex h-7 max-w-52 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs transition-colors",
            tab.id === activeId
              ? "border-border bg-background text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/50",
            dragIdx === idx && "opacity-60 ring-1 ring-inset ring-primary/50",
          )}
          title={tab.title}
        >
          <span className="truncate">{tab.title || "新建标签"}</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                onClose(tab.id);
              }
            }}
            className={cn(
              "rounded p-0.5 hover:bg-muted",
              tab.id === activeId ? "opacity-60" : "opacity-0 group-hover:opacity-60",
            )}
          >
            <X className="h-3 w-3" />
          </span>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="mb-0.5 h-6 w-6 px-0 text-muted-foreground"
        onClick={onNew}
        title="新建标签页"
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
