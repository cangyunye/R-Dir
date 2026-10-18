/**
 * 大图标 / 画廊视图（v0.27.0）。访达式图标网格：
 * - 布局：槽位坐标 {列,行} 的绝对定位网格 + 按行带虚拟滚动（lib/virtual-scroll）
 * - 自动排列：跟随 sortKey/sortDir；有「自由摆放」记录的条目按记录落位，
 *   其余条目首个空槽补位；右键空白处「整理图标」清空记录回到自动排列
 * - 位置存储：App 集中持有 iconPositions（应用数据目录 icon-positions.json，
 *   Rust iconpos 命令读写），按目录路径 → 条目名 → 槽位索引
 * - 拖拽：自研鼠标拖拽（同 FileList）；同窗格内拖到空槽=改摆放位置，
 *   拖到文件夹图标上=移入/复制（Alt）该目录；跨窗格投放沿用 onDropPaths
 * - 画廊模式（gallery）：图片条目渲染真实缩略图（ThumbImage），其余大类型图标
 * - 交互复用：橡皮筋框选（纯几何）、慢速双击重命名、条目右键菜单（EntryContextMenu）
 *   说明：图标视图条目不启用 HTML5 draggable（避免 macOS 双拖拽体系冲突），
 *   因此暂不支持从图标视图拖出到访达（详情列表不受影响）；QuickJump 后续版本接入。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  Clipboard,
  FolderPlus,
  FilePlus2,
  GitBranch,
  LayoutGrid,
  Link2,
  RefreshCw,
  Info,
  Undo2,
  Redo2,
  ArrowLeftRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileEntry, IconSize, SortKey } from "@/lib/types";
import { sortEntries } from "@/lib/entry-sort";
import { fileKindOf, THUMBNAIL_KINDS } from "@/lib/filekind";
import {
  GRID_GAP,
  GRID_PAD,
  gridCell,
  gridCols,
  visibleGridRange,
} from "@/lib/virtual-scroll";
import { hideExtension } from "@/lib/format";
import { isMac } from "@/lib/keymap";
import { FileIcon } from "@/components/FileIcon";
import { ThumbImage } from "@/components/ThumbImage";
import { TagDots } from "@/components/TagView";
import { type RenameState } from "@/components/FileList";
import { RenameInput } from "@/components/RenameInput";
import { EntryContextMenuContent, QuickToolsStrip, quickStripVisible } from "@/components/EntryContextMenu";
import type { QuickToolItem } from "@/lib/openerApi";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuGroup } from "@/components/MenuGroup";
import type { FileTags, TagDef, TagNames } from "@/lib/persist";
import type { LinkSide } from "@/lib/sync-link";
import type { OpenerItem, ShellItem, GitToolItem } from "@/lib/openerApi";

interface Slot {
  c: number;
  r: number;
}

const slotKey = (s: Slot) => `${s.c}:${s.r}`;
/** 自动排列时使用的空记录表（稳定引用避免重布局） */
const EMPTY_SLOTS: Record<string, [number, number]> = {};

/** 布局：已存槽位优先占用，其余按序首个空槽补位。 */
export function layoutSlots(
  names: string[],
  cols: number,
  saved: Record<string, [number, number]>,
): Map<string, Slot> {
  const out = new Map<string, Slot>();
  const occupied = new Set<string>();
  const rest: string[] = [];
  for (const name of names) {
    const s = saved[name];
    if (s && Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[0] >= 0 && s[0] < cols) {
      const slot = { c: s[0], r: Math.max(0, s[1]) };
      if (!occupied.has(slotKey(slot))) {
        occupied.add(slotKey(slot));
        out.set(name, slot);
        continue;
      }
    }
    rest.push(name);
  }
  let c = 0;
  let r = 0;
  for (const name of rest) {
    while (occupied.has(slotKey({ c, r }))) {
      c += 1;
      if (c >= cols) {
        c = 0;
        r += 1;
      }
    }
    out.set(name, { c, r });
    occupied.add(slotKey({ c, r }));
    c += 1;
    if (c >= cols) {
      c = 0;
      r += 1;
    }
  }
  return out;
}

export function IconGrid({
  paneId,
  mode,
  iconSize,
  onIconSizeChange,
  entries,
  sortKey,
  sortDir,
  onSort,
  selection,
  onSelect,
  onSelectRange,
  onClearSelection,
  onOpen,
  onMiddleOpen,
  onCopy,
  onCut,
  onDelete,
  onRename,
  onRenameCommit,
  onRenameCancel,
  onCopyPath,
  onRefresh,
  onShareDir,
  onDropPaths,
  onDropIntoDir,
  onDragOverChange,
  onNewFolder,
  onNewFile,
  onPaste,
  canPaste,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onSelectAll,
  onInvertSelection,
  fileTags,
  tags: tagsProp,
  tagNames,
  customQuick,
  onToggleTag,
  onToggleQuick,
  currentDir,
  pluginOpener,
  pluginTerminal,
  openers,
  shells,
  vscodeDetected,
  gitTools,
  quickTools,
  onOpenWith,
  onOpenTerminal,
  onOpenVscode,
  onOpenGitTool,
  onOpenQuickTool,
  onConfigureQuickTools,
  onAddCustomOpener,
  dragTarget,
  dragOp,
  showHidden,
  showExtensions,
  spaceTogglesPreview,
  renaming,
  isActive,
  onActivate,
  zoom,
  onBack,
  onForward,
  onSyncDiff,
  onCompress,
  onProperties,
  onPropertiesDir,
  onDiff,
  compareBase,
  onSetCompareBase,
  onCompareWithBase,
  onComparePick,
  onCompareSelected,
  onViewPatch,
  iconPositions,
  onSetIconPosition,
  onClearIconPositions,
  autoArrange,
  onToggleAutoArrange,
  linkBadge,
}: {
  paneId: number;
  mode: "icons" | "gallery";
  iconSize: IconSize;
  onIconSizeChange: (size: IconSize) => void;
  entries: FileEntry[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  selection: string[];
  onSelect: (entry: FileEntry, additive: boolean) => void;
  onSelectRange: (paths: string[]) => void;
  onClearSelection: () => void;
  onOpen: (entry: FileEntry) => void;
  onMiddleOpen: (path: string) => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onDelete: (paths: string[]) => void;
  onRename: (entry: FileEntry) => void;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onCopyPath: (path: string) => void;
  onRefresh: () => void;
  onShareDir: (dir: string) => void;
  onDropPaths: (
    sourcePaneId: number,
    paths: string[],
    op: "copy" | "move",
    targetPaneId: number,
  ) => void;
  /** v0.27 拖到文件夹图标上：移入/复制（Alt）该目录 */
  onDropIntoDir: (paths: string[], op: "copy" | "move", destDir: string) => void;
  onDragOverChange: (target: { targetPaneId: number; op: "copy" | "move" } | null) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onSelectAll: () => void;
  onInvertSelection: () => void;
  fileTags: FileTags;
  /** 全量标签 = 预设 + 自定义（v0.28.0；缺省回落预设） */
  tags?: TagDef[];
  tagNames: TagNames;
  customQuick: string[];
  onToggleTag: (path: string, tagId: string) => void;
  onToggleQuick: (path: string) => void;
  currentDir: string;
  pluginOpener: boolean;
  pluginTerminal: boolean;
  openers: OpenerItem[];
  shells: ShellItem[];
  /** v0.29.0 右键「用 VSCode 打开」（文件/目录均可） */
  vscodeDetected: boolean;
  gitTools: GitToolItem[];
  /** v0.29.0 常用工具条（菜单第一行横排图标） */
  quickTools: QuickToolItem[];
  onOpenWith: (toolId: string, path: string) => void;
  onOpenTerminal: (shellId: string, path: string) => void;
  onOpenVscode: (path: string) => void;
  onOpenGitTool: (toolId: string, path: string) => void;
  onOpenQuickTool: (id: string, path: string) => void;
  onConfigureQuickTools: () => void;
  onAddCustomOpener: (path?: string, ext?: string) => Promise<void>;
  dragTarget: boolean;
  dragOp: "copy" | "move";
  showHidden: boolean;
  showExtensions: boolean;
  /** v0.28 预览栏启用时空格让位给「切换预览」，网格不再用空格加选 */
  spaceTogglesPreview?: boolean;
  renaming: RenameState | null;
  isActive: boolean;
  onActivate: () => void;
  zoom: number;
  onBack: () => void;
  onForward: () => void;
  /** 空白右键「同步比对（左右窗格）」，与详情列表菜单对齐 */
  onSyncDiff: () => void;
  onCompress: (paths: string[], format: "zip" | "tar" | "tgz") => void;
  onProperties: (entries: FileEntry[]) => void;
  onPropertiesDir: (dir: string) => void;
  onDiff: () => void;
  compareBase?: { path: string; name: string } | null;
  onSetCompareBase?: (entry: FileEntry, paneId: number) => void;
  onCompareWithBase?: (entry: FileEntry) => void;
  onComparePick?: (entry: FileEntry) => void;
  onCompareSelected?: (paths: [string, string]) => void;
  onViewPatch?: (path: string) => void;
  /** 当前目录的自由摆放记录（条目名 → [列,行]） */
  iconPositions: Record<string, [number, number]>;
  onSetIconPosition: (name: string, slot: [number, number]) => void;
  onClearIconPositions: () => void;
  /** v0.27.1 自动排列：开启后忽略摆放记录、拖动不再改位（访达「保持排列方式」） */
  autoArrange: boolean;
  onToggleAutoArrange: () => void;
  linkBadge?: LinkSide;
}) {
  const sorted = useMemo(
    () => sortEntries(entries, sortKey, sortDir, showHidden),
    [entries, sortKey, sortDir, showHidden],
  );
  const cell = gridCell(iconSize);
  const rowH = cell.h + GRID_GAP;
  /** Windows Git Bash：既是 Git 工具也是终端，空白处右键收进「在此处打开终端」组 */
  const gitBash = gitTools.find((t) => t.id === "gitbash");

  // ---- 滚动/尺寸 ----
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const [viewportW, setViewportW] = useState(800);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    setViewportW(el.clientWidth);
    const ro = new ResizeObserver(() => {
      setViewportH(el.clientHeight);
      setViewportW(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = gridCols(viewportW, cell.w);
  const saved = autoArrange ? EMPTY_SLOTS : iconPositions;
  const slotsByName = useMemo(
    () => layoutSlots(sorted.map((e) => e.name), cols, saved),
    [sorted, cols, saved, autoArrange],
  );
  const bySlot = useMemo(() => {
    const m = new Map<string, FileEntry>();
    for (const e of sorted) {
      const s = slotsByName.get(e.name);
      if (s) m.set(slotKey(s), e);
    }
    return m;
  }, [sorted, slotsByName]);
  const totalRows = useMemo(() => {
    let maxR = 0;
    for (const s of slotsByName.values()) maxR = Math.max(maxR, s.r);
    return maxR + 1;
  }, [slotsByName]);
  const { startRow, endRow, totalH } = visibleGridRange(totalRows, cell.h, scrollTop, viewportH);

  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const primary = selection.length > 0 ? selection[0] : null;

  // 主选中滚入可视区（与 FileList 同语义）
  useEffect(() => {
    if (!primary) return;
    const el = scrollRef.current;
    if (!el) return;
    const slot = slotsByName.get(sorted.find((x) => x.path === primary)?.name ?? "");
    if (!slot) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== el && el.contains(ae)) el.focus({ preventScroll: true });
    const target = slot.r * rowH;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight - rowH;
    if (target < top) el.scrollTop = target;
    else if (target > bottom) el.scrollTop = target - el.clientHeight + rowH * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary]);

  // ---- 用 ref 保存最新 props（window 监听器闭包防过期） ----
  const propsRef = useRef({
    paneId,
    selection,
    selectionSet,
    sorted,
    slotsByName,
    onDropPaths,
    onDropIntoDir,
    onDragOverChange,
    onClearSelection,
    onSelectRange,
    onSelect,
    onOpen,
    onSetIconPosition,
    autoArrange,
  });
  propsRef.current = {
    paneId,
    selection,
    selectionSet,
    sorted,
    slotsByName,
    onDropPaths,
    onDropIntoDir,
    onDragOverChange,
    onClearSelection,
    onSelectRange,
    onSelect,
    onOpen,
    onSetIconPosition,
    autoArrange,
  };

  // ---- 自研拖拽 + 橡皮筋（骨架与 FileList 一致，落点增加「文件夹图标」与「空槽」） ----
  const ghostRef = useRef<HTMLDivElement>(null);
  const dragCandRef = useRef<{ x: number; y: number; paths: string[] } | null>(null);
  const dragActiveRef = useRef(false);
  const lastTargetRef = useRef<number | null>(null);
  const lastOpRef = useRef<"copy" | "move">("copy");
  const folderHoverRef = useRef<string | null>(null);
  const [folderHover, setFolderHover] = useState<string | null>(null);
  const rubberRef = useRef<{ x0: number; y0: number; additive: boolean; fromItem: boolean } | null>(
    null,
  );
  const suppressClickRef = useRef(false);
  const lastClickRef = useRef<{ path: string; time: number } | null>(null);
  const [rubber, setRubber] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const toggleMenuGroup = (id: string) => setExpandedMenu((cur) => (cur === id ? null : id));
  const [zoomTip, setZoomTip] = useState<number | null>(null);
  const zoomTipTimer = useRef<number | null>(null);
  const showZoomTip = (z: number) => {
    setZoomTip(z);
    if (zoomTipTimer.current) window.clearTimeout(zoomTipTimer.current);
    zoomTipTimer.current = window.setTimeout(() => setZoomTip(null), 1200);
  };

  const cleanupDrag = () => {
    window.removeEventListener("mousemove", onWinMouseMove);
    window.removeEventListener("mouseup", onWinMouseUp);
    document.body.style.userSelect = "";
    dragActiveRef.current = false;
    dragCandRef.current = null;
    rubberRef.current = null;
    setRubber(null);
    lastTargetRef.current = null;
    lastOpRef.current = "copy";
    if (folderHoverRef.current !== null) {
      folderHoverRef.current = null;
      setFolderHover(null);
    }
    if (ghostRef.current) ghostRef.current.style.opacity = "0";
    propsRef.current.onDragOverChange(null);
  };

  /** 指针落点解析：文件夹图标（本窗格）→ {dir}；其他窗格 → {pane}；否则 null */
  const hitTarget = (x: number, y: number, draggedPaths: string[]) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const dirEl = el.closest("[data-grid-item][data-drop-dir]") as HTMLElement | null;
    if (dirEl) {
      const p = dirEl.dataset.path;
      if (p && !draggedPaths.includes(p)) return { kind: "dir" as const, path: p };
    }
    const paneEl = el.closest("[data-pane-id]") as HTMLElement | null;
    if (paneEl) {
      const id = Number(paneEl.dataset.paneId);
      if (id !== propsRef.current.paneId) return { kind: "pane" as const, paneId: id };
    }
    return null;
  };

  const onWinMouseMove = (e: MouseEvent) => {
    const cand = dragCandRef.current;
    if (cand) {
      if (Math.hypot(e.clientX - cand.x, e.clientY - cand.y) > 5) {
        if (!dragActiveRef.current) {
          dragActiveRef.current = true;
          document.body.style.userSelect = "none";
          if (ghostRef.current) ghostRef.current.style.opacity = "1";
        }
        e.preventDefault();
        const op: "copy" | "move" = e.altKey ? "move" : "copy";
        if (ghostRef.current) {
          ghostRef.current.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
          ghostRef.current.textContent = `${op === "move" ? "移动" : "复制"} ${cand.paths.length} 项`;
        }
        const hit = hitTarget(e.clientX, e.clientY, cand.paths);
        const folder = hit?.kind === "dir" ? hit.path : null;
        if (folder !== folderHoverRef.current) {
          folderHoverRef.current = folder;
          setFolderHover(folder);
        }
        const paneId = hit?.kind === "pane" ? hit.paneId : null;
        if (paneId !== lastTargetRef.current || op !== lastOpRef.current) {
          lastTargetRef.current = paneId;
          lastOpRef.current = op;
          propsRef.current.onDragOverChange(
            paneId !== null ? { targetPaneId: paneId, op } : null,
          );
        }
      }
      return;
    }
    const rb = rubberRef.current;
    if (rb) {
      const cRect = containerRef.current?.getBoundingClientRect();
      if (cRect) {
        setRubber({
          left: Math.min(rb.x0, e.clientX) - cRect.left,
          top: Math.min(rb.y0, e.clientY) - cRect.top,
          right: Math.max(rb.x0, e.clientX) - cRect.left,
          bottom: Math.max(rb.y0, e.clientY) - cRect.top,
        });
      }
    }
  };

  /** 指针位置 → 最近槽位（相对滚动内容坐标）。 */
  const slotAt = (clientX: number, clientY: number): Slot => {
    const el = scrollRef.current;
    const cRect = el?.getBoundingClientRect();
    const x = cRect ? clientX - cRect.left + (el?.scrollLeft ?? 0) - GRID_PAD : 0;
    const y = cRect ? clientY - cRect.top + (el?.scrollTop ?? 0) - GRID_PAD : 0;
    return {
      c: Math.round(x / (cell.w + GRID_GAP)),
      r: Math.round(y / (cell.h + GRID_GAP)),
    };
  };

  const onWinMouseUp = (e: MouseEvent) => {
    const cand = dragCandRef.current;
    if (cand) {
      dragCandRef.current = null;
      if (dragActiveRef.current) {
        const hit = hitTarget(e.clientX, e.clientY, cand.paths);
        const op = lastOpRef.current;
        const folder = folderHoverRef.current;
        cleanupDrag();
        if (hit?.kind === "dir") {
          propsRef.current.onDropIntoDir(cand.paths, op, hit.path);
        } else if (hit?.kind === "pane") {
          propsRef.current.onDropPaths(propsRef.current.paneId, cand.paths, op, hit.paneId);
        } else if (folder === null && cand.paths.length > 0 && !propsRef.current.autoArrange) {
          // 同窗格空槽重摆：被拖项（多选按序）从落点槽位开始排，被占槽跳过；
          // 落点与原槽一致（原位单击拖动）则不产生任何变化
          let { c, r } = slotAt(e.clientX, e.clientY);
          c = Math.max(0, c);
          r = Math.max(0, r);
          const occupant = new Map<string, string>(); // slotKey -> name
          for (const [name, s] of propsRef.current.slotsByName) occupant.set(`${s.c}:${s.r}`, name);
          const order = propsRef.current.sorted
            .filter((x) => cand.paths.includes(x.path))
            .map((x) => x.name);
          const draggedNames = new Set(order);
          let placed = 0;
          for (const name of order) {
            const cur = propsRef.current.slotsByName.get(name);
            for (let guard = 0; guard < 4096; guard++) {
              const key = `${c}:${r}`;
              const holder = occupant.get(key);
              const isSelfSlot = cur && cur.c === c && cur.r === r;
              if (isSelfSlot && placed === 0 && order.length === 1) break; // 原位
              if (!holder || draggedNames.has(holder)) {
                propsRef.current.onSetIconPosition(name, [c, r]);
                if (holder) occupant.delete(key);
                occupant.set(key, name);
                placed += 1;
                break;
              }
              c += 1;
              if (c >= cols) {
                c = 0;
                r += 1;
              }
            }
          }
        }
      } else {
        cleanupDrag();
      }
      return;
    }
    const rb = rubberRef.current;
    if (rb) {
      rubberRef.current = null;
      const cRect = containerRef.current?.getBoundingClientRect();
      setRubber(null);
      cleanupDrag();
      if (!cRect) return;
      const rx0 = Math.min(rb.x0, e.clientX) - cRect.left;
      const rx1 = Math.max(rb.x0, e.clientX) - cRect.left;
      const ry0 = Math.min(rb.y0, e.clientY) - cRect.top;
      const ry1 = Math.max(rb.y0, e.clientY) - cRect.top;
      const moved = Math.hypot(e.clientX - rb.x0, e.clientY - rb.y0) > 3;
      if (!moved) {
        if (!rb.fromItem) propsRef.current.onClearSelection();
        return;
      }
      suppressClickRef.current = true;
      const hit: string[] = [];
      scrollRef.current
        ?.querySelectorAll<HTMLElement>("[data-grid-item]")
        .forEach((item) => {
          const r = item.getBoundingClientRect();
          if (
            r.right >= rx0 + cRect.left &&
            r.left <= rx1 + cRect.left &&
            r.bottom >= ry0 + cRect.top &&
            r.top <= ry1 + cRect.top
          ) {
            const p = item.dataset.path;
            if (p) hit.push(p);
          }
        });
      if (rb.additive) {
        propsRef.current.onSelectRange([
          ...new Set([...propsRef.current.selection, ...hit]),
        ]);
      } else {
        propsRef.current.onSelectRange(hit);
      }
      return;
    }
    cleanupDrag();
  };

  const startItemPress = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.metaKey || e.ctrlKey;
    if (e.shiftKey || additive) return; // 修饰键选择交给 click
    // 图标视图语义（访达一致）：按下未选中图标 = 立即选中并直接成为拖拽候选；
    // 已选中图标按下 = 携带全部选中项拖拽。空白处按下才是框选（startRubber）。
    if (!selectionSet.has(entry.path)) onSelect(entry, false);
    dragCandRef.current = {
      x: e.clientX,
      y: e.clientY,
      paths: selectionSet.has(entry.path) ? selection : [entry.path],
    };
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
  };

  const startRubber = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    rubberRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      additive: e.metaKey || e.ctrlKey || e.shiftKey,
      fromItem: false,
    };
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
  };

  // ---- 键盘：方向键网格导航（基于槽位），Enter 打开，Space 加选 ----
  const moveFocus = (dc: number, dr: number) => {
    const cur = slotsByName.get(sorted.find((x) => x.path === primary)?.name ?? "");
    let target: Slot | undefined;
    if (!cur) {
      target = { c: 0, r: 0 };
    } else {
      let c = cur.c + dc;
      let r = cur.r + dr;
      if (dc !== 0 && (c < 0 || c >= cols)) return; // 左右越界不动
      if (r < 0) return;
      // 找最近的占用槽（跳过空洞，直到越界放弃）
      for (let guard = 0; guard < cols * 2 + 8; guard++) {
        if (c >= cols) {
          c = dc > 0 ? 0 : cols - 1;
          r += dc > 0 ? 1 : -1;
          if (r < 0) return;
        }
        const hit = bySlot.get(`${c}:${r}`);
        if (hit) {
          target = { c, r };
          break;
        }
        c += Math.sign(dc) || 0;
        r += Math.sign(dr) || 0;
      }
      if (!target) return;
    }
    const entry = bySlot.get(`${target.c}:${target.r}`);
    if (entry) onSelect(entry, false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(-1, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(1, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(0, -1);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(0, 1);
        break;
      case "Enter": {
        const p = sorted.find((x) => x.path === primary);
        if (p) {
          e.preventDefault();
          onOpen(p);
        }
        break;
      }
      case " ": {
        // v0.28 预览栏启用时空格归「切换预览」（App 全局分发），网格放行
        if (spaceTogglesPreview) break;
        const p = sorted.find((x) => x.path === primary);
        if (p) {
          e.preventDefault();
          onSelect(p, true);
        }
        break;
      }
    }
  };

  const hasPositions = Object.keys(saved).length > 0;

  return (
    <div
      ref={containerRef}
      data-pane-id={paneId}
      style={{ zoom }}
      onWheel={(e) => {
        // Ctrl+滚轮：图标档位循环（与详情列表的窗口缩放区分开）
        if (!e.ctrlKey) return;
        e.preventDefault();
        const sizes: IconSize[] = [48, 64, 96, 128];
        const idx = sizes.indexOf(iconSize);
        const next = sizes[Math.min(sizes.length - 1, Math.max(0, idx + (e.deltaY < 0 ? 1 : -1)))];
        if (next !== iconSize) {
          onIconSizeChange(next);
          showZoomTip(next);
        }
      }}
      onMouseUp={(e) => {
        if (e.button === 3) {
          e.preventDefault();
          onBack();
        } else if (e.button === 4) {
          e.preventDefault();
          onForward();
        }
      }}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background transition-shadow",
        isActive ? "shadow-[inset_0_0_0_1px_var(--ring)]" : "shadow-[inset_0_0_0_1px_transparent]",
        dragTarget && "shadow-[inset_0_0_0_2px_color-mix(in_oklch,var(--primary)_70%,transparent)]",
      )}
      onClick={onActivate}
      onContextMenu={onActivate}
    >
      {linkBadge && (
        <div
          data-sync-link-side={linkBadge}
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5"
          style={{
            background:
              linkBadge === "left"
                ? "var(--sync-mark-left, #f59e0b)"
                : "var(--sync-mark-right, #0ea5e9)",
          }}
        />
      )}
      {zoomTip !== null && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-primary/25 bg-background/85 px-4 py-1.5 text-xl font-semibold text-primary shadow-elevate backdrop-blur-sm">
          {zoomTip}px
        </div>
      )}
      <ContextMenu
        modal={false}
        onOpenChange={(o) => {
          if (!o) setExpandedMenu(null);
        }}
      >
        <ContextMenuTrigger asChild>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              data-icongrid-body=""
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto outline-none select-none"
              onMouseDown={startRubber}
              onKeyDown={handleKeyDown}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            >
              {dragTarget && (
                <div className="sticky top-0 z-10 flex h-6 items-center justify-center bg-primary/10 text-[11px] font-medium text-primary">
                  {dragOp === "copy"
                    ? `复制到此处（按住 ${isMac ? "Option" : "Alt"} 切换移动）`
                    : "移动到此处"}
                </div>
              )}
              <div className="relative" style={{ height: totalH }}>
                {sorted.map((entry) => {
                  const slot = slotsByName.get(entry.name);
                  if (!slot) return null;
                  if (slot.r < startRow || slot.r >= endRow) return null;
                  const selected = selectionSet.has(entry.path);
                  const isPrimary = primary === entry.path;
                  const isRenaming = renaming?.path === entry.path;
                  const kind = fileKindOf(entry);
                  const showThumb = mode === "gallery" && THUMBNAIL_KINDS.has(kind) && !entry.is_dir;
                  const targets = selectionSet.has(entry.path) ? selection : [entry.path];
                  const gridLabel = showExtensions ? entry.name : hideExtension(entry.name, entry.is_dir);
                  return (
                    <ContextMenu
                      key={entry.path}
                      onOpenChange={(o) => {
                        if (!o) setExpandedMenu(null);
                      }}
                    >
                      <ContextMenuTrigger asChild>
                        <div
                          data-grid-item=""
                          data-path={entry.path}
                          data-drop-dir={entry.is_dir ? "" : undefined}
                          role="gridcell"
                          aria-selected={selected}
                          tabIndex={-1}
                          onMouseDown={(e) => startItemPress(e, entry)}
                          onClick={(e) => {
                            if (suppressClickRef.current) {
                              suppressClickRef.current = false;
                              return;
                            }
                            if (e.detail === 1) {
                              const now = Date.now();
                              const last = lastClickRef.current;
                              if (
                                last &&
                                last.path === entry.path &&
                                now - last.time > 450 &&
                                now - last.time < 3000
                              ) {
                                lastClickRef.current = null;
                                onRename(entry);
                                return;
                              }
                              lastClickRef.current = { path: entry.path, time: now };
                            }
                            if (e.shiftKey) {
                              e.preventDefault();
                              const clickIdx = sorted.findIndex((x) => x.path === entry.path);
                              const anchorIdx = sorted.findIndex((x) => x.path === selection[0]);
                              if (anchorIdx >= 0 && clickIdx >= 0 && anchorIdx !== clickIdx) {
                                const [lo, hi] =
                                  anchorIdx < clickIdx
                                    ? [anchorIdx, clickIdx]
                                    : [clickIdx, anchorIdx];
                                onSelectRange(sorted.slice(lo, hi + 1).map((x) => x.path));
                                return;
                              }
                              onSelect(entry, false);
                              return;
                            }
                            onSelect(entry, e.metaKey || e.ctrlKey);
                          }}
                          onDoubleClick={() => onOpen(entry)}
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.preventDefault();
                              if (entry.is_dir) onMiddleOpen(entry.path);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onOpen(entry);
                          }}
                          className={cn(
                            "group absolute flex cursor-default flex-col items-center gap-1 rounded-lg p-2",
                            selected ? "bg-selected" : "hover:bg-muted",
                            isPrimary && "ring-1 ring-inset ring-primary/40",
                            folderHover === entry.path &&
                              "bg-primary/15 ring-2 ring-inset ring-primary",
                          )}
                          style={{
                            left: GRID_PAD + slot.c * (cell.w + GRID_GAP),
                            top: GRID_PAD + slot.r * rowH,
                            width: cell.w,
                            height: cell.h,
                          }}
                        >
                          {showThumb ? (
                            <ThumbImage
                              path={entry.path}
                              mtime={entry.modified}
                              size={iconSize}
                              className="shrink-0"
                              fallback={
                                <FileIcon entry={entry} size={iconSize} className="drop-shadow-md" />
                              }
                            />
                          ) : (
                            <FileIcon
                              entry={entry}
                              size={iconSize}
                              className="shrink-0 drop-shadow-md"
                            />
                          )}
                          {isRenaming ? (
                            <div className="w-full">
                              <RenameInput
                                initial={renaming.name}
                                fitWidth={{
                                  // 宽度下限=格子内容宽；上限=从格子内容左缘到窗格右缘的余量，
                                  // 框允许越出格子向右扩展（对齐资源管理器）但不产生横向滚动
                                  min: cell.w - 16,
                                  max: Math.max(
                                    cell.w - 16,
                                    viewportW -
                                      (GRID_PAD + slot.c * (cell.w + GRID_GAP) + 10) -
                                      4,
                                  ),
                                }}
                                onCommit={(name) => onRenameCommit(entry.path, name)}
                                onCancel={onRenameCancel}
                              />
                            </div>
                          ) : (
                            <>
                              <span
                                className={cn(
                                  "w-full line-clamp-2 break-words text-center text-[11px] leading-tight",
                                  entry.is_dir && "font-medium",
                                  entry.is_symlink && "italic",
                                  selected && "font-semibold",
                                )}
                                title={entry.name}
                              >
                                {gridLabel}
                              </span>
                              {/* 选中/悬停展开全名浮层：绝对定位盖到下方内容上，
                                  最多 4 行（长哈希名两行内放不下的兜底，悬停 title 仍在） */}
                              <span
                                data-testid="grid-label-full"
                                className={cn(
                                  "absolute inset-x-1 top-full z-20 hidden rounded-md border bg-background px-1.5 py-1 text-center text-[11px] leading-snug break-words shadow-lg",
                                  isPrimary ? "block" : "group-hover:block",
                                )}
                                aria-hidden
                              >
                                {gridLabel}
                              </span>
                            </>
                          )}
                          <TagDots path={entry.path} fileTags={fileTags} tags={tagsProp} />
                        </div>
                      </ContextMenuTrigger>
                      <EntryContextMenuContent
                        entry={entry}
                        targets={targets}
                        entries={sorted}
                        paneId={paneId}
                        pluginOpener={pluginOpener}
                        pluginTerminal={pluginTerminal}
                        openers={openers}
                        shells={shells}
                        vscodeDetected={vscodeDetected}
                        gitTools={gitTools}
                        quickTools={quickTools}
                        onOpenVscode={onOpenVscode}
                        onOpenGitTool={onOpenGitTool}
                        onOpenQuickTool={onOpenQuickTool}
                        onConfigureQuickTools={onConfigureQuickTools}
                        fileTags={fileTags}
                        tags={tagsProp}
                        tagNames={tagNames}
                        customQuick={customQuick}
                        compareBase={compareBase}
                        renaming={renaming}
                        canUndo={canUndo}
                        canRedo={canRedo}
                        expandedMenu={expandedMenu}
                        onToggleGroup={toggleMenuGroup}
                        onOpen={onOpen}
                        onOpenWith={onOpenWith}
                        onAddCustomOpener={onAddCustomOpener}
                        onOpenTerminal={onOpenTerminal}
                        onShareDir={onShareDir}
                        onCompress={onCompress}
                        onCopy={onCopy}
                        onCut={onCut}
                        onRename={onRename}
                        onDelete={onDelete}
                        onUndo={onUndo}
                        onRedo={onRedo}
                        onCopyPath={onCopyPath}
                        onSetCompareBase={onSetCompareBase}
                        onCompareWithBase={onCompareWithBase}
                        onComparePick={onComparePick}
                        onCompareSelected={onCompareSelected}
                        onViewPatch={onViewPatch}
                        onToggleTag={onToggleTag}
                        onToggleQuick={onToggleQuick}
                        onRefresh={onRefresh}
                        onProperties={onProperties}
                      />
                    </ContextMenu>
                  );
                })}
              </div>
              {sorted.length === 0 && (
                <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                  此目录为空
                </div>
              )}
              {rubber && (
                <div
                  className="pointer-events-none absolute z-10 border border-primary/70 bg-primary/10"
                  style={{
                    left: rubber.left,
                    top: rubber.top,
                    width: Math.max(0, rubber.right - rubber.left),
                    height: Math.max(0, rubber.bottom - rubber.top),
                  }}
                />
              )}
            </div>

            <div
              ref={ghostRef}
              className="pointer-events-none fixed left-0 top-0 z-50 rounded-md border bg-popover px-2 py-1 text-xs opacity-0 shadow-elevate"
              style={{ transform: "translate(0px, 0px)" }}
            >
              复制 0 项
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="max-h-[var(--radix-context-menu-content-available-height)] min-w-48 overflow-y-auto [scrollbar-width:thin]"
          collisionPadding={10}
        >
          {/* 常用工具条（与条目右键菜单第一行同款）：空白处 = 当前目录，一步用常用工具打开 */}
          {quickStripVisible(pluginOpener, currentDir) && (
            <QuickToolsStrip
              path={currentDir}
              tools={quickTools}
              onOpen={onOpenQuickTool}
              onConfigure={onConfigureQuickTools}
            />
          )}
          {pluginTerminal && shells.length > 0 && (
            <MenuGroup
              id="terminalEmpty"
              label="在此处打开终端"
              icon={<span className="mr-2 h-4 w-4" />}
              expanded={expandedMenu === "terminalEmpty"}
              onToggle={toggleMenuGroup}
            >
              {shells.map((sh) => (
                <ContextMenuItem
                  key={sh.id}
                  disabled={!sh.detected}
                  onClick={() => onOpenTerminal(sh.id, currentDir)}
                >
                  <span className="flex-1">{sh.name}</span>
                  {!sh.detected && <span className="text-[10px] text-muted-foreground">未安装</span>}
                </ContextMenuItem>
              ))}
              {/* Git Bash 本质是终端：空白处即当前目录内，同样可开（与目录右键「Git 打开」同源探测） */}
              {gitBash && (
                <ContextMenuItem
                  disabled={!gitBash.detected}
                  onClick={() => onOpenGitTool(gitBash.id, currentDir)}
                >
                  <GitBranch className="mr-2 h-4 w-4" />
                  <span className="flex-1">{gitBash.name}</span>
                  {!gitBash.detected && (
                    <span className="text-[10px] text-muted-foreground">未安装</span>
                  )}
                </ContextMenuItem>
              )}
            </MenuGroup>
          )}
          <ContextMenuItem onClick={onNewFolder}>
            <FolderPlus className="mr-2 h-4 w-4" /> 新建文件夹
          </ContextMenuItem>
          <ContextMenuItem onClick={onNewFile}>
            <FilePlus2 className="mr-2 h-4 w-4" /> 新建文本文件
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onPaste} disabled={!canPaste}>
            <Clipboard className="mr-2 h-4 w-4" /> 粘贴
          </ContextMenuItem>
          <ContextMenuItem onClick={onUndo} disabled={!canUndo}>
            <Undo2 className="mr-2 h-4 w-4" /> 撤销
          </ContextMenuItem>
          <ContextMenuItem onClick={onRedo} disabled={!canRedo}>
            <Redo2 className="mr-2 h-4 w-4" /> 重做
          </ContextMenuItem>
          <ContextMenuSeparator />
          <MenuGroup
            id="sortGrid"
            label="排序方式"
            icon={<LayoutGrid className="mr-2 h-4 w-4" />}
            expanded={expandedMenu === "sortGrid"}
            onToggle={toggleMenuGroup}
          >
            {(
              [
                ["name", "名称"],
                ["size", "大小"],
                ["modified", "修改时间"],
                ["type", "类型"],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <ContextMenuItem key={key} onSelect={() => onSort(key)}>
                {label}
                {sortKey === key && " ✓"}
              </ContextMenuItem>
            ))}
          </MenuGroup>
          <MenuGroup
            id="iconSize"
            label="图标大小"
            icon={<LayoutGrid className="mr-2 h-4 w-4" />}
            expanded={expandedMenu === "iconSize"}
            onToggle={toggleMenuGroup}
          >
            {([48, 64, 96, 128] as IconSize[]).map((s) => (
              <ContextMenuItem key={s} onSelect={() => onIconSizeChange(s)}>
                {s === 48 ? "小" : s === 64 ? "中" : s === 96 ? "大" : "超大"}
                {iconSize === s && " ✓"}
              </ContextMenuItem>
            ))}
          </MenuGroup>
          {mode === "icons" && (
            <ContextMenuItem
              onSelect={onToggleAutoArrange}
              data-auto-arrange-item=""
            >
              <LayoutGrid className="mr-2 h-4 w-4" /> 自动排列
              {autoArrange && <span className="ml-1">✓</span>}
            </ContextMenuItem>
          )}
          {hasPositions && !autoArrange && mode === "icons" && (
            <ContextMenuItem onSelect={onClearIconPositions}>
              <LayoutGrid className="mr-2 h-4 w-4" /> 整理图标
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onSelectAll}>
            <CheckSquare className="mr-2 h-4 w-4" /> 全选
          </ContextMenuItem>
          <ContextMenuItem onClick={onInvertSelection}>
            <CheckSquare className="mr-2 h-4 w-4" /> 反向选择
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onDiff}>
            <ArrowLeftRight className="mr-2 h-4 w-4" /> 与另一窗格差异比对…
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* 同步比对：与详情列表空白菜单对齐 */}
          <ContextMenuItem onClick={onSyncDiff}>
            <Link2 className="mr-2 h-4 w-4" /> 同步比对（左右窗格）
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> 刷新
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onPropertiesDir(currentDir)}>
            <Info className="mr-2 h-4 w-4" /> 属性（当前目录）
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
