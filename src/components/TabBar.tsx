import { useEffect, useRef, useState } from "react";
import { List, Plus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/keymap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WindowControls } from "@/components/WindowControls";

export interface TabItem {
  id: number;
  title: string;
}

/** 与 Tauri 注入的 drag.js（src/window/scripts/drag.js）同语义的 drag-region 判定：
 *  沿祖先向上找最近的 data-tauri-drag-region；可点元素（button/input/role=button/
 *  tabindex≥0 …）自身不带标记时阻断；裸标记只有直接点在该元素上才算生效。 */
const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);

function inTitlebarDragRegion(target: HTMLElement): boolean {
  let el: HTMLElement | null = target;
  while (el) {
    const attr = el.getAttribute("data-tauri-drag-region");
    const interactive =
      CLICKABLE_TAGS.has(el.tagName) ||
      (el.getAttribute("contenteditable") ?? "false") !== "false" ||
      (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
      INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "");
    if (interactive && attr === null) return false;
    if (attr === "false") return false;
    if (attr === "deep") return true;
    if (attr !== null) return el === target; // bare / "true"
    el = el.parentElement;
  }
  return false;
}

/** OneNote 风格标签色相环：按 tab.id 稳定取色（会话恢复后同一标签颜色不变）。
 *  实色明度钳在 ≤0.72 保证深色模式白字可读；黄色系饱和度高、白字发飘，单独配深色前景。
 *  浅色模式不做实色块——改走面包屑同款洗色方案（同色相深字 + 底部实色条），
 *  轻重策略集中在 index.css 的 .rdirtab 复合变量里，这里只注入色相派生色。 */
const TAB_HUES: { l: number; c: number; h: number; darkFg?: string }[] = [
  { l: 0.58, c: 0.13, h: 250 }, // 蓝
  { l: 0.62, c: 0.12, h: 195 }, // 青
  { l: 0.62, c: 0.13, h: 155 }, // 绿
  { l: 0.68, c: 0.12, h: 128, darkFg: "oklch(0.28 0.05 130)" }, // 黄绿
  { l: 0.72, c: 0.12, h: 95, darkFg: "oklch(0.30 0.06 90)" }, // 黄
  { l: 0.64, c: 0.15, h: 60 }, // 橙
  { l: 0.6, c: 0.18, h: 28 }, // 红
  { l: 0.6, c: 0.18, h: 350 }, // 玫红
  { l: 0.58, c: 0.15, h: 310 }, // 紫
  { l: 0.56, c: 0.11, h: 275 }, // 靛
];

/** 标签身份 → 色相派生色（tab.id 连续自增，新标签自然轮换色相） */
export function tabColorOf(id: number) {
  const t = TAB_HUES[id % TAB_HUES.length];
  return {
    /** 实色：深色模式活动块 / 浅色模式底部色条 / 下拉圆点 */
    solid: `oklch(${t.l} ${t.c} ${t.h})`,
    /** 深色模式活动块文字 */
    darkFg: t.darkFg ?? "white",
    /** 浅色模式活动块文字（同色相深色，压住洗色底） */
    lightFg: `oklch(0.32 0.07 ${t.h})`,
  };
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
  onFavoriteTab,
  onOpenFavorites,
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
  /** 收藏该标签的布局快照（标签右键菜单） */
  onFavoriteTab: (id: number) => void;
  /** 打开收藏夹面板（空白处右键菜单） */
  onOpenFavorites: () => void;
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
  /** macOS 双击最大化接管：第二次 mousedown 的位置（mouseup 时未移动才算双击切换） */
  const dbl2Ref = useRef<{ x: number; y: number } | null>(null);

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
      // 无边框窗口（decorations:false）：标签栏兼任标题栏，空白处拖动移动窗口由
      // Tauri 注入的 drag-region 脚本原生处理（mousedown → start_dragging）。
      // 双击最大化/还原在 macOS 上必须由这里接管（见 onMouseUpCapture）：
      // 原生 internal_toggle_maximize 的放大分支被 is_maximizable() 挡死——
      // 无边框窗口没有标准标题栏按钮，该检查在 macOS 恒为 false，于是原生双击
      // 只能「还原」不能「放大」（tauri 2.x 未修，dev 分支同样）。
      // 这里不要再挂 React onDoubleClick（双击走 mouseup 捕获拦截，见下）。
      onMouseDown={(e) => {
        if (isMac && e.button === 0 && e.detail === 2) {
          dbl2Ref.current = { x: e.clientX, y: e.clientY };
        }
      }}
      onMouseUpCapture={(e) => {
        const start = dbl2Ref.current;
        dbl2Ref.current = null;
        if (!isMac || !start || e.button !== 0 || e.detail !== 2) return;
        // 鼠标移动过 = 取消（与 drag.js「双击后移动可取消最大化」的语义一致）
        if (e.clientX !== start.x || e.clientY !== start.y) return;
        if (!inTitlebarDragRegion(e.target as HTMLElement)) return;
        if (!("__TAURI_INTERNALS__" in window)) return;
        // 捕获阶段合成事件 stopPropagation 会停掉原生传播——drag.js 的 document
        // 冒泡监听收不到，internal_toggle_maximize（只能还原）不再触发；
        // 改调无门槛的公开 toggle_maximize，两个方向都正确。
        e.stopPropagation();
        void getCurrentWindow()
          .toggleMaximize()
          .catch(() => {});
      }}
      className="relative flex items-end gap-0.5 border-b bg-sidebar px-1.5 pt-1 select-none"
    >
      {/* v0.22.2：标签区可收缩（Excel 式）——空间不足时标题截断为省略号而不挤走
          右侧按钮；全部标签经「全部标签」下拉访问。空白处仍属标题栏拖动区 */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-end overflow-hidden"
      >
        {tabs.map((tab, idx) => {
          const color = tabColorOf(tab.id);
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              data-tab-idx={idx}
              data-tab-active={active ? "true" : undefined}
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
              style={
                {
                  "--tab-c": color.solid,
                  "--tab-fg": color.darkFg,
                  "--tab-deep": color.lightFg,
                } as React.CSSProperties
              }
              className={cn(
                // OneNote 式色块标签：活动标签更高（items-end 底对齐，向上长出）。
                // 轻重随主题折算：深色=实色块+白字，浅色=面包屑同款洗色+同色相深字
                // （复合变量定义见 index.css .rdirtab）；底部 2px 实色条是"贴住内容"
                // 的锚，深色下与活动块同色自然隐形
                "rdirtab group relative flex min-w-0 max-w-52 shrink cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs",
                active
                  ? "h-[30px] border-transparent bg-[var(--tab-active-bg)] text-[var(--tab-active-fg)]"
                  : "h-[26px] border-transparent bg-[var(--tab-idle-bg)] text-muted-foreground hover:bg-[var(--tab-idle-hover-bg)]",
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
                    // IME 组合中的回车是确认候选词，不作为提交
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
                  "shrink-0 rounded p-0.5",
                  active
                    ? "hover:bg-[var(--tab-x-hover)]"
                    : "opacity-0 hover:bg-muted group-hover:opacity-60",
                )}
              >
                <X className="h-3 w-3" />
              </span>
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-[var(--tab-c)]"
                />
              )}
            </div>
          );
        })}
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
          className="absolute z-50 min-w-[168px] rounded-md border bg-popover p-1 text-sm shadow-elevate"
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
                  onFavoriteTab(tabs[menu.idx].id);
                  setMenu(null);
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
              >
                收藏此标签页
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
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  onOpenFavorites();
                }}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
              >
                收藏夹…
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
          className="absolute z-50 max-h-64 min-w-[220px] overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-elevate"
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
                    tab.id !== activeId && "opacity-60",
                  )}
                  style={{ background: tabColorOf(tab.id).solid }}
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
