import { useEffect, useRef, useState } from "react";
import { List, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toggleWindowMaximize, WindowControls } from "@/components/WindowControls";

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
  onReopen,
  canReopen,
  onCloseOthers,
  onCloseRight,
  trailing,
}: {
  tabs: TabItem[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onReorder: (from: number, to: number) => void;
  /** 双击标签重命名：空串表示恢复自动标题 */
  onRename: (id: number, title: string) => void;
  /** 恢复最近关闭的标签页（空白处右键菜单） */
  onReopen: () => void;
  /** 是否有可恢复的关闭标签（无则菜单项置灰） */
  canReopen: boolean;
  /** 关闭除该标签外的所有标签（标签右键菜单） */
  onCloseOthers: (id: number) => void;
  /** 关闭该标签右侧的所有标签（标签右键菜单） */
  onCloseRight: (id: number) => void;
  /** 右上角插槽（设置 / 主题 / 应用菜单），与「新建标签」按钮同行 */
  trailing?: React.ReactNode;
}) {
  /** 是否处于按住状态（true 才挂载全局 move/up 监听，避免之前只写 ref 不触发重渲染导致拖不动） */
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ idx: number; x: number } | null>(null);
  /** 正在内联重命名的标签 id */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  /** 右键菜单（v0.15 标签 / 空白处）：绝对定位在标签栏容器内，避免 portal + 根 zoom 导致溢出窗口 */
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<
    { kind: "tab"; idx: number; left: number; top: number } | { kind: "blank"; left: number; top: number } | null
  >(null);
  /** v0.22.2 全部标签下拉（Excel 式）：标签被压缩省略后仍可从这里查看/切换/关闭 */
  const [listOpen, setListOpen] = useState(false);
  const [listPos, setListPos] = useState({ left: 0, top: 0 });
  const listBtnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    setMenu({ kind: "tab", idx, left, top: el.offsetTop + el.offsetHeight });
  };

  /** 标签栏空白处右键：打开全局标签菜单（光标处）。
   *  clientX/Y 是视觉（zoom 后）坐标，而绝对定位的 left/top 是未缩放布局坐标，
   *  故用容器 rect 与 offsetWidth 的比值把坐标换算回布局空间。 */
  const openBlankMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const c = containerRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const ratioX = c.offsetWidth ? rect.width / c.offsetWidth : 1;
    const ratioY = c.offsetHeight ? rect.height / c.offsetHeight : 1;
    const MENU_W = 190;
    const left = Math.max(0, Math.min((e.clientX - rect.left) / ratioX, c.clientWidth - MENU_W));
    const top = (e.clientY - rect.top) / ratioY;
    setMenu({ kind: "blank", left, top });
  };

  /** 容器级右键：仅空白区域接管，标签/按钮/弹层内的右键各自处理或忽略 */
  const onBlankContextMenu = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-tab-idx],button,input,[data-tab-menu],[data-tabs-list-panel]")) return;
    openBlankMenu(e);
  };

  /** 打开「全部标签」下拉（定位到右侧列表按钮下方） */
  const openTabList = () => {
    const c = containerRef.current;
    const b = listBtnRef.current;
    if (c && b) {
      const LIST_W = 220;
      setListPos({
        left: Math.max(0, Math.min(b.offsetLeft, c.clientWidth - LIST_W)),
        top: b.offsetTop + b.offsetHeight,
      });
    }
    setListOpen(true);
  };

  // 右键菜单/全部标签下拉打开时：点击外部 / Esc / 窗口尺寸变化 → 关闭
  useEffect(() => {
    if (!menu && !listOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t)) setMenu(null);
      // 下拉按钮本身不算外部（mousedown 先于 click，否则点按钮会先关后开闪一下）
      if (
        listOpen &&
        !listRef.current?.contains(t) &&
        !listBtnRef.current?.contains(t)
      ) {
        setListOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setListOpen(false);
      }
    };
    const onResize = () => {
      setMenu(null);
      setListOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [menu, listOpen]);

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
      data-tauri-drag-region
      // 空白处右键：接管为全局标签菜单，屏蔽 WebView 默认菜单
      onContextMenu={onBlankContextMenu}
      // 无边框窗口（decorations:false）：标签栏兼任标题栏，空白处拖动移动窗口、
      // 双击最大化/还原。target 检查避免与标签双击重命名冲突（拖拽区按 target 判定）。
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) toggleWindowMaximize();
      }}
      className="relative flex items-end gap-0.5 border-b bg-muted/20 px-1.5 pt-1 select-none"
    >
      {/* v0.22.2：标签区可收缩（Excel 式）——空间不足时标题截断为省略号而不挤走
          右侧按钮；全部标签经「全部标签」下拉访问。空白处仍属标题栏拖动区 */}
      <div
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) toggleWindowMaximize();
        }}
        className="flex min-w-0 flex-1 items-end overflow-hidden"
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
              "group flex h-7 min-w-0 max-w-52 shrink cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs",
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
                "shrink-0 rounded p-0.5 hover:bg-muted",
                tab.id === activeId ? "opacity-60" : "opacity-0 group-hover:opacity-60",
              )}
            >
              <X className="h-3 w-3" />
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        ref={listBtnRef}
        data-tabs-list=""
        onClick={() => {
          if (listOpen) setListOpen(false);
          else openTabList();
        }}
        title="全部标签"
        className={cn(
          "mb-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
          listOpen && "bg-accent text-foreground",
        )}
      >
        <List className="h-3.5 w-3.5" />
      </button>
      <Button
        variant="ghost"
        size="sm"
        className="mb-0.5 h-7 w-7 shrink-0 px-0 text-muted-foreground"
        onClick={handleNew}
        onPointerUp={handleNew}
        title="新建标签页"
      >
        <Plus className="h-4 w-4" />
      </Button>

      {/* 右上角常驻区（设置 / 主题 / 应用菜单），多标签挤压时不收缩 */}
      {trailing && (
        <div className="mb-0.5 ml-auto flex h-7 shrink-0 items-center gap-0.5">
          {trailing}
        </div>
      )}

      {/* 无边框窗口自绘控制：最小化 / 最大化 / 关闭（贴右上角整行高，浏览器环境不渲染） */}
      <WindowControls />

      {/* 右键菜单（v0.15 标签 / 空白处全局）：容器内绝对定位，非 Portal */}
      {menu && (
        <div
          ref={menuRef}
          data-tab-menu=""
          className="absolute z-50 min-w-[168px] rounded-md border bg-popover p-1 text-sm shadow-md"
          style={{ left: menu.left, top: menu.top }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.kind === "tab" ? (
            <>
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
                disabled={tabs.length <= 1}
                onClick={() => {
                  onCloseOthers(tabs[menu.idx].id);
                  setMenu(null);
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                关闭其他标签页
              </button>
              <button
                type="button"
                disabled={menu.idx === tabs.length - 1}
                onClick={() => {
                  onCloseRight(tabs[menu.idx].id);
                  setMenu(null);
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                关闭右侧标签页
              </button>
              <div className="my-1 h-px bg-border" />
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
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  onNew();
                  setMenu(null);
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
              >
                新建标签页
              </button>
              <button
                type="button"
                disabled={!canReopen}
                onClick={() => {
                  onReopen();
                  setMenu(null);
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                恢复关闭的标签页
              </button>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  openTabList();
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
              >
                全部标签页…
              </button>
            </>
          )}
        </div>
      )}

      {/* v0.22.2 全部标签下拉：点击切换、行内 ✕ 关闭 */}
      {listOpen && (
        <div
          ref={listRef}
          data-tabs-list-panel=""
          className="absolute z-50 max-h-64 min-w-[220px] overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          style={{ left: listPos.left, top: listPos.top }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {tabs.map((tab, idx) => (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-1 rounded-sm pr-1 text-xs",
                tab.id === activeId ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
            >
              <button
                type="button"
                data-tabs-list-item={idx}
                onClick={() => {
                  onSelect(tab.id);
                  setListOpen(false);
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    tab.id === activeId ? "bg-primary" : "bg-transparent",
                  )}
                />
                <span className="truncate">{`${idx + 1}. ${tab.title || "新建标签"}`}</span>
              </button>
              <button
                type="button"
                data-tabs-close={idx}
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                  if (tabs.length <= 1) setListOpen(false);
                }}
                className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
