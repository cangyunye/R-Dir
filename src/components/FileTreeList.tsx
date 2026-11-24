/**
 * v0.52 树形列表模式（访达式行内展开目录树）：
 * - 根 = 当前目录（pane.entries），子目录首次展开时 listDir 懒加载并缓存
 * - 行高 26 固定，递归展平为 { entry, depth } 后复用 visibleRange 虚拟滚动
 * - 仅名称列（无大小/时间列），不渲染标签标记（标签方案仅详情列表生效）
 * - 交互对齐 FileList：单击/加选/Shift 范围选、慢速双击重命名、双击进入目录、
 *   ← 折叠/跳父 → 展开、右键菜单、拖出/拖入目录、矩形框选、QuickJump、缩放
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Share2, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/LanguageProvider";
import type { FileEntry, SortDir, SortKey } from "@/lib/types";
import { hideExtension } from "@/lib/format";
import { sortEntries } from "@/lib/entry-sort";
import { listDir } from "@/lib/api";
import type { LinkSide } from "@/lib/sync-link";
import { markColor, markTooltip } from "@/components/SyncDiffPanel";
import { FileIcon } from "@/components/FileIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { RenameInput, routeRenameRowPress } from "@/components/RenameInput";
import { DragGhost } from "@/components/DragGhost";
import { ROW_HEIGHT, visibleRange } from "@/lib/virtual-scroll";
import type { DiffMarkMap } from "@/lib/sync-link";
import { TAG_DEFS, type FileTags, type MenuConfig, type TagDef, type TagNames, type TagScheme } from "@/lib/persist";
import { BlankContextMenuContent, EntryContextMenuContent } from "@/components/EntryContextMenu";
import { rank } from "@/lib/fuzzy";
import { isMac } from "@/lib/keymap";
import { isSftpPath, isHttpPath, isNfsPath } from "@/lib/sftp-path";
import { dragOutFiles } from "@/lib/api";
import { canNativeDragOut, fileUriList, setNativeDragOut, setHtml5Drag } from "@/lib/native-drag";
import { useDragRubberBand } from "@/hooks/useDragRubberBand";
import { QuickJump, type QuickJumpRow } from "@/components/QuickJump";
import { TagMarker } from "@/components/TagView";
import type { RenameState } from "@/components/FileList";

/** 树行缩进步长（px/层）与首层基准左边距 */
const DEPTH_STEP = 14;
const BASE_PAD = 6;
/** QuickJump 结果窗口大小（与 FileList 同值） */
const QJ_MAX_ROWS = 200;

function qjWindowStart(total: number, active: number): number {
  if (total <= QJ_MAX_ROWS) return 0;
  return Math.min(Math.max(0, active - Math.floor(QJ_MAX_ROWS / 2)), total - QJ_MAX_ROWS);
}

export function FileTreeList({
  paneId,
  entries,
  sortKey,
  sortDir,
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
  onBatchRename,
  onCopyPath,
  onRefresh,
  onDropPaths,
  onDragOverChange,
  onNewFolder,
  onNewFile,
  onShareDir,
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
  tagScheme,
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
  renaming,
  onRenameCommit,
  onRenameCancel,
  isActive,
  onActivate,
  zoom,
  onZoomChange,
  onBack,
  onForward,
  onCompress,
  onExtract,
  onCreateShortcuts,
  menuCfg,
  onProperties,
  onPropertiesDir,
  onDiff,
  onSyncDiff,
  compareBase,
  onSetCompareBase,
  onCompareWithBase,
  onComparePick,
  onCompareSelected,
  onViewPatch,
  diffMarks,
  linkBadge,
}: {
  paneId: number;
  entries: FileEntry[];
  sortKey: SortKey;
  sortDir: SortDir;
  selection: string[];
  onSelect: (entry: FileEntry, additive: boolean) => void;
  onSelectRange: (paths: string[]) => void;
  onClearSelection: () => void;
  onOpen: (entry: FileEntry) => void;
  /** 鼠标中键点击目录：在新建标签页中打开该目录 */
  onMiddleOpen: (path: string) => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onDelete: (paths: string[]) => void;
  onRename: (entry: FileEntry) => void;
  /** v0.52 批量改名（多选 ≥2；转发右键菜单入口） */
  onBatchRename?: (paneId: number, entries: FileEntry[]) => void;
  onCopyPath: (path: string) => void;
  onRefresh: () => void;
  /** 跨窗格拖拽落盘：targetPaneId 为鼠标松开时检测到的目标窗格 */
  onDropPaths: (
    sourcePaneId: number,
    paths: string[],
    op: "copy" | "move",
    targetPaneId: number,
  ) => void;
  onDragOverChange: (target: { targetPaneId: number; op: "copy" | "move" } | null) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onShareDir: (dir: string) => void;
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
  /** v0.52 标签方案：树形列表与详情列表同款标签标记 */
  tagScheme: TagScheme;
  tagNames: TagNames;
  customQuick: string[];
  onToggleTag: (path: string, tagId: string) => void;
  onToggleQuick: (path: string) => void;
  currentDir: string;
  pluginOpener: boolean;
  pluginTerminal: boolean;
  openers: import("@/lib/openerApi").OpenerItem[];
  shells: import("@/lib/openerApi").ShellItem[];
  vscodeDetected: boolean;
  gitTools: import("@/lib/openerApi").GitToolItem[];
  quickTools: import("@/lib/openerApi").QuickToolItem[];
  onOpenWith: (toolId: string, path: string) => void;
  onOpenTerminal: (shellId: string, path: string) => void;
  onOpenVscode: (path: string) => void;
  onOpenGitTool: (toolId: string, path: string) => void;
  onOpenQuickTool: (id: string, path: string) => void;
  onConfigureQuickTools: () => void;
  onAddCustomOpener: (path?: string, ext?: string) => Promise<void>;
  dragTarget: boolean;
  dragOp: "copy" | "move";
  /** 原生拖拽悬停在本窗格某个目录行上：该行高亮为投放目标 */
  dragDir?: string | null;
  showHidden: boolean;
  showExtensions: boolean;
  renaming: RenameState | null;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  isActive: boolean;
  onActivate: () => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onBack: () => void;
  onForward: () => void;
  onCompress: (paths: string[], format: "zip" | "tar" | "tgz") => void;
  onExtract: (paths: string[], mode: "here" | "folder" | "choose") => void;
  onCreateShortcuts: (paths: string[], toDesktop: boolean) => void;
  menuCfg?: MenuConfig;
  onProperties: (entries: FileEntry[]) => void;
  onPropertiesDir: (dir: string) => void;
  onDiff: () => void;
  onSyncDiff: () => void;
  compareBase?: { path: string; name: string } | null;
  onSetCompareBase?: (entry: FileEntry, paneId: number) => void;
  onCompareWithBase?: (entry: FileEntry) => void;
  onComparePick?: (entry: FileEntry) => void;
  onCompareSelected?: (paths: [string, string]) => void;
  onViewPatch?: (path: string) => void;
  diffMarks?: DiffMarkMap;
  linkBadge?: LinkSide;
}) {
  const t = useT();

  // ---- 树状态：展开集合 + 子项缓存（懒加载，存原始 listDir 结果，展平时统一排序） ----
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, FileEntry[]>>(() => new Map());
  /** 加载中去重 + 失效代际：目录切换/刷新清缓存后，飞行中的旧结果不再回写 */
  const loadingRef = useRef<Set<string>>(new Set());
  const genRef = useRef(0);

  /** 懒加载某目录的子项（原始结果入缓存，排序统一在展平时做）；
   *  失败（目录消失/无权限）缓存空数组——表现为可展开的空目录，
   *  折叠再展开或刷新（refreshKey 清缓存）即可重试 */
  const loadChildren = async (path: string) => {
    if (childrenMap.has(path) || loadingRef.current.has(path)) return;
    loadingRef.current.add(path);
    const gen = genRef.current;
    try {
      const list = await listDir(path);
      if (gen !== genRef.current) return; // 期间缓存被清（导航/刷新），丢弃
      setChildrenMap((prev) => {
        const next = new Map(prev);
        next.set(path, list);
        return next;
      });
    } catch {
      if (gen !== genRef.current) return;
      setChildrenMap((prev) => {
        const next = new Map(prev);
        next.set(path, []);
        return next;
      });
    } finally {
      loadingRef.current.delete(path);
    }
  };

  // 导航换目录：展开状态与缓存全部重置（树重新扎根）
  useEffect(() => {
    genRef.current += 1;
    loadingRef.current.clear();
    setExpanded(new Set());
    setChildrenMap(new Map());
  }, [currentDir]);

  // 刷新（refreshKey 经由 entries 变化体现，这里按 currentDir 维度不够——
  // 改用 entries 引用：缓存里的子项可能已过期，全部作废重拉）
  const entriesKey = useMemo(() => entries.map((e) => e.path).join("\n"), [entries]);
  useEffect(() => {
    genRef.current += 1;
    loadingRef.current.clear();
    setChildrenMap(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesKey]);

  // 已展开但缓存缺失的目录补拉（展开瞬间 / 缓存刚清后）
  useEffect(() => {
    for (const p of expanded) {
      if (!childrenMap.has(p) && !loadingRef.current.has(p)) void loadChildren(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, childrenMap]);

  const toggleDir = (entry: FileEntry) => {
    if (!entry.is_dir) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  // ---- 展平为可视行（根排序复用 pane 的 sortKey/sortDir/showHidden） ----
  const rows = useMemo(() => {
    const out: { entry: FileEntry; depth: number }[] = [];
    const walk = (list: FileEntry[], depth: number) => {
      for (const e of list) {
        out.push({ entry: e, depth });
        if (e.is_dir && expanded.has(e.path)) {
          const kids = childrenMap.get(e.path);
          if (kids && kids.length > 0) walk(sortEntries(kids, sortKey, sortDir, showHidden), depth + 1);
        }
      }
    };
    walk(sortEntries(entries, sortKey, sortDir, showHidden), 0);
    return out;
  }, [entries, childrenMap, expanded, sortKey, sortDir, showHidden]);
  /** 展平后的纯条目列表（右键菜单 entries / DragGhost 图标查表用） */
  const flatEntries = useMemo(() => rows.map((r) => r.entry), [rows]);

  const primary = selection.length > 0 ? selection[0] : null;
  /** Shift 范围选择的锚点 */
  const anchorRef = useRef<string | null>(null);
  // 主选中变化时滚动进可视区（搜索定位等外部选中），数学同 FileList
  const listScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!primary) return;
    const el = listScrollRef.current;
    if (!el) return;
    const idx = rows.findIndex((r) => r.entry.path === primary);
    if (idx < 0) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== el && el.contains(ae)) el.focus({ preventScroll: true });
    const target = idx * ROW_HEIGHT;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight - ROW_HEIGHT;
    if (target < top) el.scrollTop = target;
    else if (target > bottom) el.scrollTop = target - el.clientHeight + ROW_HEIGHT * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary]);

  // 重命名行滚入可视区（新建文件后重命名输入框必须可见），数学同 FileList
  useEffect(() => {
    if (!renaming) return;
    const el = listScrollRef.current;
    if (!el) return;
    const idx = rows.findIndex((r) => r.entry.path === renaming.path);
    if (idx < 0) return;
    const target = idx * ROW_HEIGHT;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight - ROW_HEIGHT;
    if (target < top) el.scrollTop = target;
    else if (target > bottom) el.scrollTop = target - el.clientHeight + ROW_HEIGHT * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming?.path, rows]);

  // ---- v0.8.3 虚拟滚动：固定行高，只渲染可视区 +/- buffer 行 ----
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    setViewportH(e.currentTarget.clientHeight);
    hideNameTip();
  };
  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 名称悬停 1 秒完整名提示（截断时出现），同 FileList ----
  const [nameTip, setNameTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const nameTipTimer = useRef<number | null>(null);
  const hideNameTip = () => {
    if (nameTipTimer.current) {
      window.clearTimeout(nameTipTimer.current);
      nameTipTimer.current = null;
    }
    setNameTip(null);
  };
  const nameTipHandlers = (text: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLSpanElement>) => {
      const el = e.currentTarget;
      if (nameTipTimer.current) window.clearTimeout(nameTipTimer.current);
      nameTipTimer.current = window.setTimeout(() => {
        nameTipTimer.current = null;
        if (el.scrollWidth <= el.clientWidth) return;
        const r = el.getBoundingClientRect();
        setNameTip({ text, x: r.left, y: r.top });
      }, 1000);
    },
    onMouseLeave: hideNameTip,
    onMouseDown: hideNameTip,
  });
  useEffect(
    () => () => {
      if (nameTipTimer.current) window.clearTimeout(nameTipTimer.current);
    },
    [],
  );

  // v0.24 快速定位浮层：直接键入开窗，模糊过滤当前展平可见行
  const [qjOpen, setQjOpen] = useState(false);
  const [qjQuery, setQjQuery] = useState("");
  const [qjActive, setQjActive] = useState(0);
  const qjRestoreRef = useRef<string[]>([]);
  const qjOpenRef = useRef(false);
  const qjMatches = useMemo(
    () => (qjOpen ? rank(flatEntries, qjQuery, (e) => e.name) : []),
    [qjOpen, flatEntries, qjQuery],
  );
  const qjWindowStartIndex = useMemo(
    () => qjWindowStart(qjMatches.length, qjActive),
    [qjMatches.length, qjActive],
  );
  const qjRows: QuickJumpRow[] = useMemo(
    () =>
      qjMatches
        .slice(qjWindowStartIndex, qjWindowStartIndex + QJ_MAX_ROWS)
        .map((m) => ({ entry: m.item, positions: m.positions })),
    [qjMatches, qjWindowStartIndex],
  );

  const focusListBody = () => listScrollRef.current?.focus({ preventScroll: true });
  const openQuickJump = (seed: string) => {
    qjRestoreRef.current = propsRef.current.selection;
    qjOpenRef.current = true;
    setQjQuery(seed);
    setQjActive(0);
    setQjOpen(true);
  };
  const closeQuickJump = () => {
    qjOpenRef.current = false;
    setQjOpen(false);
    setQjQuery("");
  };
  const qjMove = (delta: 1 | -1) => {
    setQjActive((a) => {
      const n = qjMatches.length;
      if (!n) return 0;
      return (a + delta + n) % n;
    });
  };
  const qjConfirm = (index: number) => {
    const m = qjMatches[index];
    closeQuickJump();
    if (m) {
      if (m.item.is_dir) propsRef.current.onOpen(m.item);
      else propsRef.current.onSelect(m.item, false);
    }
    focusListBody();
  };
  const qjCancel = () => {
    closeQuickJump();
    const restore = qjRestoreRef.current;
    if (restore.length) propsRef.current.onSelectRange(restore);
    else propsRef.current.onClearSelection();
    focusListBody();
  };
  // 高亮项变化即实时跟随（复用 primary 滚动 effect）
  useEffect(() => {
    if (!qjOpen || !qjOpenRef.current) return;
    const m = qjMatches[qjActive];
    if (m) propsRef.current.onSelect(m.item, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qjOpen, qjActive, qjMatches]);
  // 结果变少时把高亮夹紧到有效范围
  useEffect(() => {
    setQjActive((a) => Math.min(a, Math.max(0, qjMatches.length - 1)));
  }, [qjMatches.length]);
  // 目录切换时关窗
  useEffect(() => {
    setQjOpen(false);
    setQjQuery("");
  }, [currentDir]);

  // 选中集合 Set 化（渲染路径每行判断）
  const selectionSet = useMemo(() => new Set(selection), [selection]);
  // ref 保鲜：拖拽/框选引擎与 QJ 回调的闭包读最新值
  const propsRef = useRef({
    onSelect,
    onSelectRange,
    onClearSelection,
    onOpen,
    selection,
    selectionSet,
    rows,
  });
  propsRef.current = { onSelect, onSelectRange, onClearSelection, onOpen, selection, selectionSet, rows };

  // ---- 自实现拖拽 + 矩形框选（引擎与 FileList/IconGrid 共用） ----
  const containerRef = useRef<HTMLDivElement>(null);
  /** 慢速双击重命名：记录上次单击的条目与时间 */
  const lastClickRef = useRef<{ path: string; time: number } | null>(null);
  const [dragGhostState, setDragGhostState] = useState<{
    paths: string[];
    op: "copy" | "move";
  } | null>(null);
  const {
    rubber,
    suppressClickRef,
    ghostRef,
    startRubber,
    beginDragCandidate,
    beginRubber,
    resetRubber,
    armDragListeners,
    cleanupDrag,
  } = useDragRubberBand({
    rectRef: containerRef,
    hitRootRef: containerRef,
    hitSelector: "[data-path]",
    paneId,
    isBlankPress: (target) =>
      !(target instanceof Element) || target.closest('[role="row"]') === null,
    onDragActiveChange: (s) => setDragGhostState(s),
    selection,
    resolveTarget: (x, y) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const paneEl = el?.closest?.("[data-pane-id]") as HTMLElement | null;
      return { paneId: paneEl ? Number(paneEl.dataset.paneId) : null, dirPath: null };
    },
    onSelectRange,
    onClearSelection,
    onDropPaths,
    onDragOverChange,
  });

  /** 行拖拽的目标集合：已选中项按下时携带全部选中项 */
  const targetsFor = (entry: FileEntry): string[] =>
    propsRef.current.selectionSet.has(entry.path)
      ? propsRef.current.selection
      : [entry.path];

  const startRowPress = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // 重命名输入框内按下：交还给文本拖选
    if ((e.target as HTMLElement).closest?.("input")) return;
    // F2 准心路由（同 FileList）：重命名行上、输入框之外的左键按压 → 输入框文本拖选
    if (
      renaming?.path === entry.path &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      const inputEl = (e.currentTarget as HTMLElement).querySelector("input");
      if (inputEl) {
        e.preventDefault();
        routeRenameRowPress(inputEl, e.clientX);
        return;
      }
    }
    const fromSelected = propsRef.current.selectionSet.has(entry.path);
    const additive = e.metaKey || e.ctrlKey;
    if (fromSelected) {
      beginDragCandidate(e.clientX, e.clientY, targetsFor(entry));
    } else {
      if (!additive && !e.shiftKey) propsRef.current.onSelect(entry, false);
      beginRubber(e.clientX, e.clientY, additive || e.shiftKey, true);
    }
    armDragListeners();
  };

  // ---- 键盘导航：↑↓ 行间移动；→ 展开；← 折叠或跳父 ----
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (qjOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        qjCancel();
      }
      return;
    }
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const tgt = e.target as HTMLElement;
    if (tgt.closest("input,textarea")) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (rows.length === 0) return;
      e.preventDefault();
      const delta = e.key === "ArrowUp" ? -1 : 1;
      const idx = rows.findIndex((r) => r.entry.path === primary);
      const next =
        idx < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + delta));
      const row = rows[next];
      if (row && row.entry.path !== primary) onSelect(row.entry, false);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const cur = propsRef.current.rows.find((r) => r.entry.path === primary);
      if (!cur) return;
      e.preventDefault();
      if (e.key === "ArrowRight") {
        if (cur.entry.is_dir && !expanded.has(cur.entry.path)) toggleDir(cur.entry);
        return;
      }
      if (cur.entry.is_dir && expanded.has(cur.entry.path)) {
        toggleDir(cur.entry);
        return;
      }
      // 已折叠/文件：跳到最近的浅一层祖先（访达语义）
      const idx = propsRef.current.rows.indexOf(cur);
      for (let j = idx - 1; j >= 0; j--) {
        if (propsRef.current.rows[j].depth < cur.depth) {
          onSelect(propsRef.current.rows[j].entry, false);
          return;
        }
      }
      return;
    }
    if (e.key.length !== 1) return;
    if (e.key === " ") return; // 空格 = 预览开关，不拉起 QuickJump
    e.preventDefault();
    openQuickJump(e.key);
  };

  // v0.8 缩放百分比提示（Ctrl+滚轮后显示，1.2s 淡出）
  const [zoomTip, setZoomTip] = useState<number | null>(null);
  const zoomTipTimer = useRef<number | null>(null);
  const showZoomTip = (z: number) => {
    setZoomTip(z);
    if (zoomTipTimer.current) window.clearTimeout(zoomTipTimer.current);
    zoomTipTimer.current = window.setTimeout(() => setZoomTip(null), 1200);
  };
  // v0.10 右键菜单二级折叠组
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const toggleMenuGroup = (id: string) => setExpandedMenu((cur) => (cur === id ? null : id));
  const gitBash = gitTools.find((g) => g.id === "gitbash");

  return (
    <div
      ref={containerRef}
      data-pane-id={paneId}
      style={{ zoom }}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const step = e.deltaY < 0 ? 0.1 : -0.1;
        const next = Math.min(2, Math.max(0.5, Math.round((zoom + step) * 10) / 10));
        if (next !== zoom) {
          onZoomChange(next);
          showZoomTip(next);
        }
      }}
      onMouseUp={(e) => {
        // 鼠标侧键：后退(3) / 前进(4)（mouseup 兼容 WKWebView，同 FileList）
        if (e.button === 3) {
          e.preventDefault();
          onBack();
        } else if (e.button === 4) {
          e.preventDefault();
          onForward();
        }
      }}
      onMouseDownCapture={(e) => {
        const ae = document.activeElement as HTMLElement | null;
        if (ae?.id === "rdir-addr-input" && !(e.target as HTMLElement).closest("[data-path]")) {
          e.preventDefault();
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
      {qjOpen && (
        <QuickJump
          query={qjQuery}
          rows={qjRows}
          activeIndex={qjActive - qjWindowStartIndex}
          totalMatches={qjMatches.length}
          onQueryChange={(q) => {
            setQjQuery(q);
            setQjActive(0);
          }}
          onMove={qjMove}
          onConfirm={() => qjConfirm(qjActive)}
          onHover={(i) => {
            if (!qjOpenRef.current) return;
            setQjActive(qjWindowStartIndex + i);
          }}
          onActivate={(i) => qjConfirm(qjWindowStartIndex + i)}
          onCancel={qjCancel}
          onOutsideDown={() => {
            closeQuickJump();
            focusListBody();
          }}
        />
      )}
      {zoomTip !== null && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-primary/25 bg-background/85 px-4 py-1.5 text-xl font-semibold text-primary shadow-elevate backdrop-blur-sm">
          {Math.round(zoomTip * 100)}%
        </div>
      )}
      {nameTip && (
        <div
          data-name-tip=""
          className="pointer-events-none fixed z-[60] flex max-w-[min(60vw,520px)] items-center whitespace-pre-wrap break-all rounded-md border bg-popover px-2 py-1 text-xs shadow-elevate"
          style={{ left: nameTip.x, top: nameTip.y - 2 }}
        >
          {nameTip.text}
        </div>
      )}
      {/* 空白处右键：新建 / 粘贴 / 全选等（行上右键由行内菜单接管） */}
      <ContextMenu
        modal={false}
        onOpenChange={(o) => {
          if (!o) setExpandedMenu(null);
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            ref={listScrollRef}
            data-filelist-body=""
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-auto pb-8 outline-none select-none [scrollbar-gutter:stable]"
            onMouseDown={startRubber}
            onMouseDownCapture={(e) => {
              const ae = document.activeElement as HTMLElement | null;
              if (ae?.id === "rdir-addr-input") return;
              if ((e.target as HTMLElement).closest("input,textarea,[data-quickjump]")) return;
              if (
                renaming &&
                (e.target as HTMLElement).closest("[data-path]")?.getAttribute("data-path") ===
                  renaming.path
              )
                return;
              listScrollRef.current?.focus({ preventScroll: true });
            }}
            onKeyDown={handleListKeyDown}
            onScroll={onListScroll}
          >
            {dragTarget && (
              <div className="pointer-events-none -mb-6 sticky top-0 z-10 flex h-6 items-center justify-center bg-primary/10 text-[11px] font-medium text-primary">
                {dragOp === "copy"
                  ? t("复制到此处（按住 {key} 切换移动）", { key: isMac ? "Option" : "Alt" })
                  : t("移动到此处")}
              </div>
            )}
            {(() => {
              const { start, end, padTop, padBottom } = visibleRange(rows.length, scrollTop, viewportH);
              return (
                <>
                  {padTop > 0 && <div style={{ height: padTop }} />}
                  {rows.slice(start, end).map(({ entry, depth }) => {
                    const selected = selectionSet.has(entry.path);
                    const isPrimary = primary === entry.path;
                    const isRenaming = renaming?.path === entry.path;
                    const isOpen = entry.is_dir && expanded.has(entry.path);
                    const mark = diffMarks?.[entry.name];
                    const targets = selectionSet.has(entry.path) ? selection : [entry.path];
                    return (
                      <ContextMenu key={entry.path} onOpenChange={(o) => { if (!o) setExpandedMenu(null); }}>
                        <ContextMenuTrigger asChild>
                          <div
                            role="row"
                            tabIndex={0}
                            data-path={entry.path}
                            data-drop-dir={entry.is_dir ? "" : undefined}
                            draggable={renaming?.path !== entry.path}
                            onDragStart={(e) => {
                              if (e.defaultPrevented) return;
                              const paths = selectionSet.has(entry.path) ? selection : [entry.path];
                              const canNative =
                                canNativeDragOut() &&
                                paths.every((p) => !isSftpPath(p) && !isNfsPath(p) && !isHttpPath(p));
                              if (canNative) {
                                // Windows 原生 CF_HDROP 拖出（同 FileList）
                                console.info("[rdir] drag-out: 原生 CF_HDROP 拖拽", paths.length, "项");
                                e.preventDefault();
                                cleanupDrag();
                                setNativeDragOut({ sourcePaneId: paneId, paths });
                                dragOutFiles(paths)
                                  .catch((err) => console.warn("[rdir] 原生拖出失败：", err))
                                  .finally(() => {
                                    setNativeDragOut(null);
                                    cleanupDrag();
                                  });
                                return;
                              }
                              if (canNativeDragOut()) {
                                // 虚拟路径（sftp/http 等）改走自研鼠标拖拽
                                console.info("[rdir] drag-out: 虚拟路径走应用内鼠标拖拽", paths.length, "项");
                                e.preventDefault();
                                resetRubber();
                                beginDragCandidate(e.clientX, e.clientY, paths);
                                return;
                              }
                              // HTML5 文本拖出（macOS / 非 Tauri）
                              e.dataTransfer.setData("text/uri-list", fileUriList(paths));
                              e.dataTransfer.setData("text/plain", paths.join("\n"));
                              e.dataTransfer.setData("application/x-rdir-dnd", String(paneId));
                              e.dataTransfer.effectAllowed = "copyMove";
                              setHtml5Drag({ sourcePaneId: paneId, paths });
                              cleanupDrag();
                            }}
                            onMouseDown={(e) => startRowPress(e, entry)}
                            onClick={(e) => {
                              if (suppressClickRef.current) {
                                suppressClickRef.current = false;
                                return;
                              }
                              // 慢速双击（Finder 风格）→ 重命名
                              if (e.detail === 1) {
                                const now = Date.now();
                                const last = lastClickRef.current;
                                if (last && last.path === entry.path && now - last.time > 450 && now - last.time < 3000) {
                                  lastClickRef.current = null;
                                  onRename(entry);
                                  return;
                                }
                                lastClickRef.current = { path: entry.path, time: now };
                              }
                              if (e.shiftKey) {
                                e.preventDefault();
                                const anchor = anchorRef.current;
                                const anchorIdx = anchor ? rows.findIndex((r) => r.entry.path === anchor) : -1;
                                const clickIdx = rows.findIndex((r) => r.entry.path === entry.path);
                                if (anchorIdx >= 0 && clickIdx >= 0 && anchorIdx !== clickIdx) {
                                  const [lo, hi] =
                                    anchorIdx < clickIdx ? [anchorIdx, clickIdx] : [clickIdx, anchorIdx];
                                  onSelectRange(rows.slice(lo, hi + 1).map((r) => r.entry.path));
                                  return;
                                }
                                anchorRef.current = entry.path;
                                onSelect(entry, false);
                                return;
                              }
                              anchorRef.current = entry.path;
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
                              if (e.key === "Enter") {
                                e.stopPropagation();
                                onOpen(entry);
                              }
                              if (e.key === " ") {
                                e.preventDefault();
                              }
                            }}
                            className={cn(
                              "flex cursor-default items-center border-b text-[13px]",
                              selected ? "bg-selected" : "hover:bg-muted",
                              isPrimary && "ring-1 ring-inset ring-primary/40",
                              entry.is_dir &&
                                dragDir === entry.path &&
                                "bg-primary/15 ring-2 ring-inset ring-primary",
                            )}
                            style={{
                              height: ROW_HEIGHT,
                              paddingLeft: BASE_PAD + depth * DEPTH_STEP,
                            }}
                          >
                            {/* 展开箭头：仅目录；文件占同宽空位对齐图标（访达语义） */}
                            {entry.is_dir ? (
                              <button
                                type="button"
                                tabIndex={-1}
                                aria-expanded={isOpen}
                                aria-label={isOpen ? t("折叠") : t("展开")}
                                className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                onMouseDown={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleDir(entry);
                                }}
                              >
                                {isOpen ? (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5" />
                                )}
                              </button>
                            ) : (
                              <span className="mr-1 h-4 w-4 shrink-0" />
                            )}
                            <FileIcon entry={entry} size={16} className="shrink-0" />
                            {/* v0.52 标签方案（与详情列表同款）：圆点/竖条在图标后，药丸在文件名后 */}
                            {tagScheme !== "pills" && (
                              <TagMarker path={entry.path} fileTags={fileTags} tags={tagsProp ?? TAG_DEFS} tagNames={tagNames} scheme={tagScheme} />
                            )}
                            {mark && (
                              <span
                                data-diff-mark={mark.status}
                                className="ml-1 h-2.5 w-[3px] shrink-0 rounded-[2px]"
                                style={{ background: markColor(mark) }}
                                title={markTooltip(mark)}
                              />
                            )}
                            {isRenaming ? (
                              <RenameInput
                                initial={renaming.name}
                                isDir={entry.is_dir}
                                onCommit={(name) => onRenameCommit(entry.path, name)}
                                onCancel={onRenameCancel}
                              />
                            ) : (
                              <span
                                className={cn(
                                  "min-w-0 truncate",
                                  entry.is_dir && "font-medium",
                                  entry.is_symlink && "italic",
                                  selected && "font-semibold",
                                )}
                                {...nameTipHandlers(
                                  showExtensions ? entry.name : hideExtension(entry.name, entry.is_dir),
                                )}
                              >
                                {showExtensions ? entry.name : hideExtension(entry.name, entry.is_dir)}
                              </span>
                            )}
                            {tagScheme === "pills" && (
                              <TagMarker path={entry.path} fileTags={fileTags} tags={tagsProp ?? TAG_DEFS} tagNames={tagNames} scheme="pills" />
                            )}
                          </div>
                        </ContextMenuTrigger>
                        <EntryContextMenuContent
                          entry={entry}
                          targets={targets}
                          entries={flatEntries}
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
                          tags={tagsProp ?? TAG_DEFS}
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
                          onCreateShortcuts={onCreateShortcuts}
                          menuCfg={menuCfg}
                          onCopy={onCopy}
                          onCut={onCut}
                          onRename={onRename}
                          onBatchRename={onBatchRename}
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
                          onNewFolder={onNewFolder}
                          onNewFile={onNewFile}
                        />
                      </ContextMenu>
                    );
                  })}
                  {padBottom > 0 && <div style={{ height: padBottom }} />}
                </>
              );
            })()}
            {rows.length === 0 && (
              <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                {t("此目录为空")}
              </div>
            )}
            {/* 矩形框选 */}
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
        </ContextMenuTrigger>
        <ContextMenuContent
          className="max-h-[var(--radix-context-menu-content-available-height)] min-w-48 overflow-y-auto [scrollbar-width:thin]"
          collisionPadding={10}
        >
          <BlankContextMenuContent
            currentDir={currentDir}
            pluginOpener={pluginOpener}
            pluginTerminal={pluginTerminal}
            showTerminal={pluginTerminal}
            terminalIcon={<TerminalSquare className="mr-2 h-4 w-4" />}
            terminalSeparator
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
            selectionExtras={
              <>
                <ContextMenuItem onClick={() => onShareDir(currentDir)}>
                  <Share2 className="mr-2 h-4 w-4" /> {t("分享此目录…")}
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            }
          />
        </ContextMenuContent>
      </ContextMenu>

      {/* 拖拽拖影：位置由引擎 ghostRef 命令式驱动，内容经状态渲染（同 FileList） */}
      <DragGhost
        ghostRef={ghostRef}
        paths={dragGhostState?.paths ?? []}
        op={dragGhostState?.op ?? "copy"}
        entries={flatEntries}
      />
    </div>
  );
}
