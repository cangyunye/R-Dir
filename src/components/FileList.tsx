import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Link2, Share2, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileEntry, SortDir, SortKey } from "@/lib/types";
import { formatSize, formatTime, hideExtension, extLabel } from "@/lib/format";
import { sortEntries } from "@/lib/entry-sort";
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
import { RenameInput } from "@/components/RenameInput";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TAG_DEFS, tagLabel, type FileTags, type TagDef, type TagNames } from "@/lib/persist";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { OpenerItem, ShellItem, GitToolItem, QuickToolItem } from "@/lib/openerApi";
import { ROW_HEIGHT, visibleRange } from "@/lib/virtual-scroll";
import type { DiffMarkMap } from "@/lib/sync-link";
import { TagDots } from "@/components/TagView";
import { BlankContextMenuContent, EntryContextMenuContent } from "@/components/EntryContextMenu";
import { rank } from "@/lib/fuzzy";
import { isMac } from "@/lib/keymap";
import { isSftpPath, isHttpPath } from "@/lib/sftp-path";
import { dragOutFiles } from "@/lib/api";
import { canNativeDragOut, setNativeDragOut, setHtml5Drag } from "@/lib/native-drag";
import {
  getNameColumnWidth,
  resetNameColumnWidth,
  setNameColumnWidth,
  subscribeNameColumnWidth,
} from "@/lib/columns";
import { QuickJump, type QuickJumpRow } from "@/components/QuickJump";

/** 快速定位结果窗口大小。 */
export const QJ_MAX_ROWS = 200;

/** >QJ_MAX_ROWS 时，结果窗口的起始下标（尽量让 active 居中） */
export function qjWindowStart(total: number, active: number, size = QJ_MAX_ROWS): number {
  if (total <= size) return 0;
  return Math.min(Math.max(0, active - Math.floor(size / 2)), total - size);
}

const COLUMNS: { key: SortKey | null; label: string; width: string }[] = [
  { key: "name", label: "名称", width: "minmax(0, 1fr)" },
  { key: "size", label: "大小", width: "84px" },
  { key: "modified", label: "修改时间", width: "132px" },
  { key: "type", label: "类型", width: "80px" },
  { key: null, label: "权限", width: "88px" },
];

/** 打开方式：只显示用户通过“选择其他应用…”注册的自定义工具。
 * 说明：内置工具与系统默认应用依赖跨平台路径探测（mac .app / win 注册表），
 * 存在大量寻址盲区（如 Edge 实际安装名为 Microsoft Edge.app），误报“未安装”，
 * 故 v0.4 起移除所有内置探测展示，右键“打开”即系统默认方式（可靠），
 * 其余工具由用户自行注册。 */


export interface RenameState {
  path: string;
  name: string;
}

export function FileList({
  paneId,
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
  onRenameTag,
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
  onSort: (key: SortKey) => void;
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
  /** v0.7：右键「分享此目录」 */
  onShareDir: (dir: string) => void;
  onPaste: () => void;
  canPaste: boolean;
  /** 撤销 / 重做（全局操作栈，右键菜单入口） */
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
  onRenameTag: (tagId: string, label: string) => void;
  customQuick: string[];
  onToggleTag: (path: string, tagId: string) => void;
  onToggleQuick: (path: string) => void;
  currentDir: string;
  /** v0.5 插件启用状态（false 时隐藏对应右键入口） */
  pluginOpener: boolean;
  pluginTerminal: boolean;
  /** v0.4 打开方式数据与回调 */
  openers: OpenerItem[];
  shells: ShellItem[];
  /** v0.29.0 右键「用 VSCode 打开」（文件/目录均可；未探测到置灰） */
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
  /** 原生拖拽悬停在本窗格某个目录行上：该行高亮为投放目标（App 的 window dragover 解析） */
  dragDir?: string | null;
  showHidden: boolean;
  /** v0.14 显示文件扩展名（false 时列表隐藏扩展名） */
  showExtensions: boolean;
  /** v0.28 预览栏启用时空格让位给「切换预览」，行内不再用空格切换选中 */
  spaceTogglesPreview?: boolean;
  renaming: RenameState | null;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  isActive: boolean;
  onActivate: () => void;
  /** v0.8 窗口级缩放（0.5–2.0）与 Ctrl+滚轮回调 */
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** v0.8 鼠标侧键：后退 / 前进（button 3 / 4） */
  onBack: () => void;
  onForward: () => void;
  /** v0.8 压缩为 zip / tar / tgz（仅打包） */
  onCompress: (paths: string[], format: "zip" | "tar" | "tgz") => void;
  /** v0.32 解压压缩包：here=智能落点 / folder=归档名文件夹 / choose=自选目录 */
  onExtract: (paths: string[], mode: "here" | "folder" | "choose") => void;
  /** v0.16 右键「属性」：对选中条目显示属性（目录递归统计大小） */
  onProperties: (entries: FileEntry[]) => void;
  /** v0.17 空白处右键「属性（当前目录）」：统计 currentDir，与选中项无关 */
  onPropertiesDir: (dir: string) => void;
  /** v0.18 空白处右键「与另一窗格差异比对…」 */
  onDiff: () => void;
  /** v0.18 空白处右键「同步比对（左右窗格）」：开启/断开链接 */
  onSyncDiff: () => void;
  /** v0.19 文本比较基准（跨窗格共享的全局状态，与应用内剪贴板同模式） */
  compareBase?: { path: string; name: string } | null;
  /** v0.19 右键「设为比较基准」 */
  onSetCompareBase?: (entry: FileEntry, paneId: number) => void;
  /** v0.19 右键「与基准比较」 */
  onCompareWithBase?: (entry: FileEntry) => void;
  /** v0.19 右键「与另一文件比较…」：打开窗格选择器 */
  onComparePick?: (entry: FileEntry) => void;
  /** v0.19 右键「比较所选两个文件」（同目录双选） */
  onCompareSelected?: (paths: [string, string]) => void;
  /** v0.19 右键 .patch/.diff「查看 Diff」 */
  onViewPatch?: (path: string) => void;
  /** v0.18 同步比对行内标注（name → 判定）；仅链接且窗格正处比对层时传入 */
  diffMarks?: DiffMarkMap;
  /** v0.18 同步比对链接标识：该窗格的方位（undefined = 未链接） */
  linkBadge?: LinkSide;
}) {
  const sorted = useMemo(
    () => sortEntries(entries, sortKey, sortDir, showHidden),
    [entries, sortKey, sortDir, showHidden],
  );

  const primary = selection.length > 0 ? selection[0] : null;
  /** Shift 范围选择的锚点 */
  const anchorRef = useRef<string | null>(null);
  // 主选中变化时滚动进可视区（粘贴后定位、搜索结果定位等外部选中）。
  // 只依赖 primary：普通刷新/排序不变时不触发，避免打断用户当前滚动位置。
  useEffect(() => {
    if (!primary) return;
    const el = listScrollRef.current;
    if (!el) return;
    const idx = sorted.findIndex((x) => x.path === primary);
    if (idx < 0) return;
    // 焦点若在行元素上，先收回列表容器，防止随后的滚动把焦点行卸载出虚拟窗口
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== el && el.contains(ae)) el.focus({ preventScroll: true });
    const target = idx * ROW_HEIGHT;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight - ROW_HEIGHT;
    if (target < top) el.scrollTop = target;
    else if (target > bottom) el.scrollTop = target - el.clientHeight + ROW_HEIGHT * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary]);

  // v0.35 新建文件/文件夹后滚动定位：在列表末尾（滚动到底）右键新建时，新条目按
  // 名称排序可能落在视口外——重命名输入框不在虚拟窗口内根本不挂载，用户看不到。
  // 按重命名条目的索引把滚动窗口推过去（与主选中滚动同一套数学）。
  useEffect(() => {
    if (!renaming) return;
    const el = listScrollRef.current;
    if (!el) return;
    const idx = sorted.findIndex((x) => x.path === renaming.path);
    if (idx < 0) return;
    const target = idx * ROW_HEIGHT;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight - ROW_HEIGHT;
    if (target < top) el.scrollTop = target;
    else if (target > bottom) el.scrollTop = target - el.clientHeight + ROW_HEIGHT * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming?.path, sorted]);
  /** 行拖拽的目标集合：已选中项按下时携带全部选中项 */
  const targetsFor = (entry: FileEntry): string[] =>
    propsRef.current.selectionSet.has(entry.path)
      ? propsRef.current.selection
      : [entry.path];

  // ---- 自实现拖拽 + 矩形框选（WKWebView 的 HTML5 DnD 不可靠） ----
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dragCandRef = useRef<{ x: number; y: number; paths: string[] } | null>(null);
  const dragActiveRef = useRef(false);
  const lastTargetRef = useRef<number | null>(null);
  const lastOpRef = useRef<"copy" | "move">("copy");
  const rubberRef = useRef<{
    x0: number;
    y0: number;
    additive: boolean;
    /** true = 从行上按下（未选中项），false = 从空白按下 */
    fromRow: boolean;
  } | null>(null);
  /** 框选激活后抑制随后的 click（避免单行选择覆盖框选结果） */
  const suppressClickRef = useRef(false);
  /** 慢速双击重命名：记录上次单击的条目与时间 */
  const lastClickRef = useRef<{ path: string; time: number } | null>(null);
  /** 列表滚动容器 */
  const listScrollRef = useRef<HTMLDivElement>(null);
  /** v0.8.3 虚拟滚动：固定行高，只渲染可视区 +/- buffer 行（行高见 lib/virtual-scroll） */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400); // 初始给个合理值，避免首帧只渲染前 6 行
  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    hideNameTip();
  };

  // ---- v0.34 名称列宽：拖表头分隔线调整，全局共享（所有窗格一致）、localStorage 持久化 ----
  const nameColW = useSyncExternalStore(subscribeNameColumnWidth, getNameColumnWidth);
  /** 名称列固定像素宽时，最右「权限」列改吃剩余空间，行不再留右侧空白 */
  const gridCols =
    nameColW > 0
      ? `${nameColW}px 84px 132px 80px minmax(88px, 1fr)`
      : COLUMNS.map((c) => c.width).join(" ");
  const colResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const startColResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const headEl = e.currentTarget.parentElement;
    const startW =
      nameColW > 0 ? nameColW : (headEl?.getBoundingClientRect().width ?? 0);
    colResizeRef.current = { startX: e.clientX, startW };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveColResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = colResizeRef.current;
    if (!d) return;
    // clientX 与渲染宽度同处 CSS 缩放后的布局像素系，位移可直接相加
    setNameColumnWidth(d.startW + e.clientX - d.startX);
  };
  const endColResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!colResizeRef.current) return;
    colResizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // ---- v0.34 名称悬停 1 秒的完整名提示：仅当文本被截断时出现，
  //      行内浮层覆盖显示（替代原生 title 的长延迟与全局乱飘） ----
  const [nameTip, setNameTip] = useState<{
    text: string;
    x: number;
    y: number;
    h: number;
  } | null>(null);
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
        if (el.scrollWidth <= el.clientWidth) return; // 未截断不提示
        const r = el.getBoundingClientRect();
        setNameTip({ text, x: r.left, y: r.top, h: r.height });
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
  // 挂载后用 ResizeObserver 校正实际高度
  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 标签重命名对话框（v0.6.4）
  const [renameTagOpen, setRenameTagOpen] = useState(false);
  const [renameTagId, setRenameTagId] = useState<string>("red");
  const [renameTagInput, setRenameTagInput] = useState("");
  // v0.28.0 全量标签（预设 + 自定义）；未下发时回落预设
  const tags = tagsProp ?? TAG_DEFS;
  /** Windows Git Bash：既是 Git 工具也是终端，空白处右键收进「在此处打开终端」组 */
  const gitBash = gitTools.find((t) => t.id === "gitbash");
  const renameTagInputRef = useRef<HTMLInputElement>(null);
  const submitRenameTag = () => {
    const label = renameTagInput.trim();
    if (!label) return;
    onRenameTag(renameTagId, label);
    setRenameTagOpen(false);
  };
  /** v0.10 右键菜单二级折叠组当前展开项（null = 全收起） */
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const toggleMenuGroup = (id: string) =>
    setExpandedMenu((cur) => (cur === id ? null : id));
  /** v0.8 缩放百分比提示（Ctrl+滚轮后显示，1.2s 淡出） */
  const [zoomTip, setZoomTip] = useState<number | null>(null);  const zoomTipTimer = useRef<number | null>(null);
  const showZoomTip = (z: number) => {
    setZoomTip(z);
    if (zoomTipTimer.current) window.clearTimeout(zoomTipTimer.current);
    zoomTipTimer.current = window.setTimeout(() => setZoomTip(null), 1200);
  };
  // ---- v0.24 快速定位浮层（QuickJump）：直接键入开窗，模糊过滤当前目录 ----
  const [qjOpen, setQjOpen] = useState(false);
  const [qjQuery, setQjQuery] = useState("");
  const [qjActive, setQjActive] = useState(0);
  const qjRestoreRef = useRef<string[]>([]);
  /** QJ 会话开关的同步镜像：跟随选中 effect / hover 回调读它做早退。
   *  只看 qjOpen state 不够——hover 改 active 的渲染其 effect 可能被推迟到
   *  取消之后才刷新（React 18 批处理交错），过期闭包里 qjOpen 仍是 true，
   *  会把选中又跟到高亮项上、覆盖 Esc 取消还原的结果。 */
  const qjOpenRef = useRef(false);

  const qjMatches = useMemo(
    () => (qjOpen ? rank(sorted, qjQuery, (e) => e.name) : []),
    [qjOpen, sorted, qjQuery],
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

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (qjOpen) {
      // 浮层打开时按键由浮层内 input 处理；但若 input 失焦（焦点竞态），
      // Esc 会落到这里——按取消语义收口，否则冒泡到全局 esc → 清空选中
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        qjCancel();
      }
      return;
    }
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;
    // 空格不作首字母：它是「选中切换/预览开关」的键，误拉起搜索浮层会与预览冲突
    if (e.key === " ") return;
    const t = e.target as HTMLElement;
    if (t.closest("input,textarea")) return;
    e.preventDefault();
    openQuickJump(e.key);
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

  // 高亮项变化即实时跟随（复用 primary 变化滚动 effect，不另写滚动）
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
  const [rubber, setRubber] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);

  // 选中集合：渲染路径每行都要判断，全选万级条目时 O(n)×行数 的字符串比较换成 Set
  const selectionSet = useMemo(() => new Set(selection), [selection]);

  // 用 ref 保存最新 props，避免监听器闭包拿到过期值
  const propsRef = useRef({
    onDropPaths,
    onDragOverChange,
    onClearSelection,
    onSelectRange,
    onSelect,
    onOpen,
    selection,
    selectionSet,
    paneId,
  });
  propsRef.current = { onDropPaths, onDragOverChange, onClearSelection, onSelectRange, onSelect, onOpen, selection, selectionSet, paneId };

  const cleanupDrag = () => {
    window.removeEventListener("mousemove", onWinMouseMove);
    window.removeEventListener("mouseup", onWinMouseUp);
    document.body.style.userSelect = "";
    dragActiveRef.current = false;
    // dragstart 接管（原生/HTML5 拖拽）时手势可能已画出橡皮筋选框或留下按压候选——
    // 不清掉的话选框滞留整个拖拽过程，下一次空白框选还会被过期 dragCandRef 劫持成幽灵拖拽
    dragCandRef.current = null;
    rubberRef.current = null;
    setRubber(null);
    lastTargetRef.current = null;
    lastOpRef.current = "copy";
    if (ghostRef.current) ghostRef.current.style.opacity = "0";
    propsRef.current.onDragOverChange(null);
  };

  const onWinMouseMove = (e: MouseEvent) => {
    const cand = dragCandRef.current;
    if (cand) {
      const dx = e.clientX - cand.x;
      const dy = e.clientY - cand.y;
      if (Math.hypot(dx, dy) > 5) {
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
        // 目标窗格检测（仅变化时通知，避免高频重渲染）
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const paneEl = el?.closest?.("[data-pane-id]") as HTMLElement | null;
        const targetId = paneEl ? Number(paneEl.dataset.paneId) : null;
        if (targetId !== lastTargetRef.current || op !== lastOpRef.current) {
          lastTargetRef.current = targetId;
          lastOpRef.current = op;
          propsRef.current.onDragOverChange(
            targetId !== null ? { targetPaneId: targetId, op } : null,
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

  const onWinMouseUp = (e: MouseEvent) => {
    const cand = dragCandRef.current;
    if (cand) {
      dragCandRef.current = null;
      const wasActive = dragActiveRef.current;
      if (wasActive) {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const paneEl = el?.closest?.("[data-pane-id]") as HTMLElement | null;
        const targetId = paneEl ? Number(paneEl.dataset.paneId) : null;
        const op = lastOpRef.current;
        cleanupDrag();
        if (targetId !== null && targetId !== propsRef.current.paneId && cand.paths.length > 0) {
          propsRef.current.onDropPaths(propsRef.current.paneId, cand.paths, op, targetId);
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
        // 单击空白 → 取消选择；单击行 → 交给 click 正常选择
        if (!rb.fromRow) propsRef.current.onClearSelection();
        return;
      }
      // 框选已发生，抑制随后的 click（否则单行选择会覆盖框选结果）
      suppressClickRef.current = true;
      const hit: string[] = [];
      containerRef.current?.querySelectorAll<HTMLElement>("[data-path]").forEach((row) => {
        const r = row.getBoundingClientRect();
        const rel = {
          left: r.left - cRect.left,
          top: r.top - cRect.top,
          right: r.right - cRect.left,
          bottom: r.bottom - cRect.top,
        };
        if (rel.right >= rx0 && rel.left <= rx1 && rel.bottom >= ry0 && rel.top <= ry1) {
          const p = row.dataset.path;
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

  const startRowPress = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const fromSelected = propsRef.current.selectionSet.has(entry.path);
    const additive = e.metaKey || e.ctrlKey;
    if (fromSelected) {
      // 从已选中项按下 → 文件拖拽（复制/移动）
      dragCandRef.current = { x: e.clientX, y: e.clientY, paths: targetsFor(entry) };
    } else {
      // 立即选中（无修饰键）：按下即高亮，避免"松开才选中"的延迟感；
      // 随后若拖动框选，会由框选结果覆盖；修饰键/Shift 交给 click 处理，避免双触发
      if (!additive && !e.shiftKey) propsRef.current.onSelect(entry, false);
      // 从未选中项按下 → 框选起点（Windows 资源管理器语义）
      rubberRef.current = {
        x0: e.clientX,
        y0: e.clientY,
        additive: additive || e.shiftKey,
        fromRow: true,
      };
    }
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
      fromRow: false,
    };
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
  };

  return (
    <>
      <Dialog open={renameTagOpen} onOpenChange={setRenameTagOpen}>
        <DialogContent
          className="max-w-sm"
          onOpenAutoFocus={(e) => {
            // 焦点必须落在输入框：裸 autoFocus 会输给 radix 的初始焦点（色块按钮）
            e.preventDefault();
            renameTagInputRef.current?.focus();
            renameTagInputRef.current?.select();
          }}
        >
          <DialogHeader>
            <DialogTitle>重命名标签</DialogTitle>
            <DialogDescription>自定义标签显示名称（不影响已标记的文件）</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-1.5">
            {tags.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setRenameTagId(t.id);
                  setRenameTagInput(tagLabel(t, tagNames));
                }}
                className={cn(
                  "h-5 w-5 rounded-full transition-transform",
                  renameTagId === t.id && "scale-125 ring-2 ring-ring ring-offset-2",
                )}
                style={{ background: t.color }}
                title={tagLabel(t, tagNames)}
              />
            ))}
          </div>
          <Input
            ref={renameTagInputRef}
            value={renameTagInput}
            onChange={(e) => setRenameTagInput(e.target.value)}
            placeholder="标签名称"
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRenameTag();
              if (e.key === "Escape") setRenameTagOpen(false);
            }}
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRenameTagOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={submitRenameTag} disabled={!renameTagInput.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div
        ref={containerRef}
        data-pane-id={paneId}
        style={{ zoom }}
        onWheel={(e) => {
          // v0.8 Ctrl+滚轮：窗口级缩放（与浏览器一致），阻止默认滚动
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
          // v0.24 鼠标侧键：后退(3) / 前进(4)。
          // 改用 mouseup 而非 auxclick——WKWebView（Tauri macOS）对侧键不发 auxclick
          // （auxclick 2024 才 Baseline，旧 WebKit 完全没有），而 mousedown/mouseup
          // 任何引擎都会发；只监听 mouseup 也避免 Chromium 上两者双发导致前进两次。
          if (e.button === 3) {
            e.preventDefault();
            onBack();
          } else if (e.button === 4) {
            e.preventDefault();
            onForward();
          }
        }}
      onMouseDownCapture={(e) => {
        // 地址栏聚焦时：点击窗格空白保持地址栏光标；点击文件/文件夹行才允许移交焦点
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
      {/* v0.21.1 同步比对窗格标识：链接时窗格顶部通栏色条（左=琥珀 / 右=天蓝） */}
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
      {/* v0.24 快速定位玻璃浮层 */}
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
      {/* v0.8 缩放百分比提示：面板中央，1.2s 淡出 */}
      {zoomTip !== null && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-primary/25 bg-background/85 px-4 py-1.5 text-xl font-semibold text-primary shadow-elevate backdrop-blur-sm">
          {Math.round(zoomTip * 100)}%
        </div>
      )}
      {/* v0.34 名称完整名提示：悬停 1 秒且文本被截断时，覆盖显示在名称行上 */}
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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* 表头 */}
      <div
        className="grid shrink-0 items-center border-b bg-background text-xs font-medium text-muted-foreground select-none"
        style={{ gridTemplateColumns: gridCols }}
      >
        {COLUMNS.map((col) => (
          <button
            key={col.label}
            className={cn(
              "relative flex h-7 items-center gap-1 px-2 text-left hover:bg-muted",
              col.key === null && "cursor-default hover:bg-transparent",
            )}
            onClick={() => col.key && onSort(col.key)}
            disabled={col.key === null}
          >
            {col.label}
            {/* v0.34 名称列宽拖动分隔线：按住左右拖调宽，双击恢复自动。
                pointer 事件 stopPropagation 避免触发排序/表头悬停样式误闪 */}
            {col.key === "name" && (
              <div
                data-name-col-resize=""
                title="拖动调整名称列宽（双击恢复自动）"
                className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize after:absolute after:inset-y-1 after:right-0 after:w-px after:bg-border hover:after:w-0.5 hover:after:bg-primary/50"
                onPointerDown={startColResize}
                onPointerMove={moveColResize}
                onPointerUp={endColResize}
                onPointerCancel={endColResize}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  resetNameColumnWidth();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            {/* v0.18 同步比对链接标识（v0.21.1 加大：彩色徽章替代小点） */}
            {col.key === "name" && linkBadge && (
              <span
                className={cn(
                  "ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                  linkBadge === "left"
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    : "bg-sky-500/15 text-sky-700 dark:text-sky-400",
                )}
                title="同步比对已开启：此窗格与另一侧窗格联动导航，右键或工具栏可断开"
              >
                <Link2 className="h-3 w-3" />
                同步·{linkBadge === "left" ? "左" : "右"}
              </span>
            )}
            {col.key &&
              (sortKey === col.key ? (
                sortDir === "asc" ? (
                  <ArrowUp className="h-3 w-3" />
                ) : (
                  <ArrowDown className="h-3 w-3" />
                )
              ) : (
                <ArrowUpDown className="h-3 w-3 opacity-30" />
              ))}
          </button>
        ))}
      </div>

      {/* 行 */}
      <div
        ref={listScrollRef}
        data-filelist-body=""
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto pb-8 outline-none select-none"
        onMouseDown={startRubber}
        onMouseDownCapture={(e) => {
          // 地址栏聚焦时保持光标；点击输入框/文本域不抢焦点；浮层内不抢焦点；否则聚焦列表
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.id === "rdir-addr-input") return;
          if ((e.target as HTMLElement).closest("input,textarea,[data-quickjump]")) return;
          listScrollRef.current?.focus({ preventScroll: true });
        }}
        onKeyDown={handleListKeyDown}
        onScroll={onListScroll}
      >
        {dragTarget && (
          // pointer-events-none + -mb-6：纯展示浮层，不占流式高度、不参与命中测试——进入窗格时内容不在光标下整体下移，
          // 目录行成为投放目标后，提示条若推挤内容会把瞄准的落点顶到相邻行上误投
          <div className="pointer-events-none -mb-6 sticky top-0 z-10 flex h-6 items-center justify-center bg-primary/10 text-[11px] font-medium text-primary">
            {dragOp === "copy" ? `复制到此处（按住 ${isMac ? "Option" : "Alt"} 切换移动）` : "移动到此处"}
          </div>
        )}
        {/* v0.8.3 虚拟滚动：只渲染可视区 +/- buffer 行 */}
        {(() => {
          const { start, end, padTop, padBottom } = visibleRange(sorted.length, scrollTop, viewportH);
          return (
            <>
              {padTop > 0 && <div style={{ height: padTop }} />}
              {sorted.slice(start, end).map((entry) => {
          const selected = selectionSet.has(entry.path);
          const isPrimary = primary === entry.path;
          const isRenaming = renaming?.path === entry.path;
          const mark = diffMarks?.[entry.name];
          const targets = selectionSet.has(entry.path) ? selection : [entry.path];
          return (
            <ContextMenu
              key={entry.path}
              onOpenChange={(o) => {
                if (!o) setExpandedMenu(null);
              }}
            >
              <ContextMenuTrigger asChild>
                <div
                  role="row"
                  tabIndex={0}
                  data-path={entry.path}
                  data-drop-dir={entry.is_dir ? "" : undefined}
                  draggable="true"
                  onDragStart={(e) => {
                    const paths = selectionSet.has(entry.path) ? selection : [entry.path];
                    // 原生拖出仅支持真实文件系统路径；sftp://、http:// 等虚拟路径走 HTML5 文本拖拽
                    // （应用内投放两条链路都由 App 的 window 监听完成，目标窗格类型无关）
                    const canNative =
                      canNativeDragOut() && paths.every((p) => !isSftpPath(p) && !isHttpPath(p));
                    if (canNative) {
                      // Windows 原生拖出（OLE 拖拽携带 CF_HDROP 文件引用）：浏览器上传
                      // 投放区 / 资源管理器只认真实文件，HTML5 的 text/uri-list 文本
                      // 格式一律被拒。preventDefault 后 HTML5 拖拽不会发生，拖回落到
                      // 本窗口的 dragover/drop 由 App 的 window 监听按 nativeDragOut 会话驱动
                      console.info("[rdir] drag-out: 原生 CF_HDROP 拖拽", paths.length, "项");
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
                      // v0.34 Windows 原生拖放接管（dragDropEnabled）后，wry 替换了 WebView2 的
                      // IDropTarget，HTML5 文本拖拽的投放不再到达页面：sftp/http 等虚拟路径
                      // 无法 CF_HDROP 原生拖出，改走自研鼠标拖拽（窗格级投放 + 提示条，Alt=移动）。
                      // 阻止 HTML5 拖拽；从未选中行拖动时 startRowPress 开的是框选，这里升级为拖拽候选
                      console.info("[rdir] drag-out: 虚拟路径走应用内鼠标拖拽", paths.length, "项");
                      e.preventDefault();
                      rubberRef.current = null;
                      setRubber(null);
                      dragCandRef.current = { x: e.clientX, y: e.clientY, paths };
                      return;
                    }
                    console.info("[rdir] drag-out: HTML5 文本拖拽（原生拖出不可用）");
                    // macOS / 非 Tauri 环境：HTML5 拖出（WKWebView 把 file:// uri-list 映射为 NSURL）
                    // 选中文本为空时拖当前项，否则拖选中项
                    const uriList = paths.map(p => 'file://' + p.replace(/\\/g, '/')).join('\r\n');
                    e.dataTransfer.setData('text/uri-list', uriList);
                    e.dataTransfer.setData('text/plain', paths.join('\n'));
                    // v0.22.2 应用内拖拽标记：window 的 dragover 据此开投放光标/提示条，
                    // drop 据此拿源窗格 id（types 全程可读；值在 drop 阶段才可读）
                    e.dataTransfer.setData('application/x-rdir-dnd', String(paneId));
                    e.dataTransfer.effectAllowed = 'copyMove';
                    setHtml5Drag({ sourcePaneId: paneId, paths });
                    // 原生拖拽接管后 mousemove/mouseup 停发——必须停掉自研鼠标拖拽，
                    // 否则提示条滞留到松手后、下一次点击的 mouseup 误触发一次投放
                    cleanupDrag();
                  }}
                  onMouseDown={(e) => startRowPress(e, entry)}
                  onClick={(e) => {
                    // 框选刚结束，抑制随后的 click，避免单行选择覆盖框选结果
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    // 慢速双击（Finder 风格）：两次独立单击同一条目、间隔 >450ms → 重命名
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
                      const anchorIdx = anchor ? sorted.findIndex((x) => x.path === anchor) : -1;
                      const clickIdx = sorted.findIndex((x) => x.path === entry.path);
                      if (anchorIdx >= 0 && clickIdx >= 0 && anchorIdx !== clickIdx) {
                        const [lo, hi] =
                          anchorIdx < clickIdx ? [anchorIdx, clickIdx] : [clickIdx, anchorIdx];
                        onSelectRange(sorted.slice(lo, hi + 1).map((x) => x.path));
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
                      // 行内已打开目标条目；放行会冒泡到全局 keymap「open」再开一次
                      // （本地文件被外部程序打开两次 / SFTP 文件双重下载）
                      e.stopPropagation();
                      onOpen(entry);
                    }
                    if (e.key === " ") {
                      // v0.28 预览栏启用时空格归「切换预览」（App 全局分发），行内放行
                      if (spaceTogglesPreview) return;
                      // 预览未启用时行内语义是切换选中；阻断冒泡，
                      // 否则全局 togglePreview 会弹「预览栏未开启」错误提示
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(entry, e.metaKey || e.ctrlKey);
                    }
                  }}
                  className={cn(
                    "grid cursor-default items-center border-b text-[13px]",
                    selected ? "bg-selected" : "hover:bg-muted",
                    isPrimary && "ring-1 ring-inset ring-primary/40",
                    entry.is_dir &&
                      dragDir === entry.path &&
                      "bg-primary/15 ring-2 ring-inset ring-primary",
                  )}
                  style={{
                    gridTemplateColumns: gridCols,
                    height: ROW_HEIGHT,
                  }}
                >
                  <div className="relative flex min-w-0 items-center gap-2 px-2 py-1">
                    {mark && (
                      <span
                        data-diff-mark={mark.status}
                        className="absolute inset-y-0 left-0 w-[3px]"
                        style={{ background: markColor(mark) }}
                        title={markTooltip(mark)}
                      />
                    )}
                    <FileIcon entry={entry} size={16} className="shrink-0" />
                    <TagDots path={entry.path} fileTags={fileTags} tags={tags} />
                    {isRenaming ? (
                      <RenameInput
                        initial={renaming.name}
                        onCommit={(name) => onRenameCommit(entry.path, name)}
                        onCancel={onRenameCancel}
                      />
                    ) : (
                      <span
                        className={cn(
                          "truncate",
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
                  </div>
                  <div className="px-2 text-right tabular-nums text-muted-foreground">
                    {entry.is_dir ? "—" : formatSize(entry.size)}
                  </div>
                  <div className="px-2 tabular-nums text-muted-foreground">
                    {formatTime(entry.modified)}
                  </div>
                  <div className="px-2 text-muted-foreground">{extLabel(entry)}</div>
                  <div className="px-2 font-mono text-xs text-muted-foreground">
                    {entry.permissions}
                  </div>
                </div>
              </ContextMenuTrigger>
              <EntryContextMenuContent
                entry={entry}
                targets={targets}
                entries={entries}
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
                tags={tags}
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
              {padBottom > 0 && <div style={{ height: padBottom }} />}
            </>
          );
        })()}
        {sorted.length === 0 && (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
            此目录为空
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

      {/* 拖拽幽灵标签（常驻 DOM，拖动时显示） */}
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
            selectionExtras={<>
              <ContextMenuItem onClick={() => onShareDir(currentDir)}>
                <Share2 className="mr-2 h-4 w-4" /> 分享此目录…
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>}
          />
        </ContextMenuContent>
      </ContextMenu>
    </div>
    </>
  );
}
