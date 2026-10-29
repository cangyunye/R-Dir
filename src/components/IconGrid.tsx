/**
 * 大图标 / 画廊视图（v0.27.0）。访达式图标网格：
 * - 布局：槽位坐标 {列,行} 的绝对定位网格 + 按行带虚拟滚动（lib/virtual-scroll）
 * - 自动排列：跟随 sortKey/sortDir；有「自由摆放」记录的条目按记录落位，
 *   其余条目首个空槽补位；右键空白处「整理图标」清空记录回到自动排列
 * - 位置存储：App 集中持有 iconPositions（应用数据目录 icon-positions.json，
 *   Rust iconpos 命令读写），按目录路径 → 条目名 → 槽位索引
 * - 拖拽：条目启用 HTML5 draggable，与详情列表同一套双路径——Windows 原生
 *   CF_HDROP 拖出 / macOS HTML5 file:// uri-list 拖出，因此可以拖到浏览器上传区、
 *   访达 / 资源管理器。应用内投放（文件夹图标 / 跨窗格）由 App 的 window 级
 *   dragover/drop 统一解析；同窗格拖到空槽 = 改摆放位置，由网格自己的 onDrop 处理。
 *   自研鼠标拖拽保留为 dragstart 未发生时的回落路径（jsdom / 极短拖动），
 *   dragstart 一旦触发即 cleanupDrag 交接，避免两套体系同时收尾
 * - 画廊模式（gallery）：图片条目渲染真实缩略图（ThumbImage），其余大类型图标
 * - 交互复用：橡皮筋框选（纯几何）、慢速双击重命名、条目右键菜单（EntryContextMenu）
 *   QuickJump 后续版本接入。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutGrid } from "lucide-react";
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
import { isSftpPath, isHttpPath } from "@/lib/sftp-path";
import { dragOutFiles } from "@/lib/api";
import {
  canNativeDragOut,
  getNativeDragOut,
  setNativeDragOut,
  setHtml5Drag,
} from "@/lib/native-drag";
import { useDragRubberBand } from "@/hooks/useDragRubberBand";
import { FileIcon } from "@/components/FileIcon";
import { ThumbImage } from "@/components/ThumbImage";
import { TagDots } from "@/components/TagView";
import { type RenameState } from "@/components/FileList";
import { RenameInput } from "@/components/RenameInput";
import { BlankContextMenuContent, EntryContextMenuContent } from "@/components/EntryContextMenu";
import type { QuickToolItem } from "@/lib/openerApi";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
  dragDir = null,
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
  onExtract,
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
  /** 原生拖拽悬停在本窗格某个文件夹图标上：该图标高亮为投放目标（App 的 window dragover 解析） */
  dragDir?: string | null;
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
  /** v0.32 解压压缩包：here=智能落点 / folder=归档名文件夹 / choose=自选目录 */
  onExtract: (paths: string[], mode: "here" | "folder" | "choose") => void;
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

  // v0.34.1 性能：按行分组可视条目。此前对全部 sorted map、越界 return null——
  // 10k 条目时每个滚动帧 React 都要 reconcile 一万个 keyed child（虚拟化只省了
  // 挂载没省 reconcile）；分组后每帧只遍历可视行内的条目。
  const rowsByIndex = useMemo(() => {
    const m = new Map<number, FileEntry[]>();
    for (const e of sorted) {
      const s = slotsByName.get(e.name);
      if (!s) continue;
      const arr = m.get(s.r);
      if (arr) arr.push(e);
      else m.set(s.r, [e]);
    }
    return m;
  }, [sorted, slotsByName]);
  const visibleEntries = useMemo(() => {
    const out: FileEntry[] = [];
    for (let r = startRow; r < endRow; r++) {
      const row = rowsByIndex.get(r);
      if (row) out.push(...row);
    }
    return out;
  }, [rowsByIndex, startRow, endRow]);

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

  // v0.35 新建文件/文件夹后滚动定位（与 FileList 同语义）：重命名行在视口外时推过去
  useEffect(() => {
    if (!renaming) return;
    const el = scrollRef.current;
    if (!el) return;
    const slot = slotsByName.get(sorted.find((x) => x.path === renaming.path)?.name ?? "");
    if (!slot) return;
    const target = slot.r * rowH;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight - rowH;
    if (target < top) el.scrollTop = target;
    else if (target > bottom) el.scrollTop = target - el.clientHeight + rowH * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming?.path, sorted]);

  const lastClickRef = useRef<{ path: string; time: number } | null>(null);
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const toggleMenuGroup = (id: string) => setExpandedMenu((cur) => (cur === id ? null : id));
  const [zoomTip, setZoomTip] = useState<number | null>(null);
  const zoomTipTimer = useRef<number | null>(null);
  const showZoomTip = (z: number) => {
    setZoomTip(z);
    if (zoomTipTimer.current) window.clearTimeout(zoomTipTimer.current);
    zoomTipTimer.current = window.setTimeout(() => setZoomTip(null), 1200);
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

  /** 同窗格空槽重摆（自研回落 mouseup 与 HTML5 drop 两条路径共用）：被拖项（多选按序）
   *  从落点槽位开始排，被占槽跳过；落点与原槽一致（原位单击拖动）则不产生任何变化。
   *  经 ref 每帧换新闭包——window 监听器持有旧帧，直引会拿到过期 slotsByName。 */
  const slotDropRef = useRef<(paths: string[], clientX: number, clientY: number) => void>(
    () => {},
  );
  slotDropRef.current = (paths, clientX, clientY) => {
    if (autoArrange || paths.length === 0) return;
    let { c, r } = slotAt(clientX, clientY);
    c = Math.max(0, c);
    r = Math.max(0, r);
    const occupant = new Map<string, string>(); // slotKey -> name
    for (const [name, s] of slotsByName) occupant.set(`${s.c}:${s.r}`, name);
    const order = sorted.filter((x) => paths.includes(x.path)).map((x) => x.name);
    const draggedNames = new Set(order);
    let placed = 0;
    for (const name of order) {
      const cur = slotsByName.get(name);
      for (let guard = 0; guard < 4096; guard++) {
        const key = `${c}:${r}`;
        const holder = occupant.get(key);
        const isSelfSlot = cur && cur.c === c && cur.r === r;
        if (isSelfSlot && placed === 0 && order.length === 1) break; // 原位
        if (!holder || draggedNames.has(holder)) {
          onSetIconPosition(name, [c, r]);
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
  };

  /** HTML5 / 原生拖回落回本窗格、且落点不是文件夹图标：应用内「空槽重摆」。
   *  文件夹图标与跨窗格投放不在这里拦（不 stopPropagation）——事件继续冒泡到
   *  window，由 App 的 drop 监听统一解析收尾（清会话 / 提示条）。 */
  const onBodyDrop = (e: React.DragEvent) => {
    const native = getNativeDragOut();
    const dt = e.dataTransfer;
    if (!native && !dt?.types.includes("application/x-rdir-dnd")) return;
    const srcId = native ? native.sourcePaneId : Number(dt!.getData("application/x-rdir-dnd"));
    if (srcId !== paneId) return;
    const paths = native
      ? native.paths
      : (dt!.getData("text/plain") ?? "").split("\n").filter(Boolean);
    if (paths.length === 0) return;
    const el = document.elementFromPoint?.(e.clientX, e.clientY) as HTMLElement | null;
    const dirPath =
      el?.closest?.("[data-grid-item][data-drop-dir]")?.getAttribute("data-path") ?? null;
    if (dirPath && !paths.includes(dirPath)) return; // 文件夹投放 → App 处理
    e.preventDefault();
    slotDropRef.current(paths, e.clientX, e.clientY);
  };

  // ---- 自研拖拽 + 橡皮筋（引擎抽在 useDragRubberBand，与 FileList 共用）----
  // 本侧注入：文件夹图标命中（[data-grid-item][data-drop-dir]，排除被拖路径自身）、
  // 窗格级落点排除本窗格、空槽重摆回落与 folderHover 高亮
  const [folderHover, setFolderHover] = useState<string | null>(null);
  const {
    rubber,
    suppressClickRef,
    ghostRef,
    startRubber,
    beginDragCandidate,
    armDragListeners,
    cleanupDrag,
  } = useDragRubberBand({
    rectRef: containerRef,
    hitRootRef: scrollRef,
    hitSelector: "[data-grid-item]",
    paneId,
    selection,
    resolveTarget: (x, y, draggedPaths) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return { paneId: null, dirPath: null };
      const dirEl = el.closest("[data-grid-item][data-drop-dir]") as HTMLElement | null;
      if (dirEl) {
        const p = dirEl.dataset.path;
        if (p && !draggedPaths.includes(p)) return { paneId: null, dirPath: p };
      }
      const paneEl = el.closest("[data-pane-id]") as HTMLElement | null;
      if (paneEl) {
        const id = Number(paneEl.dataset.paneId);
        if (id !== paneId) return { paneId: id, dirPath: null };
      }
      return { paneId: null, dirPath: null };
    },
    onSelectRange,
    onClearSelection,
    onDropPaths,
    onDropIntoDir,
    onSlotDrop: (paths, clientX, clientY) => slotDropRef.current(paths, clientX, clientY),
    onHoverChange: setFolderHover,
    onDragOverChange,
  });

  const startItemPress = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.metaKey || e.ctrlKey;
    if (e.shiftKey || additive) return; // 修饰键选择交给 click
    // 图标视图语义（访达一致）：按下未选中图标 = 立即选中并直接成为拖拽候选；
    // 已选中图标按下 = 携带全部选中项拖拽。空白处按下才是框选（startRubber）。
    if (!selectionSet.has(entry.path)) onSelect(entry, false);
    beginDragCandidate(
      e.clientX,
      e.clientY,
      selectionSet.has(entry.path) ? selection : [entry.path],
    );
    armDragListeners();
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
          // 阻断冒泡：全局 keymap「open」会再开一次（文件双开 / SFTP 双下载）
          e.stopPropagation();
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
          // 预览未启用时这里语义是切换选中；阻断冒泡避免全局 togglePreview 弹「未开启」提示
          e.stopPropagation();
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
              onDrop={onBodyDrop}
            >
              {dragTarget && (
                // pointer-events-none + -mb-6：纯展示浮层，不占流式高度、不抢首行命中，跨窗格拖入时网格内容不在光标下移动
                <div className="pointer-events-none -mb-6 sticky top-0 z-10 flex h-6 items-center justify-center bg-primary/10 text-[11px] font-medium text-primary">
                  {dragOp === "copy"
                    ? `复制到此处（按住 ${isMac ? "Option" : "Alt"} 切换移动）`
                    : "移动到此处"}
                </div>
              )}
              <div className="relative" style={{ height: totalH }}>
                {visibleEntries.map((entry) => {
                  const slot = slotsByName.get(entry.name)!;
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
                          draggable="true"
                          onDragStart={(e) => {
                            const paths = selectionSet.has(entry.path) ? selection : [entry.path];
                            // 原生拖出仅支持真实文件系统路径；sftp://、http:// 等虚拟路径走 HTML5 文本拖拽
                            // （应用内投放两条链路都由 App 的 window 监听完成，目标窗格类型无关）
                            const canNative =
                              canNativeDragOut() &&
                              paths.every((p) => !isSftpPath(p) && !isHttpPath(p));
                            if (canNative) {
                              // Windows 原生拖出（OLE 拖拽携带 CF_HDROP 文件引用）：浏览器上传
                              // 投放区 / 资源管理器只认真实文件，HTML5 的 text/uri-list 文本
                              // 格式一律被拒。preventDefault 后 HTML5 拖拽不会发生，拖回落到
                              // 本窗口的 dragover/drop 由 App 的 window 监听按 nativeDragOut 会话驱动
                              e.preventDefault();
                              cleanupDrag();
                              setNativeDragOut({ sourcePaneId: paneId, paths });
                              dragOutFiles(paths)
                                .catch((err) => console.warn("[rdir] 原生拖出失败：", err))
                                .finally(() => {
                                  setNativeDragOut(null);
                                  // 拖出窗外松手时 JS 收不到 drop/dragend，在此兜底清提示条
                                  cleanupDrag();
                                });
                              return;
                            }
                            if (canNativeDragOut()) {
                              // v0.34 Windows 原生拖放接管后 HTML5 投放不再到达页面：虚拟路径
                              // （sftp/http）保留自研鼠标拖拽（按下即是拖拽候选），只需阻止 HTML5 拖拽
                              e.preventDefault();
                              return;
                            }
                            // macOS / 非 Tauri 环境：HTML5 拖出（WKWebView 把 file:// uri-list 映射为 NSURL）
                            // 选中文本为空时拖当前项，否则拖选中项
                            const uriList = paths
                              .map((p) => "file://" + p.replace(/\\/g, "/"))
                              .join("\r\n");
                            e.dataTransfer.setData("text/uri-list", uriList);
                            e.dataTransfer.setData("text/plain", paths.join("\n"));
                            // 应用内拖拽标记：window 的 dragover/drop 据此驱动投放高亮与落盘
                            e.dataTransfer.setData("application/x-rdir-dnd", String(paneId));
                            e.dataTransfer.effectAllowed = "copyMove";
                            setHtml5Drag({ sourcePaneId: paneId, paths });
                            // 原生拖拽接管后 mousemove/mouseup 停发——停掉自研鼠标拖拽，
                            // 两套体系只留一套收尾（v0.27 旧实现因此冲突才禁用 draggable）
                            cleanupDrag();
                          }}
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
                            (dragDir === entry.path || folderHover === entry.path) &&
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
                        onExtract={onExtract}
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
          <BlankContextMenuContent
            currentDir={currentDir}
            pluginOpener={pluginOpener}
            pluginTerminal={pluginTerminal}
            showTerminal={pluginTerminal && shells.length > 0}
            terminalIcon={<span className="mr-2 h-4 w-4" />}
            terminalSeparator={false}
            quickTools={quickTools}
            onOpenQuickTool={onOpenQuickTool}
            onConfigureQuickTools={onConfigureQuickTools}
            shells={shells}
            gitBash={gitBash}
            onOpenTerminal={onOpenTerminal}
            onOpenGitTool={onOpenGitTool}
            expandedMenu={expandedMenu}
            onToggleGroup={toggleMenuGroup}
            onNewFolder={onNewFolder}
            onNewFile={onNewFile}
            canPaste={canPaste}
            onPaste={onPaste}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={onUndo}
            onRedo={onRedo}
            onSelectAll={onSelectAll}
            onInvertSelection={onInvertSelection}
            onDiff={onDiff}
            onSyncDiff={onSyncDiff}
            onRefresh={onRefresh}
            onPropertiesDir={onPropertiesDir}
            gridExtras={
              <>
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
              </>
            }
          />
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
