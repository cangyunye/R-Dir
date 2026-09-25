import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  onRename,
}: {
  tabs: TabItem[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onReorder: (from: number, to: number) => void;
  /** 双击标签重命名：空串表示恢复自动标题 */
  onRename: (id: number, title: string) => void;
}) {
  /** 是否处于按住状态（true 才挂载全局 move/up 监听，避免之前只写 ref 不触发重渲染导致拖不动） */
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ idx: number; x: number } | null>(null);
  /** 正在内联重命名的标签 id */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  /** 右键标签菜单（v0.15）：绝对定位在标签栏容器内，避免 portal + 根 zoom 导致溢出窗口 */
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ idx: number; left: number; top: number } | null>(null);

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  /** 在标签下方打开右键菜单（坐标用 offsetLeft/Top，与绝对定位同一坐标系，zoom 安全） */
  const openTabMenu = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const c = containerRef.current;
    if (!c) return;
    const MENU_W = 168;
    const left = Math.max(0, Math.min(el.offsetLeft, c.clientWidth - MENU_W));
    setMenu({ idx, left, top: el.offsetTop + el.offsetHeight });
  };

  // 菜单打开时：点击外部 / Esc / 窗口尺寸变化 → 关闭
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onResize = () => setMenu(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [menu]);

  /** 新建标签：pointerup + click 双通道触发 + 300ms 去重
   *  （WKWebView / WebView2 个别版本 click 事件合成不可靠） */
  const lastNewAt = useRef(0);
  const handleNew = () => {
    const now = Date.now();
    if (now - lastNewAt.current < 300) return;
    lastNewAt.current = now;
    onNew();
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const start = dragRef.current;
      if (!start) return;
      // 未超过阈值不算拖拽
      if (Math.abs(e.clientX - start.x) < 5) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const tabEl = el?.closest?.("[data-tab-idx]") as HTMLElement | null;
      if (!tabEl) return;
      const idx = Number(tabEl.dataset.tabIdx);
      if (!Number.isNaN(idx) && idx !== start.idx) {
        onReorder(start.idx, idx);
        dragRef.current = { idx, x: e.clientX };
      }
    };
    const onUp = () => endDrag();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, onReorder]);

  const startRename = (tab: TabItem) => {
    setDraft(tab.title);
    setEditingId(tab.id);
  };

  const commitRename = () => {
    if (editingId === null) return;
    onRename(editingId, draft.trim());
    setEditingId(null);
  };

  return (
    <div
      ref={containerRef}
      className="relative flex items-end gap-0.5 border-b bg-muted/20 px-1.5 pt-1 select-none"
    >
      {tabs.map((tab, idx) => (
        <div
          key={tab.id}
          role="button"
          tabIndex={0}
          data-tab-idx={idx}
          onClick={() => onSelect(tab.id)}
          onDoubleClick={() => startRename(tab)}
          onContextMenu={(e) => openTabMenu(e, idx)}
          onAuxClick={(e) => {
            // 鼠标中键关闭标签页（阻止默认自动滚动）
            if (e.button === 1) {
              e.preventDefault();
              onClose(tab.id);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSelect(tab.id);
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            dragRef.current = { idx, x: e.clientX };
            setDragging(true);
          }}
          className={cn(
            "group flex h-7 max-w-52 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs",
            tab.id === activeId
              ? "border-border bg-background text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/50",
            dragging && dragRef.current?.idx === idx && "opacity-60 ring-1 ring-inset ring-primary/50",
          )}
          title={editingId === tab.id ? undefined : tab.title}
        >
          {editingId === tab.id ? (
            <Input
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setEditingId(null);
              }}
              className="h-5 w-28 px-1 text-xs"
              placeholder="标签名"
            />
          ) : (
            <span className="truncate">{tab.title || "新建标签"}</span>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
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
        className="mb-0.5 h-7 w-7 px-0 text-muted-foreground"
        onClick={handleNew}
        onPointerUp={handleNew}
        title="新建标签页"
      >
        <Plus className="h-4 w-4" />
      </Button>

      {/* 右键标签菜单（v0.15）：关闭 / 重命名 / 移动到最右边 */}
      {menu && (
        <div
          ref={menuRef}
          className="absolute z-50 min-w-[168px] rounded-md border bg-popover p-1 text-sm shadow-md"
          style={{ left: menu.left, top: menu.top }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            disabled={tabs.length <= 1}
            onClick={() => {
              onClose(tabs[menu.idx].id);
              setMenu(null);
            }}
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            关闭标签
          </button>
          <button
            type="button"
            onClick={() => {
              startRename(tabs[menu.idx]);
              setMenu(null);
            }}
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
          >
            重命名
          </button>
          <button
            type="button"
            disabled={menu.idx === tabs.length - 1}
            onClick={() => {
              onReorder(menu.idx, tabs.length - 1);
              setMenu(null);
            }}
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            移动到最右边
          </button>
        </div>
      )}
    </div>
  );
}
