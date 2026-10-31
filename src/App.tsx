import { Activity, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getName, getVersion } from "@tauri-apps/api/app";
import {
  open as openDialog,
} from "@tauri-apps/plugin-dialog";
import {
  listOpeners as apiListOpeners,
  listPlugins as apiListPlugins,
  setPluginEnabled as apiSetPluginEnabled,
  httpDownloadTo,
  cancelHttpDownload,
  openWith as apiOpenWith,
  addCustomOpener as apiAddCustomOpener,
  removeCustomOpener as apiRemoveCustomOpener,
  setOpenerExtensions as apiSetOpenerExtensions,
  listShells as apiListShells,
  openTerminal as apiOpenTerminal,
  vscodeDetected as apiVscodeDetected,
  openVscode as apiOpenVscode,
  listGitTools as apiListGitTools,
  openGitTool as apiOpenGitTool,
  listQuickTools as apiListQuickTools,
  addQuickTool as apiAddQuickTool,
  removeQuickTool as apiRemoveQuickTool,
  moveQuickTool as apiMoveQuickTool,
  setQuickToolArgs as apiSetQuickToolArgs,
  openQuickTool as apiOpenQuickTool,
  detectEditors as apiDetectEditors,
  type OpenerItem,
  type PluginInfo,
  type ShellItem,
  type GitToolItem,
  type QuickToolItem,
  type EditorCandidate,
} from "@/lib/openerApi";
import type {
  ClipboardState,
  DiffEntry,
  FileEntry,
  PaneNode,
  PaneState,
  QuickAccessItem,
  ResolutionPlan,
  SessionLayout,
  SessionTab,
  SortDir,
  SortKey,
  SplitDir,
  TabFavorite,
  TabState,
  ThemeMode,
  TransferConflict,
  TransferProgress,
  VolumeInfo,
} from "@/lib/types";
import { dedupeName } from "@/lib/favorites";
import { parseSftpAuthority, isSftpPath, isHttpPath } from "@/lib/sftp-path";
import { backendCaps, backendKind, maxDiffLevelFor, pathScheme } from "@/lib/backends";
import {
  computeAlignment,
  marksFromOutcome,
  mirrorPath,
  relOf,
  type DiffMarkMap,
  type LinkSide,
  type SyncLink,
} from "@/lib/sync-link";
import { useSftp } from "@/hooks/useSftp";
import { useModalLayer } from "@/hooks/useModalLayer";
import { isTopModalLayer } from "@/lib/modal-stack";
import {
  cancelDiff,
  copyEntries,
  copyEntriesPlan,
  createDir,
  createFile,
  deleteEntries,
  diffDirs,
  getHomeDir,
  getQuickAccess,
  getVolumes,
  listDir,
  moveEntries,
  moveEntriesPlan,
  queryModifiers,
  scanConflicts,
  scanDirDuplicates,
  type DirDuplicate,
  clipboardWriteFiles,
  clipboardReadFiles,
  clipboardClearFiles,
  parentDir,
  permanentDeleteEntries,
  restoreFromTrash,
  cancelTransfer,
  fsWatchSet,
  remoteTempInfo,
  renameEntry,
  resolvePath,
  sftpConnect,
  sftpCreateFile,
  sftpDelete,
  sftpDownload,
  sftpDownloadTo,
  sftpMkdir,
  sftpRename,
  sftpUpload,
  sessionLoad,
  sessionSave,
  sessionClear,
  favoritesLoad,
  favoritesSave,
  allowExit,
  statPath,
  iconPositionsLoad,
  iconPositionsSave,
  statEntry,
  compressItems,
  extractArchive,
} from "@/lib/api";
import { isArchiveExt } from "@/lib/filekind";
import { ConnectDialog } from "@/components/ConnectDialog";
import { PasswordDialog } from "@/components/PasswordDialog";
import type { SectionId as SettingsSectionId } from "@/components/SettingsDialog";
import { ConflictDialog } from "@/components/ConflictDialog";
import { AppConfirmDialog, type AppConfirmRequest } from "@/components/AppConfirmDialog";
import { MasterKeyDialog } from "@/components/MasterKeyDialog";
import { basename, formatSize, isAbsolutePath } from "@/lib/format";
import { normalizeExts } from "@/lib/openers";
import {
  collectPaneIds,
  firstPaneId,
  isSinglePane,
  makeSplit,
  removePane,
  replacePane,
  resetRatios,
  setSplitRatio,
  swapPanes,
} from "@/lib/paneTree";
import { ACTIONS, bindingOf, findAction, isMac, keyEventString } from "@/lib/keymap";
import { loadLanguage, type Language } from "@/lib/i18n";
import { LanguageProvider } from "@/lib/LanguageProvider";
import { serializeSession, serializeSessionTab, sessionSignature } from "@/lib/session";
import { getNativeDragOut, probeNativeDragOut, setNativeDragOut, getHtml5Drag, setHtml5Drag, canNativeDragOut } from "@/lib/native-drag";
import { dropTargetAt, type DropTarget } from "@/lib/drop-target";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fetchLatestRelease, DOCS_URL, REPO_URL } from "@/lib/update";
import {
  loadCustomQuick,
  loadFileTags,
  parentOf,
  saveCustomQuick,
  saveFileTags,
  tagById,
  tagLabel,
  loadTagNames,
  saveTagNames,
  TAG_DEFS,
  allTags,
  loadCustomTags,
  saveCustomTags,
  MAX_TAGS,
  MAX_QUICK,
  loadUiFontSize,
  saveUiFontSize,
  uiFontZoom,
  loadUiFontFamily,
  saveUiFontFamily,
  uiFontFamilyStack,
  UI_FONT_FAMILIES,
  loadShowExtensions,
  saveShowExtensions,
  loadDiffCaseSensitive,
  loadDiffMtimeTolerance,
  loadPrefsFromDisk,
  mergeDiskPrefs,
  flushPrefsToDisk,
  remapPrefixedPath,
  loadEntryAliases,
  saveEntryAliases,
  loadRemoteTempDir,
  saveRemoteTempDir,
  entryDisplayName,
  type EntryAliases,
  type FileTags,
  type TagDef,
  type TagNames,
} from "@/lib/persist";
import { shareStopByDir, shareList, type IconPositionMap } from "@/lib/api";
import { loadAutoArrangeDirs, saveAutoArrangeDirs } from "@/lib/persist";
import { type IconSize, type ViewMode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { AlertCircle, Bird } from "lucide-react";
import { cn } from "@/lib/utils";
import { PaneListMenu } from "@/components/PaneListMenu";
import { PropertiesDialog } from "@/components/PropertiesDialog";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { DiffDialog } from "@/components/DiffDialog";
import { TextDiffDialog, type TextDiffSource } from "@/components/TextDiffDialog";
import { ComparePickDialog, type ComparePickPane } from "@/components/ComparePickDialog";
import { GitDiffDialog } from "@/components/GitDiffDialog";
import { SyncDiffModal } from "@/components/SyncDiffPanel";
import { AppMenu } from "@/components/AppMenu";
import { CommandPalette, type CommandItem } from "@/components/CommandPalette";
import { FavoritesPalette } from "@/components/FavoritesPalette";
import { PreviewDrawer } from "@/components/PreviewDrawer";
import { BrowseMode } from "@/components/BrowseMode";
import { sortEntries } from "@/lib/entry-sort";
import { isPreviewable } from "@/lib/preview";
import {
  loadPreviewPrefs,
  savePreviewPrefs,
  type PreviewPrefs,
} from "@/lib/persist";

/** 虚拟标签目录：tags://<tagId>（地址栏可直接输入） */
const VIRTUAL_TAG_RE = /^tags:\/\/([a-z0-9_-]+)$/;

/** 非活动标签 keep-alive 上限（LRU）：超出后最久未激活的标签树卸载，退回「激活时重建」 */
const KEEP_ALIVE_MAX = 8;

/** 恢复时把旧 paneId 重映射到本次新分配的 id（分屏树原样保留比例/方向） */
function remapNode(node: PaneNode, remap: Map<number, number>): PaneNode {
  if (node.type === "pane") {
    const nid = remap.get(node.paneId);
    return nid !== undefined ? { type: "pane", paneId: nid } : node;
  }
  return { ...node, a: remapNode(node.a, remap), b: remapNode(node.b, remap) };
}

/** SessionTab 快照 → 新 TabState（重新分配 tab/pane id，分屏树重映射；
 *  同时收集需要重连的 SFTP 窗格。会话恢复与「打开收藏」共用。） */
function buildTabFromSnapshot(st: SessionTab): {
  tab: TabState;
  sftpPanes: { paneId: number; serverId: string; path: string }[];
} {
  const remap = new Map<number, number>();
  const panes: Record<number, PaneState> = {};
  const tabId = nextTabId++;
  const sftpPanes: { paneId: number; serverId: string; path: string }[] = [];
  for (const sp of st.panes) {
    const p = makePane(sp.path);
    if (typeof sp.zoom === "number" && sp.zoom >= 0.5 && sp.zoom <= 2) p.zoom = sp.zoom;
    // v0.27 视图模式与图标档位（旧会话缺省 details/64；越界值回默认）
    if (sp.viewMode === "icons" || sp.viewMode === "details") {
      p.viewMode = sp.viewMode;
    }
    // 画廊 v0.27 暂不开放：旧会话里的 gallery 归化为 icons（代码保留，放开即用）
    if (sp.viewMode === "gallery") p.viewMode = "icons";
    if ([48, 64, 96, 128].includes(sp.iconSize as 48)) {
      p.iconSize = sp.iconSize as PaneState["iconSize"];
    }
    remap.set(sp.id, p.id);
    if (sp.kind === "tag" && sp.tagId) p.tagId = sp.tagId;
    if (sp.kind === "sftp" && sp.serverId) {
      sftpPanes.push({ paneId: p.id, serverId: sp.serverId, path: sp.path });
    }
    panes[p.id] = p;
  }
  const root = remapNode(st.root as PaneNode, remap);
  const activePane = remap.get(st.activePane) ?? firstPaneId(root);
  return {
    tab: {
      id: tabId,
      title: st.title || "",
      customTitle: st.customTitle,
      root,
      activePane,
      panes,
    },
    sftpPanes,
  };
}

function tagTitle(tagId: string, names?: TagNames): string {
  const def = tagById(tagId);
  const n = names ?? loadTagNames();
  return `标签：${def ? tagLabel(def, n) : tagId}`;
}
import { TabBar } from "@/components/TabBar";
import { Toolbar } from "@/components/Toolbar";
import { Sidebar } from "@/components/Sidebar";
import {
  SplitView,
  PANE_SWAP_DND_TYPE,
  type PaneHandlers,
  type PaneSwapDrag,
} from "@/components/SplitView";
import { SearchPanel } from "@/components/SearchPanel";
import { StatusBar } from "@/components/StatusBar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { SharePanel } from "@/components/SharePanel";

let nextTabId = 1;
let nextPaneId = 1;
let nextSplitId = 1;

/** 可撤销/重做的文件操作记录（只记录可安全反向的操作；永久删除与 SFTP 删除不记录） */
type FileOp =
  | {
      kind: "copy";
      src: string[];
      created: string[];
      dest: string;
      srcPane: number;
      destPane: number;
    }
  | {
      kind: "move";
      pairs: [string, string][];
      dest: string;
      srcPane: number;
      destPane: number;
    }
  | { kind: "rename"; oldPath: string; newPath: string; paneId: number }
  | { kind: "create"; path: string; isDir: boolean; paneId: number }
  /** 回收站删除：撤销 = restore_from_trash，重做 = 再删一次 */
  | { kind: "delete"; paths: string[]; paneId: number };

function makePane(path: string): PaneState {
  return {
    id: nextPaneId++,
    path,
    title: basename(path),
    history: [path],
    histIndex: 0,
    entries: [],
    loading: true,
    error: null,
    sortKey: "name",
    sortDir: "asc",
    zoom: 1,
    viewMode: "details",
    iconSize: 64,
    selection: [],
    refreshKey: 0,
  };
}

function makeTab(path: string): TabState {
  const pane = makePane(path);
  return {
    id: nextTabId++,
    title: pane.title,
    root: { type: "pane", paneId: pane.id },
    activePane: pane.id,
    panes: { [pane.id]: pane },
  };
}

/** 计算父目录（前端轻量实现，兼容 / 与 \） */
function parentPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return path;
  return path.slice(0, idx);
}

/** 远程协议路径（sftp / http）：交给本地应用前需先取回本地副本（v0.37） */
function isRemoteSchemePath(path: string): boolean {
  return (
    path.startsWith("sftp://") ||
    path.startsWith("http://") ||
    path.startsWith("https://")
  );
}

export default function App() {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeId, setActiveId] = useState<number>(0);
  /** v0.22.1（方案B）：保留挂载的标签树（含活动标签，最近激活优先）。
   *  切换标签用 React <Activity> 隐藏而非卸载——不重建虚拟列表行/每行右键菜单子树，
   *  sorted 等 useMemo 与滚动状态全部保留；超 KEEP_ALIVE_MAX 淘汰最旧（配合方案A
   *  的 loadedPaneKey，淘汰后再次激活仍不重读目录，只付一次挂载成本）。 */
  const [keptTabIds, setKeptTabIds] = useState<number[]>([]);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [quickAccess, setQuickAccess] = useState<QuickAccessItem[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 搜索面板冻结的目标窗格 id（打开时锁定，切换窗格不再自动重搜） */
  const [searchPaneId, setSearchPaneId] = useState<number | null>(null);
  /** 标签收藏（favorites.json，独立于退出会话保存）：数据 + 面板开关 */
  const [favorites, setFavorites] = useState<TabFavorite[]>([]);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [homePath, setHomePath] = useState("");
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  /** 同名冲突裁决：非空时显示 ConflictDialog，resolve 存 ref 供异步等待 */
  const [conflictReq, setConflictReq] = useState<TransferConflict[] | null>(null);
  /** v0.32 解压加密压缩包的密码框请求：onSubmit 就地重试，resolve(true)=已解压成功 / false=放弃 */
  const [extractPw, setExtractPw] = useState<{
    name: string;
    archivePath: string;
    targetDir: string;
    paneId: number;
    wrong: boolean;
    resolve: (ok: boolean) => void;
  } | null>(null);
  /** v0.28.0 应用内确认框（替代原生 confirm：Windows 原生是经典样式弹窗） */
  const [appConfirmReq, setAppConfirmReq] = useState<AppConfirmRequest | null>(null);
  /** 确认框裁决：confirm = 确认按钮、alt = 可选第三按钮（altLabel）、cancel = 取消/Esc/点遮罩 */
  const appConfirmResolver = useRef<((v: "confirm" | "cancel" | "alt") => void) | null>(null);
  const appConfirmChoice = useCallback(
    (req: AppConfirmRequest) =>
      new Promise<"confirm" | "cancel" | "alt">((resolve) => {
        appConfirmResolver.current = resolve;
        setAppConfirmReq(req);
      }),
    [],
  );
  /** 布尔收敛版（绝大多数调用方只有确定/取消两种结果） */
  const appConfirm = useCallback(
    async (req: AppConfirmRequest) => (await appConfirmChoice(req)) === "confirm",
    [appConfirmChoice],
  );
  const settleAppConfirm = useCallback((v: "confirm" | "cancel" | "alt") => {
    setAppConfirmReq(null);
    const resolve = appConfirmResolver.current;
    appConfirmResolver.current = null;
    resolve?.(v);
  }, []);
  const conflictResolver = useRef<((plan: ResolutionPlan | null) => void) | null>(null);
  const [renaming, setRenaming] = useState<{
    paneId: number;
    path: string;
    name: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** v0.14 复制/剪切成功后的中央提示（约 1 秒内消失）；v0.31.1 起同一浮层承载 error 变体 */
  const [clipboardTip, setClipboardTip] = useState<{
    text: string;
    tick: number;
    variant?: "info" | "error";
  } | null>(null);
  const clipboardTipTimer = useRef<number | null>(null);
  const flashClipboardTip = useCallback((text: string, ms = 900) => {
    setClipboardTip({ text, tick: Date.now(), variant: "info" });
    if (clipboardTipTimer.current) window.clearTimeout(clipboardTipTimer.current);
    clipboardTipTimer.current = window.setTimeout(() => setClipboardTip(null), ms);
  }, []);
  /** 传输/覆盖失败的中央红色提示：与「已复制 / 已剪切」同位同款，不再只靠状态栏一行小字 */
  const flashErrorTip = useCallback((text: string, ms = 3600) => {
    setClipboardTip({ text, tick: Date.now(), variant: "error" });
    if (clipboardTipTimer.current) window.clearTimeout(clipboardTipTimer.current);
    clipboardTipTimer.current = window.setTimeout(() => setClipboardTip(null), ms);
  }, []);
  /** 拖拽悬停目标窗格（自实现 DnD）。仅跨窗格的窗格级目标亮提示条；
   *  悬停在目录条目上改由 dragDir 高亮那个条目（更精确，提示条不再常驻源窗格）。 */
  const [dragOver, setDragOver] = useState<{
    targetPaneId: number;
    op: "copy" | "move";
  } | null>(null);
  /** 拖拽悬停的目录条目（详情列表目录行 / 大图标文件夹图标）：投放 = 移入/复制进该目录 */
  const [dragDir, setDragDir] = useState<{ paneId: number; path: string } | null>(null);
  /** v0.30 窗格交换拖拽会话（拖窗格头到另一窗格互换布局位置）：
   *  source=拖动中的窗格，target=悬停目标（驱动 SplitView 的高亮/徽标） */
  const [paneSwap, setPaneSwap] = useState<PaneSwapDrag | null>(null);
  /** 撤销 / 重做栈 */
  const [undoStack, setUndoStack] = useState<FileOp[]>([]);
  const [redoStack, setRedoStack] = useState<FileOp[]>([]);
  /** 搜索面板外部命令（快捷键 Ctrl+F / Ctrl+Shift+F） */
  const [searchCmd, setSearchCmd] = useState<{ tab: "name" | "content"; tick: number } | null>(
    null,
  );
  /** 地址栏聚焦信号（Ctrl+L / ⌘+L） */
  const [addressFocusTick, setAddressFocusTick] = useState(0);
  /** 属性栏显隐（Alt+Enter / ⌘+I） */
  const [showProperties, setShowProperties] = useState(true);
  /** v0.28 预览栏（右侧拉门）：开关/展开/宽度（rfm.preview 持久化，默认关） */
  const [previewPrefs, setPreviewPrefs] = useState<PreviewPrefs>(() => loadPreviewPrefs());
  /** v0.28 图文浏览模式（沉浸覆盖内容区） */
  const [browseOpen, setBrowseOpen] = useState(false);
  const updatePreviewPrefs = useCallback((patch: Partial<PreviewPrefs>) => {
    setPreviewPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePreviewPrefs(next);
      return next;
    });
  }, []);
  /** 设置 / 快捷键一览对话框 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  // v0.29.0 设置分区跳转：非 null 时打开设置并滚动到该分区（常用条「＋」入口）
  const [settingsJump, setSettingsJump] = useState<SettingsSectionId | null>(null);
  const openQuickToolsSettings = useCallback(() => {
    setSettingsJump("quickTools");
    setSettingsOpen(true);
  }, []);
  /** 应用名 / 版本：Tauri 运行时识别（Windows 任务栏与应用内一致，均为 productName） */
  const [appName, setAppName] = useState("R-Dir");
  const [appVersion, setAppVersion] = useState("");
  /** v0.7 分享：创建弹窗（右键分享此目录） */
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareDir, setShareDir] = useState("");
  /** v0.7 分享：管理面板（状态栏按钮） */
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  /** share://changed 事件版本号，驱动面板刷新 */
  const [shareVer, setShareVer] = useState(0);
  /** 主题模式（浅色/深色/跟随系统；持久化到 localStorage "rfm.theme"，
   *  旧数据只有 "light"/"dark"，自动兼容；"system" 随系统深浅色实时切换） */
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const v = localStorage.getItem("rfm.theme");
      return v === "dark" || v === "light" || v === "system" ? v : "light";
    } catch {
      return "light";
    }
  });
  /** 生效深色（system 模式下随 matchMedia 实时变；界面/菜单继续消费 dark） */
  const [dark, setDark] = useState<boolean>(() =>
    themeMode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : themeMode === "dark",
  );
  /** v0.38 界面语言（zh 默认 / en；持久化 localStorage "rfm.language"，切换即时生效无需重启） */
  const [language, setLanguage] = useState<Language>(() => loadLanguage());
  /** 快捷键配置版本号：自定义键位变更时 +1，触发菜单/设置重渲染 */
  const [keymapVer, setKeymapVer] = useState(0);
  /** v0.8 界面字体大小（13px=100%，作用于整个界面，根缩放） */
  const [uiFontSize, setUiFontSize] = useState<number>(() => loadUiFontSize());
  /** v0.8.1 字体族 */
  const [uiFontFamily, setUiFontFamily] = useState<string>(() => loadUiFontFamily());
  /** v0.37 远程打开临时目录（空串 = 后端默认 <系统临时目录>/r-dir-remote） */
  const [remoteTempDir, setRemoteTempDir] = useState<string>(() => loadRemoteTempDir());
  /** v0.8.5 开屏飞鸟：React mount 后短暂显示，800ms 后淡出 */
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  /** 退出询问：拦截窗口关闭，询问是否保存会话布局（v0.3.0） */
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  /** v0.20 命令面板（Ctrl+K / Ctrl+Shift+P） */
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 界面字体：13px=100%，根元素 zoom 整体缩放（与窗口级 Ctrl+滚轮缩放相乘叠加）
  useEffect(() => {
    const z = uiFontZoom(uiFontSize);
    document.documentElement.style.zoom = String(z);
    // 供 portal（右键菜单）做 zoom 反向补偿，修正 Floating UI 定位偏移
    document.documentElement.style.setProperty("--rdir-zoom", String(z));
    document.documentElement.style.fontFamily = uiFontFamilyStack(uiFontFamily);
  }, [uiFontSize, uiFontFamily]);
  // v0.8.5 开屏飞鸟：mount 后 600ms 开始淡出，1000ms 后完全卸载
  useEffect(() => {
    const t1 = setTimeout(() => setSplashFading(true), 600);
    const t2 = setTimeout(() => setSplashVisible(false), 1100);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  /** 最新 tabs/activeId（退出保存用，避免闭包过期） */
  const tabsRef = useRef<TabState[]>([]);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // ==================== 传输/复制进度（本地 + SFTP） ====================
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  /** 传输进行中标记（ref 供同步比对管线同步读取）：传输期间挂起实时比对，
   *  结束后由 syncKick 统一补一轮，避免上传/下载过程中面板反复闪「比对中…」 */
  const transferRef = useRef<TransferProgress | null>(null);
  transferRef.current = transfer;
  const [syncKick, setSyncKick] = useState(0);

  
  // v0.7 分享事件：创建/到期/停止 → 刷新管理面板
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("share://changed", () => {
      setShareVer((v) => v + 1);
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, []);

  // v0.27 磁盘/卷热插拔：后端监视 /Volumes，挂载/卸载/推出后推送最新列表，
  // 侧边栏即时刷新，无需重启（此前仅在启动时读取一次）。
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    void listen<VolumeInfo[]>("volumes://changed", (e) => {
      if (!disposed) setVolumes(e.payload);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // v0.26.1 打开目录内容监视：把所有标签里本地窗格的当前目录全量上报后端（fs_watch_set），
  // 后台轮询发现「程序外新增/删除/改名」即推送 fs://changed，这里把对应窗格 refreshKey +1
  // 触发重读。对 keep-alive 的非活动标签同样生效（激活时按 key 失配自动重读），修掉
  // 「外部改了文件、已打开窗体不刷新 / 切回旧标签还显示旧列表」。sftp/http/tags 非本地后端不监视。
  // 上报键取集合的稳定字符串：选中/排序等 tabs 更新不改变集合时不重发 IPC。
  const watchDirsKey = useMemo(() => {
    const set = new Set<string>();
    for (const t of tabs)
      for (const p of Object.values(t.panes))
        if (backendKind(p.path) === "local") set.add(p.path);
    return [...set].sort().join("\u{1}");
  }, [tabs]);
  useEffect(() => {
    void fsWatchSet(watchDirsKey ? watchDirsKey.split("\u{1}") : []);
  }, [watchDirsKey]);
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    void listen<string[]>("fs://changed", (e) => {
      if (disposed || !e.payload?.length) return;
      const dirs = new Set(e.payload);
      setTabs((ts) =>
        ts.map((t) => {
          let hit = false;
          const panes = Object.fromEntries(
            Object.entries(t.panes).map(([id, pane]) => {
              if (!dirs.has(pane.path)) return [id, pane];
              hit = true;
              return [id, { ...pane, refreshKey: pane.refreshKey + 1 }];
            }),
          );
          return hit ? { ...t, panes } : t;
        }),
      );
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

useEffect(() => {
    let disposed = false;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    const un = listen<TransferProgress>("transfer-progress", (e) => {
      if (disposed) return;
      setTransfer(e.payload);
      if (e.payload.done && !doneTimer) {
        doneTimer = setTimeout(() => {
          setTransfer(null);
          doneTimer = null;
          // 传输期间被挂起的同步比对在此统一补一轮（比对管线见 syncKick 依赖）
          setSyncKick((k) => k + 1);
        }, 1500);
      }
    });
    return () => {
      disposed = true;
      if (doneTimer) clearTimeout(doneTimer);
      un.then((f) => f());
    };
  }, []);

  /** 解析 sftp://user@host:port 的 authority */

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activePane = activeTab?.panes[activeTab.activePane] ?? null;

  // ---- v0.28 预览栏 / 图文浏览模式：内容跟随焦点窗格的选中项 ----
  /** 预览目标 = 焦点窗格主选中对应的条目（目录/列表刷新窗口期缺失 → 占位提示） */
  const previewEntry: FileEntry | null = useMemo(() => {
    const sel = activePane?.selection;
    if (!sel || sel.length === 0) return null;
    const e = activePane?.entries.find((x) => x.path === sel[0]);
    return e && !e.is_dir ? e : null;
  }, [activePane?.selection, activePane?.entries]);
  /** 浏览模式清单 = 焦点窗格条目按列表同序排序后过滤可预览类型 */
  const browseList = useMemo(() => {
    if (!activePane) return [];
    return sortEntries(activePane.entries, activePane.sortKey, activePane.sortDir, showHidden).filter(
      isPreviewable,
    );
  }, [activePane?.entries, activePane?.sortKey, activePane?.sortDir, showHidden]);

  /** 搜索面板冻结的窗格（被关闭时回落到活动窗格） */
  const searchPane = (() => {
    if (searchPaneId === null) return activePane;
    for (const t of tabs) {
      const p = t.panes[searchPaneId];
      if (p) return p;
    }
    return activePane;
  })();
  /** 所有窗格（跨标签），供路径栏右侧「已连接窗格」下拉 */
  const paneList = (() => {
    const out: {
      tabId: number;
      paneId: number;
      title: string;
      path: string;
      active: boolean;
    }[] = [];
    for (const t of tabs) {
      for (const p of Object.values(t.panes)) {
        out.push({
          tabId: t.id,
          paneId: p.id,
          title: p.title || p.path,
          path: p.path,
          active: t.id === activeId && p.id === t.activePane,
        });
      }
    }
    return out;
  })();
  const bootRef = useRef(false);
  const noticeTimer = useRef<number | null>(null);
  /** 内容搜索结果定位/粘贴后定位：目录加载完成后选中这些条目 */
  const pendingSelectRef = useRef<string[] | null>(null);
  /** 已关闭标签页（恢复用） */
  // 「恢复关闭的标签」栈：记录整个 TabState（含各窗格 entries 数组），不设上限会
  // 随反复开关大目录单调增长，重启前不释放 → FIFO 保留最近 20 条。
  const closedTabsRef = useRef<{ tab: TabState; index: number }[]>([]);

  const showError = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  /** 传输类失败（粘贴 / 拖拽 / 覆盖）：窗口中央红色浮层 + 状态栏留底。
   *  取消不是错误，只在状态栏轻提示。 */
  const showTransferError = useCallback(
    (e: unknown) => {
      const msg = String(e);
      if (msg.includes("取消")) {
        showError("已取消");
        return;
      }
      flashErrorTip(msg);
      showError(msg);
    },
    [flashErrorTip, showError],
  );

  /** v0.17 打开差异比对：需活动标签正好两个本地窗格（各指向一个目录）。
   *  目前仅支持本地 ↔ 本地；SFTP/HTTP 窗格不参与（故本地 ↔ SFTP 无法比对）。 */
  const openDiff = useCallback(() => {
    if (!activeTab) return;
    const local = collectPaneIds(activeTab.root)
      .map((id) => activeTab.panes[id])
      .filter(
        (p): p is NonNullable<typeof p> =>
          !!p && !p.path.startsWith("sftp://") && !p.path.startsWith("http") && !p.tagId,
      );
    if (local.length !== 2) {
      showError("差异比对需要正好两个本地窗格（暂不支持本地 ↔ SFTP/HTTP 比对）");
      return;
    }
    setDiffTarget({
      tabId: activeTab.id,
      left: local[0].path,
      right: local[1].path,
      leftPane: local[0].id,
      rightPane: local[1].id,
    });
  }, [activeTab, showError]);

  // 应用名 / 版本识别（getName = productName，Windows 任务栏与包元数据同源）
  useEffect(() => {
    void getName()
      .then(setAppName)
      .catch(() => {});
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  /** 打开 GitHub 仓库 */
  const openRepo = useCallback(() => {
    void openUrl(REPO_URL).catch((e) => showError(`打开仓库失败：${e}`));
  }, [showError]);

  /** 打开使用指南站点 */
  const openDocs = useCallback(() => {
    void openUrl(DOCS_URL).catch((e) => showError(`打开使用指南失败：${e}`));
  }, [showError]);

  /**
   * 检查更新：GitHub Releases API 比对最新 tag。
   * silent=true 用于启动后台静默检查（仅在有新版时提示，不弹对话框）。
   * v0.34 弹窗统一应用内风格：发现新版走 appConfirm 卡片，已是最新走中央轻提示
   * （此前 plugin-dialog 的系统消息框是经典样式，与应用内自绘弹窗割裂）。
   */
  const checkUpdate = useCallback(
    async (silent = false) => {
      const current = appVersion || "0.0.0";
      try {
        const info = await fetchLatestRelease(current);
        if (!info) {
          if (!silent) flashClipboardTip(`当前已是最新版本 v${current}`, 2000);
          return;
        }
        if (silent) {
          showError(`发现新版本 v${info.version}（帮助 → 检查更新）`);
          return;
        }
        const go = await appConfirm({
          title: `发现新版本 v${info.version}`,
          message: `当前版本 v${current}。是否前往下载页获取新版本？`,
          confirmLabel: "前往下载",
          cancelLabel: "以后再说",
        });
        if (go) void openUrl(info.url);
      } catch (e) {
        if (!silent) showError(`检查更新失败：${e}`);
      }
    },
    [appVersion, showError, appConfirm, flashClipboardTip],
  );

  // 启动后静默检查一次更新（3s 延迟，避免与首屏加载抢网络）
  useEffect(() => {
    if (!appVersion) return;
    const t = window.setTimeout(() => void checkUpdate(true), 3000);
    return () => window.clearTimeout(t);
  }, [appVersion, checkUpdate]);

  const patchPane = useCallback((paneId: number, patch: Partial<PaneState>) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (!(paneId in t.panes)) return t;
        const panes = { ...t.panes, [paneId]: { ...t.panes[paneId], ...patch } };
        const title = t.activePane === paneId ? panes[paneId].title : t.title;
        return { ...t, panes, title };
      }),
    );
  }, []);

  // ── v0.4 打开方式 / 终端 ──
  const [openers, setOpeners] = useState<OpenerItem[]>([]);
  const [shells, setShells] = useState<ShellItem[]>([]);
  /** v0.5 插件注册表 */
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const refreshOpeners = useCallback(() => {
    void apiListOpeners()
      .then(setOpeners)
      .catch((e) => showError(`检测打开方式失败：${e}`));
  }, [showError]);
  const refreshShells = useCallback(() => {
    void apiListShells()
      .then(setShells)
      .catch((e) => showError(`检测终端失败：${e}`));
  }, [showError]);
  // v0.29.0 右键「用 VSCode 打开」/「Git 打开」：探测结果（与终端同批首帧空闲后加载）
  const [vscodeOk, setVscodeOk] = useState(false);
  const [gitTools, setGitTools] = useState<GitToolItem[]>([]);
  const refreshGitTools = useCallback(() => {
    void apiVscodeDetected()
      .then(setVscodeOk)
      .catch(() => setVscodeOk(false));
    void apiListGitTools()
      .then(setGitTools)
      .catch(() => setGitTools([]));
  }, []);
  // v0.29.0 常用工具条：清单 + 本机编辑器检测建议（设置页改动后经 refreshQuickTools 刷新）
  const [quickTools, setQuickTools] = useState<QuickToolItem[]>([]);
  const [editorSugs, setEditorSugs] = useState<EditorCandidate[]>([]);
  const refreshQuickTools = useCallback(() => {
    void apiListQuickTools()
      .then(setQuickTools)
      .catch(() => setQuickTools([]));
    void apiDetectEditors()
      .then(setEditorSugs)
      .catch(() => setEditorSugs([]));
  }, []);
  const refreshPlugins = useCallback(() => {
    void apiListPlugins()
      .then(setPlugins)
      .catch((e) => showError(`读取插件清单失败：${e}`));
  }, [showError]);
  const handleTogglePlugin = useCallback(
    (id: string, enabled: boolean) => {
      void apiSetPluginEnabled(id, enabled)
        .then(setPlugins)
        .catch((e) => showError(`切换插件失败：${e}`));
    },
    [showError],
  );
  // 工具/插件检测延迟到首帧空闲后执行，避免拖慢首次渲染
  useEffect(() => {
    const t = window.setTimeout(() => {
      refreshOpeners();
      refreshShells();
      refreshGitTools();
      refreshQuickTools();
      refreshPlugins();
    }, 300);
    return () => window.clearTimeout(t);
  }, [refreshOpeners, refreshShells, refreshGitTools, refreshQuickTools, refreshPlugins]);
  // v0.37 远程文件交给本地应用前先确保本地副本：下载到打开临时目录再返回本地路径。
  // 未来远程后端（网盘等）在此加分发分支；本地路径原样返回。
  const ensureLocalCopy = useCallback(
    async (path: string): Promise<string> => {
      if (!isRemoteSchemePath(path)) return path;
      showError("正在下载远程文件…");
      if (path.startsWith("sftp://")) return sftpDownload(path);
      // http(s)：经设置页配置的临时目录中转（sftp 的目录由 api 层内部传入）
      const { path: dir } = await remoteTempInfo();
      return httpDownloadTo(dir, path);
    },
    [showError],
  );
  const handleOpenWith = useCallback(
    (toolId: string, path: string) => {
      if (isRemoteSchemePath(path)) {
        ensureLocalCopy(path)
          .then((local) => apiOpenWith(toolId, local))
          .catch((e) => showError(`远程打开失败：${e}`));
        return;
      }
      void apiOpenWith(toolId, path).catch((e) => showError(`打开失败：${e}`));
    },
    [ensureLocalCopy, showError],
  );
  // v0.29.0 右键「用 Visual Studio Code 打开」
  const handleOpenVscode = useCallback(
    (path: string) => {
      if (isRemoteSchemePath(path)) {
        ensureLocalCopy(path)
          .then((local) => apiOpenVscode(local))
          .catch((e) => showError(`用 VSCode 打开失败：${e}`));
        return;
      }
      void apiOpenVscode(path).catch((e) => showError(`用 VSCode 打开失败：${e}`));
    },
    [ensureLocalCopy, showError],
  );
  // v0.29.0 右键「Git 打开」折叠组
  const handleOpenGitTool = useCallback(
    (toolId: string, path: string) => {
      void apiOpenGitTool(toolId, path).catch((e) => showError(`打开 Git 工具失败：${e}`));
    },
    [showError],
  );
  // v0.29.0 常用工具条：菜单图标点击 / 设置页增删排序
  const handleOpenQuickTool = useCallback(
    (id: string, path: string) => {
      void apiOpenQuickTool(id, path).catch((e) => showError(`打开失败：${e}`));
    },
    [showError],
  );
  const handleAddQuickTool = useCallback(async () => {
    try {
      const picked = await openDialog({
        title: "选择应用程序",
        multiple: false,
        directory: false,
      });
      if (!picked || Array.isArray(picked)) return;
      const name = basename(picked).replace(/\.app$/i, "");
      await apiAddQuickTool(null, name, picked);
      refreshQuickTools();
    } catch (e) {
      showError(`添加常用工具失败：${e}`);
    }
  }, [showError, refreshQuickTools]);
  const handleAddSuggestedTool = useCallback(
    async (c: EditorCandidate) => {
      try {
        await apiAddQuickTool(c.id, c.name, c.exec);
        refreshQuickTools();
      } catch (e) {
        showError(`添加常用工具失败：${e}`);
      }
    },
    [showError, refreshQuickTools],
  );
  const handleRemoveQuickTool = useCallback(
    (id: string) => {
      void apiRemoveQuickTool(id)
        .then(refreshQuickTools)
        .catch((e) => showError(`移除常用工具失败：${e}`));
    },
    [showError, refreshQuickTools],
  );
  const handleMoveQuickTool = useCallback(
    (id: string, up: boolean) => {
      void apiMoveQuickTool(id, up)
        .then(refreshQuickTools)
        .catch((e) => showError(`调整顺序失败：${e}`));
    },
    [showError, refreshQuickTools],
  );
  const handleSetQuickToolArgs = useCallback(
    (id: string, args: string) => {
      void apiSetQuickToolArgs(id, args)
        .then(refreshQuickTools)
        .catch((e) => showError(`保存启动参数失败：${e}`));
    },
    [showError, refreshQuickTools],
  );
  const handleOpenTerminal = useCallback(
    (shellId: string, path: string) => {
      void apiOpenTerminal(shellId, path).catch((e) => showError(`打开终端失败：${e}`));
    },
    [showError],
  );
  const handleAddCustomOpener = useCallback(
    async (path?: string, ext?: string) => {
      try {
        const picked = await openDialog({
          title: "选择应用程序",
          multiple: false,
          directory: false,
        });
        if (!picked || Array.isArray(picked)) return;
        const wanted = ext ? normalizeExts([ext]) : [];
        // 已注册过 → 补齐本次文件类型的关联，再用它打开
        const existing = openers.find((o) => o.exec === picked);
        if (existing) {
          const merged = normalizeExts([...existing.extensions, ...wanted]);
          if (merged.length !== existing.extensions.length) {
            await apiSetOpenerExtensions(existing.id, merged);
            refreshOpeners();
          }
          if (path) handleOpenWith(existing.id, path);
          return;
        }
        // 名称取可执行文件名（去掉 .app），无需再弹输入框（Tauri WKWebView 不支持 window.prompt）
        const name = basename(picked).replace(/\.app$/i, "");
        const item = await apiAddCustomOpener(name, picked, wanted);
        refreshOpeners();
        // 选定即用：直接用新注册的应用打开当前文件
        if (path) handleOpenWith(item.id, path);
      } catch (e) {
        showError(`添加打开方式失败：${e}`);
      }
    },
    [openers, refreshOpeners, handleOpenWith, showError],
  );

  /** 设置面板：删除某个自定义打开方式（应用内确认框；关联该扩展名的条目随之失效） */
  const handleRemoveCustomOpener = useCallback(
    async (id: string) => {
      const o = openers.find((x) => x.id === id);
      const ok = await appConfirm({
        title: "删除打开方式",
        message: `确定删除「${o?.name ?? id}」？`,
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await apiRemoveCustomOpener(id);
        refreshOpeners();
      } catch (e) {
        showError(`删除打开方式失败：${e}`);
      }
    },
    [openers, refreshOpeners, showError, appConfirm],
  );

  /** 设置面板：覆盖设置某打开方式的关联扩展名 */
  const handleSetOpenerExtensions = useCallback(
    async (id: string, extensions: string[]) => {
      try {
        await apiSetOpenerExtensions(id, extensions);
        refreshOpeners();
      } catch (e) {
        showError(`保存扩展名失败：${e}`);
      }
    },
    [refreshOpeners, showError],
  );

  // 主题同步：dark 只驱动 html.dark；system 模式监听系统深浅色实时翻转
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      setDark(themeMode === "system" ? mql.matches : themeMode === "dark");
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [themeMode]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  /** 设置颜色模式（显式 light/dark 或跟随系统），随改随存 */
  const changeThemeMode = useCallback((m: ThemeMode) => {
    setThemeMode(m);
    try {
      localStorage.setItem("rfm.theme", m);
    } catch {
      /* ignore */
    }
  }, []);
  /** 设置界面语言（zh/en），随改随存（v0.38） */
  const changeLanguage = useCallback((lang: Language) => {
    setLanguage(lang);
    try {
      localStorage.setItem("rfm.language", lang);
    } catch {
      /* ignore */
    }
  }, []);
  /** 快捷键/菜单切换：写显式模式（跟随系统时按当前生效值翻转并退出跟随） */
  const toggleTheme = useCallback(() => {
    changeThemeMode(dark ? "light" : "dark");
  }, [dark, changeThemeMode]);



  const refreshPane = useCallback((paneId: number) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (!(paneId in t.panes)) return t;
        const pane = t.panes[paneId];
        return {
          ...t,
          panes: { ...t.panes, [paneId]: { ...pane, refreshKey: pane.refreshKey + 1 } },
        };
      }),
    );
  }, []);

  /** 批量刷新多个窗格（一次 setTabs）：拖拽/粘贴后的源+目标双窗格刷新合并为
   *  一轮状态更新，同步比对只重跑一次而不是两次 */
  const refreshPanes = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    setTabs((ts) =>
      ts.map((t) => {
        let changed = false;
        const panes = { ...t.panes };
        for (const id of ids) {
          const pane = panes[id];
          if (!pane) continue;
          panes[id] = { ...pane, refreshKey: pane.refreshKey + 1 };
          changed = true;
        }
        return changed ? { ...t, panes } : t;
      }),
    );
  }, []);

  /** 会话恢复（v0.3.0）：重建标签集合 + 分屏树 + pane 路径；SFTP 并发重连（需 master-key） */

  // 活动 pane 路径/刷新键变化时加载目录。
  // v0.22.1（方案A）：按 paneId 记住「当前 entries 属于哪次加载」（path:refreshKey），
  // 未变（= 标签间/分屏内切换回来）直接用内存 entries，不再 loading + 重读目录
  // （此前 activeId 在依赖里，每次切换都发起一次多余的 list_dir IO + 两轮额外渲染）。
  // 导航离开后 entries 已被替换，回来时 key 不匹配 → 正常重读；F5 / 同路径回车
  // bump refreshKey → 必然重读。加载失败不更新记录，再次激活自动重试。
  const loadedPaneKeysRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    if (!activePane) return;
    const paneKey = `${activePane.path}:${activePane.refreshKey}`;
    // entries 可能在标签视图切换时被清空（下方 VIRTUAL_TAG 分支），空了就要重拉
    if (loadedPaneKeysRef.current.get(activePane.id) === paneKey && activePane.entries.length > 0) {
      return;
    }
    // 虚拟标签目录：不请求后端，清空 entries（由 TagView 渲染）
    if (VIRTUAL_TAG_RE.test(activePane.path)) {
      loadedPaneKeysRef.current.set(activePane.id, paneKey);
      setTabs((ts) =>
        ts.map((t) => {
          const p = t.panes[activePane.id];
          if (!p) return t;
          return {
            ...t,
            panes: {
              ...t.panes,
              [activePane.id]: { ...p, loading: false, entries: [], error: null },
            },
          };
        }),
      );
      return;
    }
    let cancelled = false;
    setTabs((ts) =>
      ts.map((t) => {
        const p = t.panes[activePane.id];
        if (!p) return t;
        return { ...t, panes: { ...t.panes, [activePane.id]: { ...p, loading: true, error: null } } };
      }),
    );
    listDir(activePane.path)
      .then((entries) => {
        if (cancelled) return;
        loadedPaneKeysRef.current.set(activePane.id, paneKey);
        // 在 updater 外消费 pending：updater 必须是纯函数（StrictMode 会双调用，
        // 在内部清 ref 的副作用会被第二次调用丢弃，导致选中不生效）
        const pending = pendingSelectRef.current;
        let hits: string[] | null = null;
        if (pending && pending.length > 0) {
          const pendingSet = new Set(pending);
          hits = entries.filter((e) => pendingSet.has(e.path)).map((e) => e.path);
          if (hits.length > 0) pendingSelectRef.current = null;
          else hits = null;
        }
        setTabs((ts) =>
          ts.map((t) => {
            const p = t.panes[activePane.id];
            if (!p) return t;
            const selection = hits ?? p.selection;
            const updated = { ...p, entries, loading: false, selection };
            const title = t.activePane === activePane.id ? updated.title : t.title;
            return { ...t, panes: { ...t.panes, [activePane.id]: updated }, title };
          }),
        );
      })
      .catch((e) => {
        if (!cancelled) {
          setTabs((ts) =>
            ts.map((t) => {
              const p = t.panes[activePane.id];
              if (!p) return t;
              return {
                ...t,
                panes: {
                  ...t.panes,
                  [activePane.id]: { ...p, loading: false, error: String(e) },
                },
              };
            }),
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activePane?.id, activePane?.path, activePane?.refreshKey]);

  const setActivePane = useCallback(
    (paneId: number) => {
      if (!activeTab) return;
      setTabs((ts) =>
        ts.map((t) =>
          t.id === activeTab.id
            ? { ...t, activePane: paneId, title: t.panes[paneId]?.title ?? t.title }
            : t,
        ),
      );
    },
    [activeTab],
  );

  // 导航（作用于活动 pane）
  // SFTP 与 navigate 互相引用（navigate 要读 sftp.connectedRef，sftp 连接成功后要 navigate），
  // 用 ref 打破循环：navigateVia 稳定，navigate 定义完后再回填。
  const navigateRef = useRef<(path: string) => void>(() => {});
  const navigateVia = useCallback((path: string) => navigateRef.current(path), []);
  // SFTP 与 navigate 互相引用（navigate 要读 sftp.connectedRef，sftp 连接成功后要 navigate），
  const showInfo = useCallback((msg: string) => flashClipboardTip(msg, 2400), [flashClipboardTip]);
  const sftp = useSftp({ navigate: navigateVia, patchPane, listDir, showError, showInfo });

  const navigate = useCallback(
    async (path: string) => {
      if (!activePane) return;
      // v0.18：地址栏支持 "~"（主目录）与相对路径，统一解析为绝对路径后再导航。
      // 仅对本地原始输入生效；sftp/http/标签路径原样交给各自分支。
      if (
        !path.startsWith("sftp://") &&
        !path.startsWith("http://") &&
        !path.startsWith("https://") &&
        !VIRTUAL_TAG_RE.test(path) &&
        (path.startsWith("~") || !isAbsolutePath(path))
      ) {
        try {
          path = await resolvePath(path, activePane.path);
        } catch {
          // 解析失败则按原样尝试，由加载逻辑给出错误
        }
      }
      // SFTP：连接状态必须先判断——否则会话重启后未连接时，
      // 重新输入同一路径只会走到"同路径刷新"而报错，不会弹连接框
      if (path.startsWith("sftp://")) {
        const au = parseSftpAuthority(path);
        if (au && sftp.connectedRef.current.has(au.id)) {
          // 已连接：同路径刷新，否则继续导航
          if (activePane.path === path) {
            refreshPane(activePane.id);
            return;
          }
        } else if (au) {
          // 有 authority 但未连接：记住目标路径，弹连接框预填，连上后直达该路径。
          // v0.29.0：host 之后的部分（sftp://u@h:/home/myuser 的 /home/myuser）
          // 同时预填进连接框「根目录」（默认为 home 的那个输入框），连接后随配置保存
          sftp.rememberPendingPath(
            au.remotePath && au.remotePath !== "/" ? au.remotePath : null,
          );
          sftp.openConnect({
            host: au.host,
            port: au.port,
            user: au.user,
            root: au.remotePath && au.remotePath !== "/" ? au.remotePath : undefined,
          });
          return;
        } else {
          // 只有 "sftp://" 没有 host/user：弹空白连接框
          sftp.rememberPendingPath(null);
          sftp.openConnect({});
          return;
        }
      } else if (activePane.path === path) {
        // 本地路径相同也刷新
        refreshPane(activePane.id);
        return;
      }
      const m = path.match(VIRTUAL_TAG_RE);
      const history = [...activePane.history.slice(0, activePane.histIndex + 1), path];
      patchPane(activePane.id, {
        path,
        title: m ? tagTitle(m[1]) : basename(path),
        tagId: m ? m[1] : undefined,
        history,
        histIndex: history.length - 1,
        selection: [],
        entries: m ? [] : activePane.entries,
        error: null,
      });
    },
    [activePane, patchPane, parseSftpAuthority, sftp],
  );
  navigateRef.current = navigate;

  /** 地址栏 scheme 门控（v0.25）：sftp:// 输入仅在对应服务器已连接时做远程补全 */
  const isSftpConnectedPath = useCallback((path: string) => {
    const au = parseSftpAuthority(path);
    return !!au && sftp.connectedRef.current.has(au.id);
  }, [sftp]);

  /** 显式加载指定窗格目录（listDir effect 只监听活动 pane，恢复的非活动窗格需手动加载） */
  const loadPaneNow = useCallback(
    async (paneId: number, path: string) => {
      try {
        const entries = await listDir(path);
        patchPane(paneId, { entries, loading: false, error: null });
      } catch (e) {
        patchPane(paneId, { loading: false, error: String(e) });
      }
    },
    [patchPane],
  );

  /** 恢复单个 SFTP 快照窗格：重连（后端回退已存配置 + master-key 解密）并加载目录；
   *  NEED_MASTER_KEY 时挂起 pendingRestore，主密钥验证后统一续跑。
   *  会话恢复与「打开收藏」共用。 */
  const restoreSftpPane = useCallback(
    async (sp: { paneId: number; serverId: string; path: string }) => {
      try {
        await sftpConnect({
          id: sp.serverId,
          name: "",
          host: "",
          port: 22,
          user: "",
          root: null,
          group: "",
          auth: "password",
        });
        sftp.connectedRef.current.add(sp.serverId);
        await loadPaneNow(sp.paneId, sp.path);
        void sftp.syncConnected(
          sftp.servers.map((s) => (s.id === sp.serverId ? { ...s, connected: true } : s)),
        );
      } catch (e) {
        const msg = String(e);
        if (msg.includes("NEED_MASTER_KEY")) {
          sftp.pendingRestoreRef.current.push(sp);
          sftp.setMasterKeyOpen(true);
        } else {
          patchPane(sp.paneId, { error: `会话未恢复：SFTP 需要验证（${msg}）` });
        }
      }
    },
    [loadPaneNow, patchPane, sftp],
  );

  const restoreSession = useCallback(
    async (layout: SessionLayout) => {
      const restored: TabState[] = [];
      const sftpPanes: { paneId: number; serverId: string; path: string }[] = [];
      for (const st of layout.tabs) {
        const built = buildTabFromSnapshot(st);
        restored.push(built.tab);
        sftpPanes.push(...built.sftpPanes);
      }
      if (restored.length === 0) return;
      setTabs(restored);
      const idx = Math.min(Math.max(layout.activeTab, 0), restored.length - 1);
      setActiveId(restored[idx].id);
      const localPanes: { paneId: number; path: string }[] = [];
      const firstActive = restored[idx]?.activePane;
      for (const t of restored) {
        for (const p of Object.values(t.panes)) {
          if (p.path.startsWith("sftp://")) continue;
          if (p.id === firstActive) continue; // 首屏：活动窗格由 listDir effect 加载
          localPanes.push({ paneId: p.id, path: p.path });
        }
      }
      // 其余窗格分批加载（每批 3 个），避免启动期并发渲染风暴导致闪屏/卡顿
      const BATCH = 3;
      (async () => {
        for (let i = 0; i < localPanes.length; i += BATCH) {
          const batch = localPanes.slice(i, i + BATCH);
          await Promise.all(batch.map((lp) => loadPaneNow(lp.paneId, lp.path)));
          if (i + BATCH < localPanes.length) {
            await new Promise((r) => setTimeout(r, 30));
          }
        }
      })();
      // SFTP 并发恢复（后端回退已存配置 + master-key 解密）
      await Promise.all(sftpPanes.map((sp) => restoreSftpPane(sp)));
    },
    [loadPaneNow, restoreSftpPane],
  );

  // 首次启动
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      try {
        const [home, vols, qa, favs] = await Promise.all([
          getHomeDir(),
          getVolumes(),
          getQuickAccess(),
          favoritesLoad().catch(() => null),
        ]);
        setHomePath(home);
        setVolumes(vols);
        setQuickAccess(qa);
        setFavorites(favs ?? []);
        // 会话恢复（v0.3.0）：有保存的布局则恢复，否则默认家目录
        const layout = await sessionLoad().catch(() => null);
        if (layout && layout.tabs && layout.tabs.length > 0) {
          await restoreSession(layout);
        } else {
          const tab = makeTab(home);
          setTabs([tab]);
          setActiveId(tab.id);
        }
        // v0.14：从磁盘恢复标签配置（localStorage 被清空时的可靠备份）
        const disk = await loadPrefsFromDisk();
        if (disk) {
          mergeDiskPrefs(disk);
          setTagNames(loadTagNames());
          setFileTags(loadFileTags());
          setCustomQuick(loadCustomQuick());
          setEntryAliases(loadEntryAliases());
        } else {
          // 磁盘尚无备份：把本地现有配置回写一份
          flushPrefsToDisk();
        }
      } catch (e) {
        console.error("启动失败", e);
      }
    })();
    sftp.refresh();
  }, [sftp.refresh]);

  const goBack = useCallback(() => {
    if (!activePane || activePane.histIndex <= 0) return;
    const target = activePane.history[activePane.histIndex - 1];
    const m = target.match(VIRTUAL_TAG_RE);
    patchPane(activePane.id, {
      path: target,
      title: m ? tagTitle(m[1]) : basename(target),
      tagId: m ? m[1] : undefined,
      histIndex: activePane.histIndex - 1,
      selection: [],
    });
  }, [activePane, patchPane]);

  /** 退出标签视图：操作指定 pane（不一定是 activePane），回到 history 里最后一个非 tags:// 的真实目录 */
  const exitTagViewForPane = useCallback(
    (paneId: number) => {
      const pane = activeTab?.panes?.[paneId];
      if (!pane) return;
      let idx = pane.histIndex;
      while (idx >= 0 && pane.history[idx].match(VIRTUAL_TAG_RE)) {
        idx--;
      }
      if (idx < 0) {
        patchPane(paneId, { tagId: undefined });
        return;
      }
      const target = pane.history[idx];
      patchPane(paneId, {
        path: target,
        title: basename(target),
        tagId: undefined,
        histIndex: idx,
        selection: [],
      });
    },
    [tabs, patchPane],
  );

  const goForward = useCallback(() => {
    if (!activePane || activePane.histIndex >= activePane.history.length - 1) return;
    const target = activePane.history[activePane.histIndex + 1];
    patchPane(activePane.id, {
      path: target,
      title: basename(target),
      histIndex: activePane.histIndex + 1,
      selection: [],
    });
  }, [activePane, patchPane]);

  /** 最近一次写盘的会话内容签名（sessionSignature）：自动保存脏检查用 */
  const lastSessionSigRef = useRef<string | null>(null);
  /** 退出流程置位后停用自动保存：避免「不保存并退出」清除会话后定时器又写回去 */
  const sessionAutosaveOffRef = useRef(false);

  /** 立即保存会话布局：Ctrl+S 主动保存 / 退出前保存 / 崩溃恢复自动保存共用。
   *  成功后记录签名供脏检查；silent 模式（自动保存）不弹提示不打扰。 */
  const saveSessionNow = useCallback(
    async (opts?: { silent?: boolean }) => {
      const sig = sessionSignature(tabsRef.current, activeIdRef.current);
      try {
        await sessionSave(serializeSession(tabsRef.current, activeIdRef.current));
        lastSessionSigRef.current = sig;
        if (!opts?.silent) flashClipboardTip("会话已保存");
      } catch (e) {
        if (!opts?.silent) showError(`保存会话失败：${e}`);
      }
    },
    [flashClipboardTip, showError],
  );

  // 崩溃恢复自动保存（v0.34）：每 15s 比对会话签名，布局有变化才写盘
  // （session.json 原子写，见后端 session_save）。窗口隐藏（最小化/切走）时立即补存，
  // 意外中断（崩溃 / 断电 / 强杀）后下次启动可恢复最近布局，不再依赖「保存并退出」。
  useEffect(() => {
    const saveIfChanged = () => {
      if (sessionAutosaveOffRef.current) return;
      const sig = sessionSignature(tabsRef.current, activeIdRef.current);
      if (sig === lastSessionSigRef.current) return;
      void saveSessionNow({ silent: true });
    };
    const timer = window.setInterval(saveIfChanged, 15000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveIfChanged();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [saveSessionNow]);

  /** 退出：保存当前会话布局后退出进程（exit 兜底，避免 destroy 链路挂起）。
   *  v0.23 先 allow_exit 放行 Rust 侧 ExitRequested 拦截，否则 prevent_exit 会拦住 exit(0) */
  const handleExitWithSave = useCallback(async () => {
    sessionAutosaveOffRef.current = true;
    await saveSessionNow({ silent: true });
    await allowExit().catch(() => {});
    await exit(0).catch(() => getCurrentWindow().destroy());
  }, [saveSessionNow]);

  /** 退出：不保存，清除已保存会话后退出进程。
   *  自动保存会持续更新 session.json，必须显式清除，下次启动才回到默认布局。 */
  const handleExitNoSave = useCallback(async () => {
    sessionAutosaveOffRef.current = true;
    await sessionClear().catch(() => {});
    await allowExit().catch(() => {});
    await exit(0).catch(() => getCurrentWindow().destroy());
  }, []);

  // 拦截窗口关闭 → 询问是否保存会话（v0.3.0）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((e) => {
        e.preventDefault();
        setCloseDialogOpen(true);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* 环境不支持时按默认直接关闭 */
      });
    return () => {
      unlisten?.();
    };
  }, []);

  // v0.23 应用级退出（macOS ⌘Q / Dock 退出）被 Rust 侧拦截后转发到这里，
  // 与窗口 X 关闭共用同一个确认对话框
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("app-exit-requested", () => {
      setCloseDialogOpen(true);
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, []);

  // v0.21.1 退出询问的对话框级快捷键（仅 closeDialogOpen 时挂载，避免与全局键位冲突）：
  // Esc=取消 / Ctrl+S(或 ⌘S)=保存并退出 / Ctrl+C=不保存。capture 阶段拦截，
  // 压制全局 keymap 分发（否则 Esc 会顺带清空文件选中）。
  useModalLayer("quitConfirm", 70, closeDialogOpen);
  useEffect(() => {
    if (!closeDialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // 栈顶仲裁：更高层弹层（如密码框）打开时让位，避免一次 Esc 关多层
      if (!isTopModalLayer("quitConfirm")) return;
      const key = e.key.toLowerCase();
      const save = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === "s";
      const noSave = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === "c";
      if (e.key === "Escape" || save || noSave) {
        e.preventDefault();
        e.stopPropagation();
        if (save) void handleExitWithSave();
        else if (noSave) void handleExitNoSave();
        else setCloseDialogOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [closeDialogOpen, handleExitWithSave, handleExitNoSave]);

  const goUp = useCallback(async () => {
    if (!activePane) return;
    try {
      const parent = await parentDir(activePane.path);
      if (parent !== activePane.path) navigate(parent);
    } catch {
      /* 已在根目录 */
    }
  }, [activePane, navigate]);

  const refresh = useCallback(() => {
    if (activePane) refreshPane(activePane.id);
  }, [activePane, refreshPane]);

  // 标签页操作
  const newTab = useCallback((path?: string) => {
    const target = path ?? activePane?.path ?? homePath;
    const m = target.match(VIRTUAL_TAG_RE);
    const pane = makePane(target);
    if (m) pane.tagId = m[1];
    const tab: TabState = {
      id: nextTabId++,
      title: m ? tagTitle(m[1]) : pane.title,
      root: { type: "pane", paneId: pane.id },
      activePane: pane.id,
      panes: { [pane.id]: pane },
    };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }, [activePane, homePath]);

  const closeTab = useCallback(
    (id: number) => {
      setTabs((ts) => {
        if (ts.length <= 1) return ts;
        const idx = ts.findIndex((t) => t.id === id);
        const target = ts[idx];
        if (target) {
          const closed = closedTabsRef.current;
          closed.push({ tab: target, index: idx });
          if (closed.length > 20) closed.shift();
          // v0.7：关闭被分享的标签 → 自动停止其目录分享
          const dirs = new Set<string>();
          for (const pane of Object.values(target.panes)) {
            if (pane.path && !pane.path.startsWith("sftp://") && !pane.path.startsWith("http")) {
              dirs.add(pane.path);
            }
          }
          dirs.forEach((d) => void shareStopByDir(d));
        }
        const next = ts.filter((t) => t.id !== id);
        if (id === activeId) {
          const neighbor = next[Math.max(0, idx - 1)];
          setActiveId(neighbor.id);
        }
        return next;
      });
    },
    [activeId],
  );

  const selectTab = useCallback((id: number) => setActiveId(id), []);

  // keep-alive LRU：激活即置顶，超 KEEP_ALIVE_MAX 淘汰最久未用的标签树
  useEffect(() => {
    setKeptTabIds((prev) => {
      const next = [activeId, ...prev.filter((id) => id !== activeId)];
      return next.length > KEEP_ALIVE_MAX ? next.slice(0, KEEP_ALIVE_MAX) : next;
    });
  }, [activeId]);

  /** 激活指定标签页中的某个窗格（路径栏右侧「已连接窗格」下拉） */
  const activatePane = useCallback((tabId: number, paneId: number) => {
    setActiveId(tabId);
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId
          ? { ...t, activePane: paneId, title: t.panes[paneId]?.title ?? t.title }
          : t,
      ),
    );
  }, []);

  /** 右键标签重命名：空串恢复自动标题 */
  const renameTab = useCallback((id: number, title: string) => {
    setTabs((ts) =>
      ts.map((t) => (t.id === id ? { ...t, customTitle: title || undefined } : t)),
    );
  }, []);

  // ==================== 标签收藏（收藏夹面板数据源） ====================

  /** 收藏变更统一落盘（变更频率低，直接整文件原子写） */
  const persistFavorites = useCallback(
    (next: TabFavorite[]) => {
      setFavorites(next);
      favoritesSave(next).catch((e) => showError(`保存收藏夹失败：${e}`));
    },
    [showError],
  );

  /** 收藏指定标签（标签右键 / 面板「收藏当前标签页」）：名称取自定义标题或自动标题，重名加序号 */
  const addFavorite = useCallback(
    (tabId: number) => {
      const t = tabsRef.current.find((x) => x.id === tabId);
      if (!t) return;
      const name = dedupeName(
        t.customTitle ?? t.title,
        favorites.map((f) => f.name),
      );
      const now = new Date().toISOString();
      persistFavorites([
        ...favorites,
        { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now, tab: serializeSessionTab(t) },
      ]);
      flashClipboardTip(`已收藏「${name}」`);
    },
    [favorites, persistFavorites, flashClipboardTip],
  );

  /** 重命名收藏（重名自动加序号；只动元数据，updatedAt 反映快照新鲜度故不变） */
  const renameFavorite = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      persistFavorites(
        favorites.map((f) =>
          f.id === id
            ? {
                ...f,
                name: dedupeName(
                  trimmed,
                  favorites.filter((x) => x.id !== id).map((x) => x.name),
                ),
              }
            : f,
        ),
      );
    },
    [favorites, persistFavorites],
  );

  /** 删除收藏：一键直删不再二次确认（收藏是可随手重建的轻量对象，确认框徒增点击），
   *  删除后中央轻提示反馈。标签页本身不受影响。 */
  const removeFavorite = useCallback(
    (id: string) => {
      const fav = favorites.find((f) => f.id === id);
      if (!fav) return;
      persistFavorites(favorites.filter((f) => f.id !== id));
      flashClipboardTip(`已删除收藏「${fav.name}」`, 1400);
    },
    [favorites, persistFavorites, flashClipboardTip],
  );

  /** 用当前活动标签的布局覆盖收藏快照（名称与创建时间不变） */
  const updateFavorite = useCallback(
    (id: string) => {
      if (!activeTab) return;
      persistFavorites(
        favorites.map((f) =>
          f.id === id
            ? { ...f, updatedAt: new Date().toISOString(), tab: serializeSessionTab(activeTab) }
            : f,
        ),
      );
      flashClipboardTip("收藏已更新为当前布局");
    },
    [activeTab, favorites, persistFavorites, flashClipboardTip],
  );

  /** 打开收藏：按快照重建一个新标签页并激活（不动现有标签）。
   *  活动窗格由 listDir effect 加载；其余本地窗格并发手动加载；SFTP 走重连/主密钥链路。 */
  const openFavorite = useCallback(
    (id: string) => {
      const fav = favorites.find((f) => f.id === id);
      if (!fav) return;
      const { tab, sftpPanes } = buildTabFromSnapshot(fav.tab);
      setTabs((ts) => [...ts, tab]);
      setActiveId(tab.id);
      for (const p of Object.values(tab.panes)) {
        if (p.path.startsWith("sftp://")) continue;
        if (p.id === tab.activePane) continue; // 活动窗格由 listDir effect 加载
        void loadPaneNow(p.id, p.path);
      }
      sftpPanes.forEach((sp) => void restoreSftpPane(sp));
    },
    [favorites, loadPaneNow, restoreSftpPane],
  );

  const cycleTab = useCallback(
    (delta: number) => {
      const idx = tabs.findIndex((t) => t.id === activeId);
      if (idx < 0 || tabs.length <= 1) return;
      const next = tabs[(idx + delta + tabs.length) % tabs.length];
      setActiveId(next.id);
    },
    [tabs, activeId],
  );

  const jumpTab = useCallback(
    (n: number) => {
      const t = tabs[n - 1];
      if (t) setActiveId(t.id);
    },
    [tabs],
  );

  const reopenTab = useCallback(() => {
    const rec = closedTabsRef.current.pop();
    if (!rec) return;
    setTabs((ts) => {
      const next = [...ts];
      next.splice(Math.min(rec.index, next.length), 0, rec.tab);
      return next;
    });
    setActiveId(rec.tab.id);
  }, []);

  /** 关闭被分享的标签时停止其目录分享（closeTab 与批量关闭共用） */
  const stopTabShares = useCallback((target: TabState) => {
    const dirs = new Set<string>();
    for (const pane of Object.values(target.panes)) {
      if (pane.path && !pane.path.startsWith("sftp://") && !pane.path.startsWith("http")) {
        dirs.add(pane.path);
      }
    }
    dirs.forEach((d) => void shareStopByDir(d));
  }, []);

  /** 记录被批量关闭的标签进「恢复关闭的标签」栈（保留最近 20 条）。
   *  在事件处理阶段用 tabsRef 读取最新标签，避免在 setTabs updater 里做副作用
   *  被 StrictMode 双调用重复入栈。 */
  const recordClosedTabs = useCallback(
    (ids: number[]) => {
      const cur = tabsRef.current;
      for (const id of ids) {
        const index = cur.findIndex((t) => t.id === id);
        const tab = cur[index];
        if (!tab) continue;
        const closed = closedTabsRef.current;
        closed.push({ tab, index });
        if (closed.length > 20) closed.shift();
        stopTabShares(tab);
      }
    },
    [stopTabShares],
  );

  /** 关闭除 keepId 以外的所有标签（右键标签菜单） */
  const closeOtherTabs = useCallback(
    (keepId: number) => {
      const cur = tabsRef.current;
      if (cur.length <= 1 || !cur.some((t) => t.id === keepId)) return;
      recordClosedTabs(cur.filter((t) => t.id !== keepId).map((t) => t.id));
      setTabs((ts) => {
        const kept = ts.find((t) => t.id === keepId);
        return kept ? [kept] : ts;
      });
      setActiveId(keepId);
    },
    [recordClosedTabs],
  );

  /** 关闭 id 右侧的所有标签（右键标签菜单） */
  const closeTabsToRight = useCallback(
    (id: number) => {
      const cur = tabsRef.current;
      const idx = cur.findIndex((t) => t.id === id);
      if (idx < 0 || idx >= cur.length - 1) return;
      recordClosedTabs(cur.slice(idx + 1).map((t) => t.id));
      setTabs((ts) => {
        const i = ts.findIndex((t) => t.id === id);
        return i < 0 ? ts : ts.slice(0, i + 1);
      });
      // 若活动标签落在被关闭的右侧区间，回落到 id
      setActiveId((prev) => (cur.slice(0, idx + 1).some((t) => t.id === prev) ? prev : id));
    },
    [recordClosedTabs],
  );

  // 列表操作（作用于指定 pane）
  const select = useCallback(
    (paneId: number, entry: FileEntry, additive: boolean) => {
      setTabs((ts) =>
        ts.map((t) => {
          const pane = t.panes[paneId];
          if (!pane) return t;
          let selection: string[];
          if (additive) {
            selection = pane.selection.includes(entry.path)
              ? pane.selection.filter((p) => p !== entry.path)
              : [...pane.selection, entry.path];
          } else {
            selection = [entry.path];
          }
          return { ...t, panes: { ...t.panes, [paneId]: { ...pane, selection } } };
        }),
      );
    },
    [],
  );

  const selectRange = useCallback((paneId: number, paths: string[]) => {
    setTabs((ts) =>
      ts.map((t) => {
        const pane = t.panes[paneId];
        if (!pane) return t;
        return { ...t, panes: { ...t.panes, [paneId]: { ...pane, selection: paths } } };
      }),
    );
  }, []);

  const clearSelection = useCallback((paneId: number) => {
    setTabs((ts) =>
      ts.map((t) => {
        const pane = t.panes[paneId];
        if (!pane) return t;
        return { ...t, panes: { ...t.panes, [paneId]: { ...pane, selection: [] } } };
      }),
    );
  }, []);

  /** 全选指定 pane（遵循隐藏文件开关） */
  const selectAllIn = useCallback(
    (paneId: number) => {
      const pane = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === paneId);
      if (!pane) return;
      const visible = showHidden
        ? pane.entries
        : pane.entries.filter((e) => !e.name.startsWith("."));
      selectRange(paneId, visible.map((e) => e.path));
    },
    [tabs, showHidden, selectRange],
  );

  /** 反向选择指定 pane（遵循隐藏文件开关） */
  const invertSelectionIn = useCallback(
    (paneId: number) => {
      const pane = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === paneId);
      if (!pane) return;
      const visible = showHidden
        ? pane.entries
        : pane.entries.filter((e) => !e.name.startsWith("."));
      const sel = new Set(pane.selection);
      selectRange(
        paneId,
        visible.filter((e) => !sel.has(e.path)).map((e) => e.path),
      );
    },
    [tabs, showHidden, selectRange],
  );

  /** 内容搜索/文件名搜索结果打开：跳转到文件所在目录并选中 */
  const openSearchResult = useCallback(
    (dir: string, filePath: string) => {
      if (!activePane) return;
      if (activePane.path === dir) {
        selectRange(activePane.id, [filePath]);
      } else {
        pendingSelectRef.current = [filePath];
        navigate(dir);
      }
    },
    [activePane, navigate, selectRange],
  );

  /** 搜索面板内联重命名完成：刷新正显示该目录的所有窗格，并定位选中新条目 */
  const handleSearchRenamed = useCallback(
    (oldPath: string, newPath: string) => {
      const parent = parentPath(oldPath);
      tabs
        .flatMap((t) => Object.values(t.panes))
        .filter((p) => p.path === parent)
        .forEach((p) => refreshPane(p.id));
      pendingSelectRef.current = [newPath];
    },
    [tabs, refreshPane],
  );

  /** 标签视图中打开条目：目录直接进入（脱离标签视图），文件定位所在目录并选中 */
  const openTagFile = useCallback(
    async (path: string) => {
      try {
        const kind = await statPath(path);
        if (kind === "dir" || kind === "symlink") {
          navigate(path);
        } else {
          openSearchResult(parentOf(path), path);
        }
      } catch {
        openSearchResult(parentOf(path), path);
      }
    },
    [navigate, openSearchResult],
  );

  /** 用系统关联程序打开文件（按扩展名 / 协议）；http 走浏览器，sftp 先经
   *  ensureLocalCopy 下载到打开临时目录（v0.37 起目录可在设置中更改） */
  const openFileExternal = useCallback(
    (path: string) => {
      if (path.startsWith("http://") || path.startsWith("https://")) {
        openUrl(path).catch((e) => showError(`打开 URL 失败：${e}`));
        return;
      }
      const remote = path.startsWith("sftp://");
      ensureLocalCopy(path)
        .then((local) => openPath(local))
        .catch((e) => showError(remote ? `远程打开失败：${e}` : `打开失败：${e}`));
    },
    [ensureLocalCopy, showError],
  );

  /** 在激活窗格中定位条目：目录直接进入，文件跳转所在目录并选中（搜索结果右键/双击用） */
  const revealPath = useCallback(
    (path: string, isDir: boolean) => {
      if (isDir) navigate(path);
      else openSearchResult(parentPath(path), path);
    },
    [navigate, openSearchResult],
  );

  const openEntry = useCallback(
    (paneId: number, entry: FileEntry) => {
      if (entry.is_dir) {
        // 目标 pane 导航
        setTabs((ts) =>
          ts.map((t) => {
            const pane = t.panes[paneId];
            if (!pane || pane.path === entry.path) return t;
            const history = [...pane.history.slice(0, pane.histIndex + 1), entry.path];
            const updated = {
              ...pane,
              path: entry.path,
              title: basename(entry.path),
              history,
              histIndex: history.length - 1,
              selection: [],
            };
            const title = t.activePane === paneId ? updated.title : t.title;
            return { ...t, panes: { ...t.panes, [paneId]: updated }, title };
          }),
        );
      } else {
        openFileExternal(entry.path);
      }
    },
    [openFileExternal],
  );

  const copyPath = useCallback((path: string) => {
    navigator.clipboard?.writeText(path).catch(() => {});
  }, []);

  // M1 文件操作

  const doCopy = useCallback(
    (paneId?: number, paths?: string[]) => {
      const p = paneId !== undefined ? paneId : activePane?.id;
      const list = paths ?? activePane?.selection ?? [];
      if (p === undefined || list.length === 0) return;
      setClipboard({ op: "copy", paths: list });
      flashClipboardTip("已复制");
      // 跨应用：同时写入系统剪贴板文件列表（best-effort，失败不影响应用内粘贴）
      void clipboardWriteFiles(list, false).catch(() => {});
    },
    [activePane, flashClipboardTip],
  );

  const doCut = useCallback(
    (paneId?: number, paths?: string[]) => {
      const p = paneId !== undefined ? paneId : activePane?.id;
      const list = paths ?? activePane?.selection ?? [];
      if (p === undefined || list.length === 0) return;
      setClipboard({ op: "cut", paths: list });
      flashClipboardTip("已剪切");
      // cut=true：写 Windows DropEffect 剪切标志，资源管理器粘贴时按移动处理
      void clipboardWriteFiles(list, true).catch(() => {});
    },
    [activePane, flashClipboardTip],
  );

  /** 弹出冲突裁决弹窗，等待用户完成全部裁决；返回方案或 null（停止） */
  const promptConflicts = useCallback(
    (conflicts: TransferConflict[]) =>
      new Promise<ResolutionPlan | null>((resolve) => {
        conflictResolver.current = resolve;
        setConflictReq(conflicts);
      }),
    [],
  );

  const finishConflicts = useCallback((plan: ResolutionPlan | null) => {
    setConflictReq(null);
    const resolve = conflictResolver.current;
    conflictResolver.current = null;
    resolve?.(plan);
  }, []);

  /**
   * 带冲突裁决的复制/移动。先扫描同名冲突，弹窗收集裁决，再执行。
   * 返回 null 表示用户「停止」或无需操作。
   *
   * v0.28.0 目录复制语义（仅 copy）：
   * - 跨目录（目标 ≠ 源父目录，如另一窗格/另一文件夹）复制目录 → 同名冲突一律**覆盖**，不再逐条询问；
   * - 同目录复制（目标 = 源父目录，含 Ctrl+D 原位副本）遇同名目录 → 三选一询问：
   *   「覆盖」递归合并进原目录 / 「新增目录」按 `name (2)` 建议名新建副本 / 取消则跳过这些目录（其余条目照常）。
   * 文件冲突（含目录 vs 文件类型冲突）仍走冲突裁决弹窗。
   */
  const runTransfer = useCallback(
    async (
      op: "copy" | "move",
      paths: string[],
      dest: string,
    ): Promise<{ created?: string[]; moved?: [string, string][] } | null> => {
      const [conflicts, dups] = await Promise.all([
        scanConflicts(paths, dest),
        op === "copy" && paths.every((p) => !isSftpPath(p))
          ? scanDirDuplicates(paths, dest).catch(() => [] as DirDuplicate[])
          : Promise.resolve([] as DirDuplicate[]),
      ]);
      let plan: ResolutionPlan = {};
      let execPaths = paths;
      if (op === "copy") {
        const scheme = pathScheme(dest);
        /** 冲突条目所属的顶层源路径（conflict.src 在某顶层 src 的子树内） */
        const topOf = (src: string): string => {
          let best = src;
          let bestLen = -1;
          for (const p of paths) {
            if (p === src || scheme.under(src, p) !== null) {
              if (p.length > bestLen) {
                best = p;
                bestLen = p.length;
              }
            }
          }
          return best;
        };
        const dupTops = new Set(dups.map((d) => d.src));
        /** 冲突分拣：目录复制覆盖 / 其余进裁决弹窗 / 同名目录重复由「新增目录」接管 */
        const remaining: TransferConflict[] = [];
        for (const c of conflicts) {
          const top = topOf(c.src);
          if (dupTops.has(top)) continue; // 顶层同名目录 → 新增目录问题统一接管（改名后子树无冲突）
          const topDest = scheme.join(dest, basename(top));
          const drilled = (scheme.under(c.dest, topDest) ?? "") !== "";
          const isSameDir = scheme.under(parentPath(top), dest) === "";
          if (!isSameDir && (drilled || c.srcKind === "dir")) {
            // 跨目录复制目录 → 覆盖
            plan[c.dest] = { action: "overwrite" };
          } else {
            remaining.push(c);
          }
        }
        // 同目录复制遇同名目录 → 询问：覆盖（递归合并）/ 新增目录（`name (2)`）/ 取消跳过
        if (dups.length > 0) {
          const names = dups.map((d) => basename(d.src));
          const preview =
            names.slice(0, 5).join("、") + (names.length > 5 ? ` 等 ${dups.length} 项` : "");
          const choice = await appConfirmChoice({
            title: "目标已存在同名文件夹",
            message: `当前目录已存在同名文件夹：${preview}\n\n「覆盖」保留原文件夹，递归覆盖其中的同名内容；「新增目录」复制为自动命名的新文件夹（如「xx (2)」）；取消则跳过这些文件夹。`,
            confirmLabel: "新增目录",
            altLabel: "覆盖",
          });
          if (choice === "cancel") {
            // 取消 → 整体跳过这些同名目录（连同其子树）
            const skip = new Set(dups.map((d) => d.src));
            execPaths = paths.filter((p) => !skip.has(p));
          } else if (choice === "alt") {
            // 覆盖：dir→dir 的 overwrite 在后端即递归合并，子树内同名文件按覆盖处理
            for (const d of dups) {
              plan[scheme.join(dest, basename(d.src))] = { action: "overwrite" };
            }
          } else {
            for (const d of dups) {
              plan[scheme.join(dest, basename(d.src))] = { action: "rename", name: d.suggest };
            }
          }
        }
        if (remaining.length > 0) {
          const decision = await promptConflicts(remaining);
          if (!decision) return null;
          plan = { ...plan, ...decision };
        }
      } else if (conflicts.length > 0) {
        const decision = await promptConflicts(conflicts);
        if (!decision) return null;
        plan = decision;
      }
      if (op === "move") {
        return { moved: await moveEntriesPlan(execPaths, dest, plan) };
      }
      if (execPaths.length === 0) return { created: [] };
      return { created: await copyEntriesPlan(execPaths, dest, plan) };
    },
    [promptConflicts, appConfirmChoice],
  );

  /** 删除文件夹确认弹窗 */
  const [confirmDelete, setConfirmDelete] = useState<{
    paneId: number;
    paths: string[];
    /** 参与统计与展示的条目（缺失的路径合成占位条目） */
    entries: FileEntry[];
  } | null>(null);

  /** v0.16 属性弹窗：右键「属性」选中的条目（目录递归统计大小） */
  const [propertiesEntries, setPropertiesEntries] = useState<FileEntry[] | null>(null);

  /** v0.17 差异比对窗口：左右两个本地目录 */
  const [diffTarget, setDiffTarget] = useState<{
    tabId: number;
    left: string;
    right: string;
    leftPane: number;
    rightPane: number;
  } | null>(null);

  // ==================== v0.19 文本比较（任意两文件 / git diff 解析） ====================

  /** 文本比较窗口来源 */
  const [textDiffSource, setTextDiffSource] = useState<TextDiffSource | null>(null);
  /** 比较基准（跨窗格全局状态，与应用内剪贴板同模式；不随会话保存） */
  const [compareBase, setCompareBase] = useState<{
    path: string;
    name: string;
    tabId: number;
    paneId: number;
  } | null>(null);
  /** 「与另一文件比较…」选择器：当前基准侧条目 */
  const [comparePickFor, setComparePickFor] = useState<FileEntry | null>(null);
  /** Git Diff 粘贴导入对话框 */
  const [gitDiffOpen, setGitDiffOpen] = useState(false);
  /** v0.19 设/清基准的状态栏右下角瞬时提示 */
  const [compareBaseHint, setCompareBaseHint] = useState<string | null>(null);
  const compareBaseHintTimer = useRef<number | null>(null);
  const showCompareBaseHint = useCallback((text: string) => {
    setCompareBaseHint(text);
    if (compareBaseHintTimer.current) window.clearTimeout(compareBaseHintTimer.current);
    compareBaseHintTimer.current = window.setTimeout(() => setCompareBaseHint(null), 2600);
  }, []);

  const openTextDiff = useCallback(
    (left: string, right: string, leftLabel?: string, rightLabel?: string) => {
      setTextDiffSource({ kind: "files", left, right, leftLabel, rightLabel });
    },
    [],
  );

  const handleSetCompareBase = useCallback(
    (entry: FileEntry, paneId: number) => {
      if (compareBase && compareBase.path === entry.path) {
        setCompareBase(null);
        showCompareBaseHint("已清除比较基准");
        return;
      }
      const tabId = tabsRef.current.find((t) => !!t.panes[paneId])?.id ?? -1;
      setCompareBase({ path: entry.path, name: entry.name, tabId, paneId });
      showCompareBaseHint(`已设为比较基准：${entry.name}`);
    },
    [compareBase, showCompareBaseHint],
  );

  const handleClearCompareBase = useCallback(() => {
    setCompareBase(null);
    showCompareBaseHint("已清除比较基准");
  }, [showCompareBaseHint]);

  const handleCompareWithBase = useCallback(
    (entry: FileEntry) => {
      if (!compareBase) {
        showError("未设置比较基准：请先在另一个文件上右键「设为比较基准」");
        return;
      }
      if (compareBase.path === entry.path) {
        showError("与基准是同一个文件，无需比较");
        return;
      }
      openTextDiff(compareBase.path, entry.path, compareBase.name, entry.name);
    },
    [compareBase, showError, openTextDiff],
  );

  const handleCompareSelected = useCallback(
    (paths: [string, string]) => {
      const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
      openTextDiff(paths[0], paths[1], base(paths[0]), base(paths[1]));
    },
    [openTextDiff],
  );

  /** 选择器候选窗格：所有窗格当前目录的文件（读内存列表，零 IO） */
  const comparePickPanes = useMemo<ComparePickPane[]>(() => {
    if (!comparePickFor) return [];
    const out: ComparePickPane[] = [];
    for (const t of tabs) {
      for (const pid of collectPaneIds(t.root)) {
        const p = t.panes[pid];
        if (!p || p.tagId) continue;
        out.push({
          key: `${t.id}:${pid}`,
          title: t.customTitle ?? t.title,
          path: p.path,
          files: p.entries
            .filter((e) => !e.is_dir && e.path !== comparePickFor.path)
            .map((e) => ({ name: e.name, path: e.path })),
        });
      }
    }
    return out;
  }, [tabs, comparePickFor]);

  // ==================== v0.18 同步浏览 + 实时比对面板 ====================

  /** 链接状态（不随会话保存，D8）：开启即记录两侧锚点，随导航实时重算比对。
   *  v0.25.1 按标签保存：每个标签各自开关、互不影响，活动标签的链接驱动
   *  镜像/比对/状态栏/结果模态。旧实现是全局单例 + tabId 锚定，切到其他标签后
   *  开关仍显示开启但实际只对原标签生效（显示与行为不一致）。 */
  const [syncLinks, setSyncLinks] = useState<Record<number, SyncLink>>({});
  const syncLinksRef = useRef<Record<number, SyncLink>>({});
  syncLinksRef.current = syncLinks;
  /** 活动标签的链接 */
  const syncLink = activeTab ? (syncLinks[activeTab.id] ?? null) : null;
  const syncLinkRef = useRef<SyncLink | null>(null);
  syncLinkRef.current = syncLink;
  /** 实时比对运行状态（seq 丢弃过期响应） */
  const [syncRun, setSyncRun] = useState<{
    status: "running" | "done" | "cancelled" | "error";
    entries: DiffEntry[] | null;
    error?: string;
  } | null>(null);
  const syncSeqRef = useRef(0);
  const syncDiffIdRef = useRef<string | null>(null);
  /** v0.18.2 结果模态开关(状态栏段/Ctrl+Shift+X) */
  const [syncResultsOpen, setSyncResultsOpen] = useState(false);

  /** 断开指定标签的链接（toggle 的 off 分支与结果模态「断开链接」共用） */
  const unlinkSync = useCallback((tabId: number) => {
    setSyncLinks((ls) => {
      if (!(tabId in ls)) return ls;
      const next = { ...ls };
      delete next[tabId];
      return next;
    });
  }, []);

  /** v0.18 开启/断开同步比对：要求活动标签恰好两个路径窗格（排除 http 与标签视图）。
   *  v0.25.1 只影响当前标签，其他标签各自的链接不动 */
  const toggleSyncDiff = useCallback(() => {
    if (!activeTab) return;
    if (syncLinksRef.current[activeTab.id]) {
      unlinkSync(activeTab.id);
      // v0.21.1 开/断开同步比对给中央提示（状态栏 pill 太小，新用户难发现）
      flashClipboardTip("已断开同步比对", 1200);
      return;
    }
    const panes = collectPaneIds(activeTab.root)
      .map((id) => activeTab.panes[id])
      .filter((p): p is NonNullable<typeof p> => !!p && !p.tagId && !isHttpPath(p.path));
    if (panes.length !== 2) {
      showError("同步比对需要当前标签恰好两个路径窗格");
      return;
    }
    setSyncLinks((ls) => ({
      ...ls,
      [activeTab.id]: {
        tabId: activeTab.id,
        leftPaneId: panes[0].id,
        rightPaneId: panes[1].id,
        leftRoot: panes[0].path,
        rightRoot: panes[1].path,
      },
    }));
    flashClipboardTip(
      `已开启同步比对：左右窗格联动导航（${isMac ? "⌘+⇧+X" : "Ctrl+Shift+X"} 查看结果）`,
      2400,
    );
  }, [activeTab, unlinkSync, showError, flashClipboardTip]);

  /** 链接的两个窗格与其对齐状态（窗格被关闭时为 null，由下方 effect 断链） */
  const syncPanes = (() => {
    if (!syncLink) return null;
    const tab = tabs.find((t) => t.id === syncLink.tabId);
    const lp = tab?.panes[syncLink.leftPaneId];
    const rp = tab?.panes[syncLink.rightPaneId];
    if (!tab || !lp || !rp) return null;
    return { tab, lp, rp, alignment: computeAlignment(syncLink, lp.path, rp.path) };
  })();

  /** 任一标签的链接窗格不存在（关窗格/关标签）→ 移除该标签的链接 */
  useEffect(() => {
    const stale = Object.values(syncLinks).filter((l) => {
      const t = tabs.find((x) => x.id === l.tabId);
      return !t || !(l.leftPaneId in t.panes) || !(l.rightPaneId in t.panes);
    });
    if (stale.length === 0) return;
    setSyncLinks((ls) => {
      const next = { ...ls };
      for (const l of stale) delete next[l.tabId];
      return next;
    });
  }, [tabs, syncLinks]);
  /** 断链时取消在途比对、清空面板状态并关闭结果模态 */
  useEffect(() => {
    if (syncLink) return;
    const id = syncDiffIdRef.current;
    if (id) {
      syncDiffIdRef.current = null;
      void cancelDiff(id).catch(() => {});
    }
    setSyncRun(null);
    setSyncResultsOpen(false);
  }, [syncLink]);

  /** 镜像跟随（方案 A1）：监听链接窗格路径变化（覆盖地址栏/侧栏/前进后退/双击定位等一切导航入口）。
   *  一侧变化 → 探测对侧同名相对目录：成功则跟随（推对侧历史）；失败则未对齐（对侧原地，D3）。 */
  const mirrorPrevRef = useRef<{
    link: SyncLink | null;
    left: string | null;
    right: string | null;
  }>({ link: null, left: null, right: null });
  useEffect(() => {
    const link = syncLink;
    const tab = link ? tabs.find((t) => t.id === link.tabId) : undefined;
    const lp = link ? tab?.panes[link.leftPaneId] : undefined;
    const rp = link ? tab?.panes[link.rightPaneId] : undefined;
    const st = mirrorPrevRef.current;
    if (!link || !lp || !rp) {
      mirrorPrevRef.current = { link, left: lp?.path ?? null, right: rp?.path ?? null };
      return;
    }
    if (st.link !== link) {
      // 链接建立/交换/改锚点：仅重置基线，不触发跟随
      mirrorPrevRef.current = { link, left: lp.path, right: rp.path };
      return;
    }
    const leftMoved = st.left !== null && lp.path !== st.left;
    const rightMoved = st.right !== null && rp.path !== st.right;
    mirrorPrevRef.current = { link, left: lp.path, right: rp.path };
    if (leftMoved === rightMoved) return;
    const side: LinkSide = leftMoved ? "left" : "right";
    const movedPath = leftMoved ? lp.path : rp.path;
    const rel = relOf(link, side, movedPath);
    if (rel === null) return; // 一侧越出锚点子树：不镜像，面板横幅提示
    const otherSide: LinkSide = side === "left" ? "right" : "left";
    const candidate = mirrorPath(link, otherSide, rel);
    const otherPath = otherSide === "left" ? lp.path : rp.path;
    if (candidate === otherPath) return; // 已对齐（镜像回声自检，防自激）
      void listDir(candidate)
        .then((entries) => {
          // 该标签的链接已被断开/交换/改锚（对象身份变化）→ 丢弃过期跟随
          if (syncLinksRef.current[link.tabId] !== link) return;
          const otherId = otherSide === "left" ? link.leftPaneId : link.rightPaneId;
        setTabs((ts) =>
          ts.map((t) => {
            if (!(otherId in t.panes)) return t;
            const pane = t.panes[otherId];
            const same = pane.path === candidate;
            const history = same
              ? pane.history
              : [...pane.history.slice(0, pane.histIndex + 1), candidate];
            const updated = {
              ...pane,
              path: candidate,
              title: basename(candidate),
              history,
              histIndex: history.length - 1,
              selection: [],
              entries,
              loading: false,
              error: null,
            };
            const title = t.activePane === otherId ? updated.title : t.title;
            return { ...t, panes: { ...t.panes, [otherId]: updated }, title };
          }),
        );
      })
      .catch(() => {
        // 对侧无同名目录：未对齐，对侧停在原地（D3），面板回退共同层
      });
  }, [tabs, syncLink]);

  /** 实时比对管线：任一链接窗格 path/refreshKey 变化 → 防抖 120ms → 取消在途 → 重算（D2 关键：
   *  边浏览边比对，比对只针对当前对齐层/共同层，层级按两侧后端能力钳制） */
  useEffect(() => {
    if (!syncPanes) return;
    // 传输（上传/下载/复制/移动/压缩）进行中挂起比对：拖拽上传后的窗格刷新
    // 不再让面板反复闪「比对中…」，传输结束（syncKick）后统一比对一轮
    if (transferRef.current) return;
    const { leftDir, rightDir } = syncPanes.alignment;
    const level = maxDiffLevelFor(leftDir, rightDir);
    const caseSensitive = loadDiffCaseSensitive();
    const mtimeToleranceMs = loadDiffMtimeTolerance() * 1000;
    let disposed = false;
    const timer = window.setTimeout(() => {
      if (disposed) return;
      const prevId = syncDiffIdRef.current;
      if (prevId) void cancelDiff(prevId).catch(() => {});
      const seq = ++syncSeqRef.current;
      const id = `syncdiff-${Date.now()}-${seq}`;
      syncDiffIdRef.current = id;
      setSyncRun({ status: "running", entries: null });
      diffDirs(id, leftDir, rightDir, level, caseSensitive, mtimeToleranceMs)
        .then((outcome) => {
          if (disposed || seq !== syncSeqRef.current) return;
          setSyncRun(
            outcome.cancelled
              ? { status: "cancelled", entries: outcome.entries }
              : { status: "done", entries: outcome.entries },
          );
        })
        .catch((e) => {
          if (disposed || seq !== syncSeqRef.current) return;
          setSyncRun({ status: "error", entries: null, error: String(e) });
        });
    }, 120);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    syncLink,
    syncPanes?.lp.path,
    syncPanes?.lp.refreshKey,
    syncPanes?.rp.path,
    syncPanes?.rp.refreshKey,
    syncKick,
  ]);

  /** 程序化导航任意窗格（面板按钮用）：加载条目 + 推历史 + 激活 */
  const gotoPane = useCallback(
    async (paneId: number, path: string) => {
      let entries: FileEntry[];
      try {
        entries = await listDir(path);
      } catch (e) {
        showError(`无法进入 ${path}：${String(e)}`);
        return;
      }
      setTabs((ts) =>
        ts.map((t) => {
          if (!(paneId in t.panes)) return t;
          const pane = t.panes[paneId];
          const same = pane.path === path;
          const history = same
            ? pane.history
            : [...pane.history.slice(0, pane.histIndex + 1), path];
          const updated = {
            ...pane,
            path,
            title: basename(path),
            history,
            histIndex: history.length - 1,
            selection: [],
            entries,
            loading: false,
            error: null,
          };
          const title = t.activePane === paneId ? updated.title : t.title;
          return { ...t, activePane: paneId, panes: { ...t.panes, [paneId]: updated }, title };
        }),
      );
    },
    [showError],
  );

  /** [重新对齐]：两侧各跳回链接锚点 */
  const realignSync = useCallback(() => {
    const link = syncLinkRef.current;
    if (!link) return;
    void gotoPane(link.leftPaneId, link.leftRoot).then(() =>
      gotoPane(link.rightPaneId, link.rightRoot),
    );
  }, [gotoPane]);

  /** [交换左右]：交换链接的左右方位后重算 */
  const swapSyncSides = useCallback(() => {
    const link = syncLinkRef.current;
    if (!link) return;
    setSyncLinks((ls) => {
      if (ls[link.tabId] !== link) return ls;
      return {
        ...ls,
        [link.tabId]: {
          tabId: link.tabId,
          leftPaneId: link.rightPaneId,
          rightPaneId: link.leftPaneId,
          leftRoot: link.rightRoot,
          rightRoot: link.leftRoot,
        },
      };
    });
  }, []);

  /** [返回对齐]：wanderer 跳到对侧当前位置在其根下的镜像 */
  const returnToAlignment = useCallback(() => {
    const link = syncLinkRef.current;
    if (!link) return;
    const tab = tabsRef.current.find((t) => t.id === link.tabId);
    if (!tab) return;
    const lp = tab.panes[link.leftPaneId];
    const rp = tab.panes[link.rightPaneId];
    if (!lp || !rp) return;
    const a = computeAlignment(link, lp.path, rp.path);
    if (a.state !== "diverged" || !a.missingSide) return;
    const wSide = a.missingSide;
    const oSide: LinkSide = wSide === "left" ? "right" : "left";
    const oPath = oSide === "left" ? lp.path : rp.path;
    const rel = relOf(link, oSide, oPath);
    if (rel === null) return;
    const wPaneId = wSide === "left" ? link.leftPaneId : link.rightPaneId;
    void gotoPane(wPaneId, mirrorPath(link, wSide, rel));
  }, [gotoPane]);

  /** [在对侧新建并进入]：在缺失侧逐级创建目录后进入（本特性唯一的远程写入点，D6） */
  const createMissingAndEnter = useCallback(async () => {
    const link = syncLinkRef.current;
    if (!link) return;
    const tab = tabsRef.current.find((t) => t.id === link.tabId);
    if (!tab) return;
    const lp = tab.panes[link.leftPaneId];
    const rp = tab.panes[link.rightPaneId];
    if (!lp || !rp) return;
    const a = computeAlignment(link, lp.path, rp.path);
    if (a.state !== "diverged" || !a.missing || !a.missingSide) return;
    const wSide = a.missingSide; // wanderer：该目录已存在的一侧
    const oSide: LinkSide = wSide === "left" ? "right" : "left";
    const fullRel = a.layer ? `${a.layer}/${a.missing}` : a.missing;
    const target = mirrorPath(link, oSide, fullRel);
    if (!backendCaps(backendKind(target)).canMkdir) {
      showError("该后端不支持创建目录");
      return;
    }
    // 共同层在对侧已存在，只需逐级创建缺失段
    let parent = mirrorPath(link, oSide, a.layer);
    try {
      for (const seg of a.missing.split("/")) {
        const created = isSftpPath(parent)
          ? await sftpMkdir(parent, seg)
          : await createDir(parent, seg);
        parent = created || pathScheme(target).join(parent, seg);
      }
    } catch (e) {
      showError(`在对侧创建目录失败：${String(e)}`);
      return;
    }
    await gotoPane(oSide === "left" ? link.leftPaneId : link.rightPaneId, target);
  }, [showError, gotoPane]);

  /** 行内标注：仅当窗格正处比对层时传入（未对齐时 wanderer 更深层不标）。
   *  依赖取原始值 + useMemo：syncPanes 每次渲染都是新对象，直接依赖会击穿 PaneView 的 memo。 */
  const lpPath = syncPanes?.lp.path;
  const rpPath = syncPanes?.rp.path;
  const alignLeftDir = syncPanes?.alignment.leftDir;
  const alignRightDir = syncPanes?.alignment.rightDir;
  const syncMarks: Record<number, DiffMarkMap> = useMemo(() => {
    if (
      !syncLink ||
      lpPath === undefined ||
      rpPath === undefined ||
      !syncRun ||
      syncRun.status !== "done" ||
      !syncRun.entries
    ) {
      return {};
    }
    const marks = marksFromOutcome(syncRun.entries);
    const out: Record<number, DiffMarkMap> = {};
    if (lpPath === alignLeftDir) out[syncLink.leftPaneId] = marks;
    if (rpPath === alignRightDir) out[syncLink.rightPaneId] = marks;
    return out;
  }, [syncLink, syncRun, lpPath, rpPath, alignLeftDir, alignRightDir]);
  /** 表头链接标识：链接窗格的方位 */
  const syncBadges: Record<number, LinkSide> = useMemo(
    () => (syncLink ? { [syncLink.leftPaneId]: "left", [syncLink.rightPaneId]: "right" } : {}),
    [syncLink],
  );
  /** 「在对侧新建并进入」是否可用：对侧后端 canMkdir */
  const canCreateMissing = (() => {
    if (!syncPanes || syncPanes.alignment.state !== "diverged") return false;
    const a = syncPanes.alignment;
    if (!a.missing || !a.missingSide) return false;
    const oSide: LinkSide = a.missingSide === "left" ? "right" : "left";
    const fullRel = a.layer ? `${a.layer}/${a.missing}` : a.missing;
    const target = syncLink ? mirrorPath(syncLink, oSide, fullRel) : "";
    return backendCaps(backendKind(target)).canMkdir;
  })();
  /** 状态栏摘要:差异数(status !== same 的条目) */
  const syncDiffCount = syncRun?.entries
    ? syncRun.entries.reduce((n, e) => (e.status !== "same" ? n + 1 : n), 0)
    : 0;

  /** v0.18 差异窗口双击定位：在对应窗格进入父目录并选中该条目 */
  const locateFromDiff = useCallback(
    (side: "left" | "right", path: string, isDir: boolean) => {
      if (!diffTarget) return;
      const tabId = diffTarget.tabId;
      const paneId = side === "left" ? diffTarget.leftPane : diffTarget.rightPane;
      const dir = isDir ? path : parentPath(path);
      setActiveId(tabId);
      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== tabId) return t;
          const pane = t.panes[paneId];
          if (!pane) return t;
          const sameDir = pane.path === dir;
          const history = sameDir
            ? pane.history
            : [...pane.history.slice(0, pane.histIndex + 1), dir];
          const updated = {
            ...pane,
            path: dir,
            title: basename(dir),
            history,
            histIndex: history.length - 1,
            selection: isDir ? [] : [path],
            ...(sameDir ? {} : { entries: [], loading: true }),
          };
          const title = t.activePane === paneId ? updated.title : t.title;
          return {
            ...t,
            activePane: paneId,
            panes: { ...t.panes, [paneId]: updated },
            title,
          };
        }),
      );
    },
    [diffTarget],
  );

  /** 文件标签（path → tagId[]，持久化） */
  const [fileTags, setFileTags] = useState<FileTags>(() => loadFileTags());
  // 自定义标签名（v0.6.4 右键重命名）
  const [tagNames, setTagNames] = useState<TagNames>(() => loadTagNames());
  const renameTag = useCallback((tagId: string, label: string) => {
    setTagNames((prev) => {
      const next = { ...prev, [tagId]: label.trim() };
      saveTagNames(next);
      return next;
    });
  }, []);
  // v0.28.0 用户新增的自定义标签（预设之上，总数上限 MAX_TAGS）
  const [customTags, setCustomTags] = useState<TagDef[]>(() => loadCustomTags());
  const tags = useMemo(() => allTags(customTags), [customTags]);
  const addTag = useCallback(
    (def: TagDef): boolean => {
      if (customTags.length + TAG_DEFS.length >= MAX_TAGS) {
        showError(`标签最多 ${MAX_TAGS} 个（含预设），已达上限`);
        return false;
      }
      setCustomTags((prev) => {
        const next = [...prev, def];
        saveCustomTags(next);
        return next;
      });
      return true;
    },
    [customTags, showError],
  );
  const tagsFullHint = useCallback(
    () => showError(`标签最多 ${MAX_TAGS} 个（含预设），已达上限`),
    [showError],
  );
  /** 自定义快捷访问（持久化）；上限 10 个（v0.28.0），加满后提醒 */
  const [customQuick, setCustomQuick] = useState<string[]>(() => loadCustomQuick());
  const toggleQuick = useCallback(
    (path: string) => {
      setCustomQuick((prev) => {
        if (!prev.includes(path) && prev.length >= MAX_QUICK) {
          showError(`快速访问最多添加 ${MAX_QUICK} 个，已达上限`);
          return prev;
        }
        const next = prev.includes(path)
          ? prev.filter((p) => p !== path)
          : [...prev, path];
        saveCustomQuick(next);
        return next;
      });
    },
    [showError],
  );
  /** v0.31.1 条目显示别名（只读后端条目在标签视图/快捷访问里的"改名"落点，持久化） */
  const [entryAliases, setEntryAliases] = useState<EntryAliases>(() => loadEntryAliases());
  const setEntryAlias = useCallback((path: string, label: string) => {
    setEntryAliases((prev) => {
      const v = label.trim();
      const next = { ...prev };
      // 改回与本名相同 / 清空 = 删除别名
      if (!v || v === entryDisplayName(path, {})) delete next[path];
      else next[path] = v;
      saveEntryAliases(next);
      return next;
    });
  }, []);
  /** v0.14 显示文件扩展名（默认显示，持久化） */
  const [showExtensions, setShowExtensions] = useState<boolean>(() => loadShowExtensions());
  const toggleExtensions = useCallback(() => {
    setShowExtensions((v) => {
      const nv = !v;
      saveShowExtensions(nv);
      return nv;
    });
  }, []);

  const toggleTag = useCallback((path: string, tagId: string) => {
    setFileTags((prev) => {
      const cur = prev[path] ?? [];
      const next = cur.includes(tagId)
        ? cur.filter((t) => t !== tagId)
        : [...cur, tagId];
      const t = { ...prev, [path]: next };
      if (next.length === 0) delete t[path];
      saveFileTags(t);
      return t;
    });
  }, []);

  /** 该标签下的所有文件路径（用于侧边栏计数与 TagView 列表） */
  const tagPaths = useCallback(
    (tagId: string): string[] =>
      Object.entries(fileTags)
        .filter(([, tags]) => tags.includes(tagId))
        .map(([p]) => p),
    [fileTags],
  );

  /**
   * 标签视图中重命名条目（v0.31：标签作用于文件夹后可就地改名本体）。
   * 改名后迁移 fileTags / 快捷访问 / 别名里指向旧本体/旧子路径的键——目录改名
   * 会让其下已打标签的子条目整体失效，不做迁移标签就"丢了"。
   *
   * v0.31.1：HTTP autoindex 是只读后端，本体改不了 → 改显示别名（标签视图与快捷访问同步显示）；
   * SFTP 条目先自动连接所属服务器（已保存凭据静默重连，否则弹连接/主密钥框）再改本体。
   */
  const renameTagEntry = useCallback(
    async (path: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      if (isHttpPath(path)) {
        if (trimmed === entryDisplayName(path, entryAliases)) return;
        setEntryAlias(path, trimmed);
        flashClipboardTip("已更新显示名（HTTP 目录为只读，不改远程本体）", 1800);
        return;
      }
      if (trimmed === basename(path)) return;
      if (isSftpPath(path) && !(await sftp.ensureConnected(path))) return;
      try {
        const newPath = isSftpPath(path)
          ? await sftpRename(path, trimmed)
          : await renameEntry(path, trimmed);
        setFileTags((prev) => {
          const next: FileTags = {};
          let changed = false;
          for (const [k, v] of Object.entries(prev)) {
            const nk = remapPrefixedPath(k, path, newPath);
            if (nk !== k) changed = true;
            next[nk] = v;
          }
          if (changed) saveFileTags(next);
          return changed ? next : prev;
        });
        setCustomQuick((prev) => {
          let changed = false;
          const next = prev.map((k) => {
            const nk = remapPrefixedPath(k, path, newPath);
            if (nk !== k) changed = true;
            return nk;
          });
          if (changed) saveCustomQuick(next);
          return changed ? next : prev;
        });
        setEntryAliases((prev) => {
          const next: EntryAliases = {};
          let changed = false;
          for (const [k, v] of Object.entries(prev)) {
            const nk = remapPrefixedPath(k, path, newPath);
            if (nk !== k) changed = true;
            next[nk] = v;
          }
          if (changed) saveEntryAliases(next);
          return changed ? next : prev;
        });
        // 刷新正显示旧条目父目录的窗格
        const parent = parentPath(path);
        tabs
          .flatMap((t) => Object.values(t.panes))
          .filter((pane) => pane.path === parent)
          .forEach((pane) => refreshPane(pane.id));
      } catch (e) {
        showError(String(e));
      }
    },
    [tabs, refreshPane, showError, entryAliases, setEntryAlias, flashClipboardTip, sftp],
  );

  /** 撤销/重做栈：只记录可安全反向的操作 */
  const pushOp = useCallback((op: FileOp) => {
    setUndoStack((s) => [...s.slice(-49), op]);
    setRedoStack([]);
  }, []);

  /** 粘贴进行中标志：连续触发（连点/双入口）不再并发跑第二轮——
   *  两轮写同一目标时，后失败的一轮会破坏先成功的一轮的产物 */
  const pasteBusyRef = useRef(false);

  /** 最新一轮 doPasteInner 引用：包装层经它调用，避免稳定 useCallback 捕获过期状态 */
  const doPasteLatestRef = useRef<(paneId?: number) => Promise<void> | null>(null);

  /** 包装层（对外暴露的 doPaste）：防重入 + 转发到最新实现 */
  const doPaste = useCallback(async (paneId?: number) => {
    if (pasteBusyRef.current) return;
    pasteBusyRef.current = true;
    try {
      await doPasteLatestRef.current?.(paneId);
    } finally {
      pasteBusyRef.current = false;
    }
  }, []);

  const doPasteInner = useCallback(
    async (paneId?: number) => {
      const pid = paneId ?? activePane?.id;
      if (pid === undefined) return;
      const pane = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === pid);
      if (!pane) return;
      const dest = pane.path;
      // 优先应用内剪贴板；为空则读系统剪贴板文件列表（跨应用粘贴）
      let op: "copy" | "cut" = clipboard?.op ?? "copy";
      let srcs = clipboard?.paths ?? [];
      // 剪切数据是否来自系统剪贴板：移动成功后需清空，避免残留失效剪切项
      let fromSystem = false;
      if (srcs.length === 0) {
        const sys = await clipboardReadFiles().catch(() => null);
        if (!sys || sys.paths.length === 0) return;
        srcs = sys.paths;
        op = sys.cut ? "cut" : "copy";
        fromSystem = sys.cut;
      }
      const isCut = op === "cut";
      const localSrcs = srcs.filter((p) => !isSftpPath(p));
      const sftpSrcs = srcs.filter((p) => isSftpPath(p));
      const destIsSftp = isSftpPath(dest);
      /** 实际落点（含冲突改名后的路径）：粘贴完成后定位 + 选中 */
      const pasted: string[] = [];
      try {
        if (destIsSftp) {
          // 目标远程：仅支持本地 → 远程上传；远程→远程暂不支持
          if (sftpSrcs.length > 0) {
            showError("双端远程传输暂不支持（方案已评估保留）");
            if (localSrcs.length === 0) return;
          }
          for (const src of localSrcs) {
            await sftpUpload(src, dest, basename(src));
            pasted.push(dest.endsWith("/") ? dest + basename(src) : `${dest}/${basename(src)}`);
          }
        setClipboard(null);
        if (pasted.length > 0) pendingSelectRef.current = pasted;
          refreshPane(pid);
          return;
        }
        // 目标本地
        for (const src of sftpSrcs) {
          const local = await sftpDownloadTo(dest, src);
          if (local) pasted.push(local);
        }
        if (localSrcs.length > 0) {
          const r = await runTransfer(isCut ? "move" : "copy", localSrcs, dest);
          if (r === null) return; // 用户「停止」：保留剪贴板，不清理
          if (r.moved) {
            pushOp({ kind: "move", pairs: r.moved, dest, srcPane: pid, destPane: pid });
            pasted.push(...r.moved.map(([, to]) => to));
            // 消费外部剪切：源已移走，清空系统剪贴板（与资源管理器行为一致）
            if (isCut && fromSystem) void clipboardClearFiles().catch(() => {});
          } else if (r.created) {
            pushOp({
              kind: "copy",
              src: localSrcs,
              created: r.created,
              dest,
              srcPane: pid,
              destPane: pid,
            });
            pasted.push(...r.created);
          }
        }
        if (sftpSrcs.length > 0 && localSrcs.length === 0 && isCut) {
          // 纯远程剪切粘贴：v0.2 按复制处理（不删源）
          showError("远程剪切暂按复制处理（不删除源文件）");
        }
        setClipboard(null);
        if (pasted.length > 0) {
          if (activePane && pid === activePane.id) {
            // 活动窗格：待列表刷新后定位选中（见目录加载 effect 的 pending 消费）
            pendingSelectRef.current = pasted;
          } else {
            // 非活动窗格兜底：直接写选中，条目在其被激活加载时仍然成立
            setTabs((ts) =>
              ts.map((t) => {
                const pane = t.panes[pid];
                if (!pane) return t;
                return { ...t, panes: { ...t.panes, [pid]: { ...pane, selection: pasted } } };
              }),
            );
          }
        }
        refreshPane(pid);
      } catch (e) {
        // 取消传输不算错误，收敛为轻提示；剪贴板保留可继续粘贴。
        // 真失败（覆盖被拒 / 源被占用…）走中央红色浮层——此前只有状态栏一行小字，
        // 还被 1.5 秒的传输完成帧盖住，用户以为「没反应」。
        showTransferError(e);
      }
    },
    [clipboard, activePane, tabs, refreshPane, showError, showTransferError, pushOp, isSftpPath, runTransfer],
  );
  doPasteLatestRef.current = doPasteInner;

  /** 复制到当前目录（Duplicate） */
  const doDuplicate = useCallback(async () => {
    if (!activePane || activePane.selection.length === 0) return;
    const paneId = activePane.id;
    const dest = activePane.path;
    if (isSftpPath(dest)) {
      showError("远程复制暂不支持（可拖拽到其他窗格）");
      return;
    }
    try {
      const r = await runTransfer("copy", activePane.selection, dest);
      if (!r || !r.created) return; // 用户「停止」
      pushOp({
        kind: "copy",
        src: activePane.selection,
        created: r.created,
        dest,
        srcPane: paneId,
        destPane: paneId,
      });
      refreshPane(paneId);
    } catch (e) {
      showTransferError(e);
    }
  }, [activePane, refreshPane, showError, showTransferError, pushOp, runTransfer]);

  /** 跨窗格拖拽落盘：目标 pane 的路径执行复制/移动，源、目标均刷新 */
  /** 拖拽落盘核心（v0.27 从 doDropPaths 抽出）：dest 显式给定——跨窗格投放 =
   * 目标窗格当前目录；大图标「拖到文件夹上」= 被投放的文件夹路径。 */
  const transferPaths = useCallback(
    async (
      sourcePaneId: number,
      paths: string[],
      op: "copy" | "move",
      dest: string,
      refreshIds: number[],
      destPaneId: number,
    ) => {
      const srcIsSftp = paths.some(isSftpPath);
      const destIsSftp = isSftpPath(dest);
      const srcIsHttp = paths.some(isHttpPath);
      const destIsHttp = isHttpPath(dest);
      try {
        // HTTP 为只读协议：远程间传输 / 上传一律拒绝
        if (srcIsHttp && destIsHttp) {
          showError("HTTP autoindex 为只读协议，不支持远程间传输");
          return;
        }
        if (srcIsHttp && destIsSftp) {
          showError("HTTP → SFTP 暂不支持");
          return;
        }
        if (!srcIsHttp && destIsHttp) {
          showError("HTTP autoindex 为只读协议，不支持上传");
          return;
        }
        // HTTP → 本地：下载
        if (srcIsHttp) {
          for (const p of paths) {
            await httpDownloadTo(dest, p);
          }
          refreshPanes(refreshIds);
          return;
        }
        // 远程 ⇄ 远程：暂不支持（方案已评估保留）
        if (srcIsSftp && destIsSftp) {
          showError("双端远程传输暂不支持");
          return;
        }
        // 远程 → 本地：下载。与 本地→远程 对称：目标已有同名条目先确认，
        // 确认后直接覆盖（默认的自动改名 " (n)" 仅保留给粘贴流程）（v0.22.0）
        if (srcIsSftp && !destIsSftp) {
          const destEntries = await listDir(dest).catch(() => [] as FileEntry[]);
          const destByName = new Map(destEntries.map((e) => [e.name, e] as const));
          const clashPaths = paths.filter((p) => destByName.has(basename(p)));
          let overwrite = false;
          if (clashPaths.length > 0) {
            let message: string;
            if (clashPaths.length === 1) {
              // v0.37 单文件覆盖附源/目标大小对比（SFTP 不查 MD5：远程算哈希代价高
              // 且不普遍支持）；任一侧目录或大小不可知 → 退回仅名单
              const p = clashPaths[0];
              const remoteEntry = await listDir(parentPath(p))
                .then((es) => es.find((e) => e.name === basename(p)))
                .catch(() => undefined);
              const destEntry = destByName.get(basename(p));
              const sizeLine =
                remoteEntry && destEntry && !remoteEntry.is_dir && !destEntry.is_dir
                  ? `源 ${formatSize(remoteEntry.size)}　目标 ${formatSize(destEntry.size)}`
                  : null;
              message = sizeLine
                ? `目标目录已有同名条目：${basename(p)}\n${sizeLine}`
                : `目标目录已有同名条目：${basename(p)}`;
            } else {
              message = `目标目录已有同名条目：${clashPaths.map(basename).slice(0, 5).join("、")}${
                clashPaths.length > 5 ? ` 等 ${clashPaths.length} 项` : ""
              }`;
            }
            // v0.28.0 应用内确认框（Windows 原生 confirm 是经典样式弹窗）
            const ok = await appConfirm({
              title: "覆盖下载",
              message,
              confirmLabel: "覆盖",
            });
            if (!ok) return;
            overwrite = true;
          }
          for (const p of paths) {
            await sftpDownloadTo(dest, p, overwrite);
          }
          refreshPanes(refreshIds);
          return;
        }
        // 本地 → 远程：上传。SFTP 写入用 FXF_TRUNC 会静默覆盖同名远程文件，
        // 先列目标目录核对，存在同名 → 用户确认后才传（v0.22.2）
        if (!srcIsSftp && destIsSftp) {
          const existing = await listDir(dest).catch(() => [] as FileEntry[]);
          const remoteByName = new Map(existing.map((e) => [e.name, e] as const));
          const clashPaths = paths.filter((p) => remoteByName.has(basename(p)));
          if (clashPaths.length > 0) {
            let message: string;
            if (clashPaths.length === 1) {
              // v0.37 单文件覆盖附源/目标大小对比（SFTP 不查 MD5）；查不到或涉及目录 → 退回仅名单
              const p = clashPaths[0];
              const localEntry = await statEntry(p).catch(() => undefined);
              const remoteEntry = remoteByName.get(basename(p));
              const sizeLine =
                localEntry && remoteEntry && !localEntry.is_dir && !remoteEntry.is_dir
                  ? `源 ${formatSize(localEntry.size)}　目标 ${formatSize(remoteEntry.size)}`
                  : null;
              message = sizeLine
                ? `目标目录已有同名条目：${basename(p)}\n${sizeLine}`
                : `目标目录已有同名条目：${basename(p)}`;
            } else {
              message = `目标目录已有同名条目：${clashPaths.map(basename).slice(0, 5).join("、")}${
                clashPaths.length > 5 ? ` 等 ${clashPaths.length} 项` : ""
              }`;
            }
            // v0.28.0 应用内确认框（Windows 原生 confirm 是经典样式弹窗）
            const ok = await appConfirm({
              title: "覆盖上传",
              message,
              confirmLabel: "覆盖",
              danger: true,
            });
            if (!ok) return;
          }
          for (const p of paths) {
            await sftpUpload(p, dest, basename(p));
          }
          refreshPanes(refreshIds);
          return;
        }
        // 本地 ⇄ 本地：带冲突裁决
        const r = await runTransfer(op, paths, dest);
        if (r === null) return; // 用户「停止」
        if (r.moved) {
          pushOp({ kind: "move", pairs: r.moved, dest, srcPane: sourcePaneId, destPane: destPaneId });
        } else if (r.created) {
          pushOp({
            kind: "copy",
            src: paths,
            created: r.created,
            dest,
            srcPane: sourcePaneId,
            destPane: destPaneId,
          });
        }
        refreshPanes(refreshIds);
      } catch (e) {
        showTransferError(e);
      }
    },
    [refreshPanes, showError, showTransferError, pushOp, runTransfer],
  );

  const doDropPaths = useCallback(
    async (sourcePaneId: number, paths: string[], op: "copy" | "move", targetPaneId: number) => {
      const target = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === targetPaneId);
      if (!target || target.path === "") return;
      await transferPaths(sourcePaneId, paths, op, target.path, [targetPaneId, sourcePaneId], targetPaneId);
    },
    [tabs, transferPaths],
  );

  /** v0.27 大图标模式「拖到文件夹图标上」：目标为任意目录路径（含同窗格内文件夹）。
   *  v0.31.2 起详情列表目录行同样接入（App 的 window drop 统一解析）；destPaneId
   *  是文件夹所在窗格（跨窗格投放时双方都要刷新），缺省 = 同窗格。 */
  const doDropIntoDir = useCallback(
    async (
      sourcePaneId: number,
      paths: string[],
      op: "copy" | "move",
      destDir: string,
      destPaneId = sourcePaneId,
    ) => {
      await transferPaths(
        sourcePaneId,
        paths,
        op,
        destDir,
        [...new Set([sourcePaneId, destPaneId])],
        destPaneId,
      );
    },
    [transferPaths],
  );

  // v0.22.2 原生（HTML5）拖拽投放：行 onDragStart 后由浏览器接管拖动，mousemove/mouseup
  // 停发，自研鼠标拖拽收不到松手事件——表现为拖动全程 🚫、松手后提示条才出现、
  // 下一次点击才触发投放。这里在 window 上接原生事件流修复：
  // dragover 实时驱动提示条与投放光标；drop 完成投放；dragend 兜底（Tauri
  // dragDropEnabled 拦截 DOM drop 的平台）；drag 越出窗口（OS 拖出）不触发内部投放。
  // v0.24.x Windows 原生拖出（CF_HDROP）回落本窗口时事件里只有 Files 没有
  // x-rdir-dnd 标记，用 nativeDragOut 会话标记区分"自己发起的拖拽"与"资源管理器拖入"。
  // Windows 原生拖出能力探测：drag_out_files([]) 空列表 no-op。jsdom / e2e-mock（未桩化
  // 命令 throw）/ 纯浏览器预览都会失败 → 回落 HTML5 拖出；真实 Windows 应用成功 → dragstart 走原生
  //
  // v0.34 Windows 原生拖放接管（tauri.windows.conf.json `dragDropEnabled: true`）：
  // Tauri 替换 WebView2 的拖放处理器后，HTML5 drag 事件在 Windows 上不再触发——
  // 应用内原生拖出（CF_HDROP）回落本窗口与资源管理器拖入都改从 Tauri 拖放事件收口：
  // - nativeDragOut 会话存在 = 应用内拖拽：高亮/投放与 HTML5 链路同一套（Alt=移动经
  //   query_modifiers 在投放时查询，事件本身不带按键状态）；
  // - 否则 = 资源管理器拖入（此前只拦住 WebView2 导航、不做任何事）：带真实路径，
  //   投放到窗格/目录 = 复制进去（固定复制：外部来源不做移动，避免误删源文件）。
  // macOS / e2e / 纯浏览器：探测失败不订阅，HTML5 链路照旧（WKWebView 拖入无真实路径，仍不导入）。
  const dropActionsRef = useRef({ doDropPaths, doDropIntoDir });
  dropActionsRef.current = { doDropPaths, doDropIntoDir };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void probeNativeDragOut().then(async () => {
      if (disposed || !canNativeDragOut()) return;
      let lastKey = "";
      let lastAlt = false;
      let altPollAt = 0;
      const clear = () => {
        setDragOver(null);
        setDragDir(null);
        lastKey = "";
      };
      /** Tauri 位置是窗口物理像素；elementFromPoint 要的是布局像素（÷ DPR ÷ 根 CSS zoom） */
      const toClient = (p: { x: number; y: number }) => {
        const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
        const s = (window.devicePixelRatio || 1) * zoom;
        return { x: p.x / s, y: p.y / s };
      };
      const highlight = (srcPaneId: number | null, t: DropTarget | null, op: "copy" | "move") => {
        const key = `${t?.paneId ?? ""}|${t?.dirPath ?? ""}|${op}`;
        if (key === lastKey) return;
        lastKey = key;
        setDragOver(t && t.paneId !== srcPaneId ? { targetPaneId: t.paneId, op } : null);
        setDragDir(t?.dirPath ? { paneId: t.paneId, path: t.dirPath } : null);
      };
      const drop = (source: number, paths: string[], op: "copy" | "move", x: number, y: number) => {
        if (paths.length === 0) return;
        const t = dropTargetAt(x, y, paths);
        if (!t) return;
        const { doDropPaths: dp, doDropIntoDir: dd } = dropActionsRef.current;
        if (t.dirPath) void dd(source, paths, op, t.dirPath, t.paneId);
        else if (t.paneId !== source) void dp(source, paths, op, t.paneId);
      };
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload;
          if (p.type === "leave") {
            clear();
            return;
          }
          const c = toClient(p.position);
          const native = getNativeDragOut();
          if (native) {
            if (p.type === "drop") {
              void queryModifiers()
                .catch(() => ({ alt: lastAlt }))
                .then((m) => {
                  clear();
                  drop(native.sourcePaneId, native.paths, m.alt ? "move" : "copy", c.x, c.y);
                  setNativeDragOut(null);
                });
              return;
            }
            // over 高频：Alt 状态 120ms 轮询一次驱动提示条文案，投放时再精确查一次
            const now = Date.now();
            if (now - altPollAt > 120) {
              altPollAt = now;
              void queryModifiers()
                .then((m) => {
                  lastAlt = m.alt;
                })
                .catch(() => {});
            }
            highlight(
              native.sourcePaneId,
              dropTargetAt(c.x, c.y, native.paths),
              lastAlt ? "move" : "copy",
            );
            return;
          }
          // 资源管理器拖入
          if (p.type === "drop") {
            clear();
            drop(-1, p.paths, "copy", c.x, c.y);
            return;
          }
          highlight(null, dropTargetAt(c.x, c.y, []), "copy");
        });
        if (disposed) unlisten();
      } catch (e) {
        console.warn("[rdir] 原生拖放事件订阅失败（回落 HTML5）：", e);
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /** v0.30 拖窗格头到另一窗格：互换两者在布局树中的位置。
   *  只换树上的叶子，窗格状态（路径/选中/历史）跟随 paneId 不动——
   *  两个窗格的内容随位置对调，活动窗格与标签标题不受影响。 */
  const swapPanePositions = useCallback((a: number, b: number) => {
    if (a === b) return;
    setTabs((ts) =>
      ts.map((t) => (t.panes[a] && t.panes[b] ? { ...t, root: swapPanes(t.root, a, b) } : t)),
    );
  }, []);

  const droppedAtRef = useRef(0);
  useEffect(() => {
    const DND_TYPE = "application/x-rdir-dnd";
    const isInternal = (e: DragEvent) => !!e.dataTransfer?.types.includes(DND_TYPE);
    // v0.30 窗格交换拖拽（拖窗格头到另一窗格）：独立标记类型，与文件拖拽分流
    const isPaneSwap = (e: DragEvent) => !!e.dataTransfer?.types.includes(PANE_SWAP_DND_TYPE);
    const paneAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      // 内容区命中 FileList/IconGrid 根（data-pane-id），窗格头区域命中
      // PaneView 根（data-pane-swap-root）——两者都按窗格 id 归一
      const paneEl = el?.closest?.("[data-pane-id],[data-pane-swap-root]") as HTMLElement | null;
      if (!paneEl) return null;
      const id = Number(paneEl.dataset.paneId ?? paneEl.dataset.paneSwapRoot);
      return Number.isNaN(id) ? null : id;
    };
    let seenInternal = false;
    let leftWindow = false;
    let lastKey = "";
    let lastOp: "copy" | "move" = "copy";
    let lastPos = { x: 0, y: 0 };
    let lastSwapTarget: number | null = null;
    const finishSwap = () => {
      setPaneSwap(null);
      lastSwapTarget = null;
    };
    // 拖动起点在窗格头上 → 开启交换会话（视图切换/关闭钮已在组件内 preventDefault，
    // 那些拖拽不会真正发起，defaultPrevented 直接跳过）
    const onDragStart = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      const head = (e.target as HTMLElement | null)?.closest?.(
        "[data-pane-head]",
      ) as HTMLElement | null;
      if (!head) return;
      const paneId = Number(head.dataset.paneHead);
      if (!Number.isNaN(paneId)) setPaneSwap({ source: paneId, target: null });
    };
    const onDragEnter = () => {
      leftWindow = false;
    };
    /** 文件拖拽的悬停高亮分流（v0.31.2 起文件夹条目成为一级投放目标）：
     *  命中目录条目（data-drop-dir，详情目录行 / 网格文件夹图标）→ dragDir 精确高亮
     *  该条目；窗格级目标仅跨窗格时亮 dragOver 提示条+描边——同窗格的窗格级投放要么
     *  无操作（详情列表）要么是空槽重摆（图标网格），常驻提示条只会误导。
     *  跨窗格时提示条对「是否悬停在目录行上」保持稳定（不随行切换闪烁），
     *  目录高亮在其上叠加精确提示。 */
    const highlight = (srcPaneId: number | null, t: DropTarget | null, op: "copy" | "move") => {
      lastOp = op; // dragend 兜底投放用最近一次 dragover 的操作类型
      const key = `${t?.paneId ?? ""}|${t?.dirPath ?? ""}|${op}`;
      if (key === lastKey) return;
      lastKey = key;
      setDragOver(t && t.paneId !== srcPaneId ? { targetPaneId: t.paneId, op } : null);
      setDragDir(t?.dirPath ? { paneId: t.paneId, path: t.dirPath } : null);
    };
    const onDragOver = (e: DragEvent) => {
      if (isPaneSwap(e)) {
        e.preventDefault(); // 投放光标从 🚫 变为 move
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const target = paneAt(e.clientX, e.clientY);
        if (target !== lastSwapTarget) {
          lastSwapTarget = target;
          setPaneSwap((prev) => (prev ? { ...prev, target } : prev));
        }
        return;
      }
      const native = getNativeDragOut();
      if (native) {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault(); // 投放光标从 🚫 变为 copy/move；非窗格区域松手也不至于让 WebView2 打开文件
        const op: "copy" | "move" = e.altKey ? "move" : "copy";
        e.dataTransfer.dropEffect = op === "move" ? "move" : "copy";
        lastPos = { x: e.clientX, y: e.clientY };
        // nativeDragOut 会话带 paths：悬停在被拖文件夹自身上不高亮
        highlight(
          native.sourcePaneId,
          dropTargetAt(e.clientX, e.clientY, native.paths),
          op,
        );
        return;
      }
      if (!isInternal(e)) {
        // 资源管理器拖入的文件：只拦默认行为（不拦的话 drop 会让 WebView2 直接导航打开文件），不做应用内投放
        if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
        return;
      }
      seenInternal = true;
      e.preventDefault(); // 投放光标从 🚫 变为 copy/move
      const op: "copy" | "move" = e.altKey ? "move" : "copy";
      if (e.dataTransfer) e.dataTransfer.dropEffect = op === "move" ? "move" : "copy";
      lastPos = { x: e.clientX, y: e.clientY };
      // dragover 阶段 dataTransfer 值不可读，被拖路径从 HTML5 会话取（dragstart 记录）
      const html5 = getHtml5Drag();
      highlight(html5?.sourcePaneId ?? null, dropTargetAt(e.clientX, e.clientY, html5?.paths ?? []), op);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) {
        leftWindow = true;
        // 拖出窗口即清高亮（拖回时 dragover 会重设；原生拖出窗外松手没有 dragend 兜底）
        finishDrag();
      }
    };
    const finishDrag = () => {
      setDragOver(null);
      setDragDir(null);
      lastKey = "";
    };
    /** 文件拖拽投放（HTML5 / 原生 / dragend 兜底三条链路共用）：目录条目 → 移入/复制
     *  进该目录（同窗格、跨窗格都成立）；窗格级 → 跨窗格复制/移动。同窗格的窗格级
     *  投放在这里是 no-op——图标网格的空槽重摆由网格自己的 onDrop 先行处理。 */
    const fileDrop = (
      source: number,
      paths: string[],
      op: "copy" | "move",
      x: number,
      y: number,
    ) => {
      if (Number.isNaN(source) || paths.length === 0) return;
      const t = dropTargetAt(x, y, paths);
      if (!t) return;
      if (t.dirPath) void doDropIntoDir(source, paths, op, t.dirPath, t.paneId);
      else if (t.paneId !== source) void doDropPaths(source, paths, op, t.paneId);
    };
    const onDrop = (e: DragEvent) => {
      if (isPaneSwap(e)) {
        e.preventDefault();
        const source = Number(e.dataTransfer?.getData(PANE_SWAP_DND_TYPE));
        const target = paneAt(e.clientX, e.clientY);
        finishSwap();
        if (!Number.isNaN(source) && target !== null && target !== source) {
          swapPanePositions(source, target);
        }
        return;
      }
      const native = getNativeDragOut();
      if (native) {
        e.preventDefault();
        finishDrag();
        fileDrop(
          native.sourcePaneId,
          native.paths,
          e.altKey ? "move" : "copy",
          e.clientX,
          e.clientY,
        );
        setNativeDragOut(null);
        return;
      }
      if (!isInternal(e)) {
        if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); // 别让 WebView2 导航打开文件
        return;
      }
      e.preventDefault();
      droppedAtRef.current = Date.now();
      finishDrag();
      setHtml5Drag(null);
      const source = Number(e.dataTransfer?.getData(DND_TYPE));
      const paths = (e.dataTransfer?.getData("text/plain") ?? "")
        .split("\n")
        .filter(Boolean);
      fileDrop(source, paths, e.altKey ? "move" : "copy", e.clientX, e.clientY);
    };
    const onDragEnd = (e: DragEvent) => {
      // 窗格交换拖拽收尾（松手 / Esc 取消 / 拖出窗口释放都会触发 dragend）
      finishSwap();
      // HTML5 会话无论怎样收场都清掉（drop 已清，这里兜 Esc 取消 / 拖出窗口）
      setHtml5Drag(null);
      // dragend 阶段 dataTransfer 已进入保护模式（types 清空），用 dragover 里的标记
      if (!seenInternal) return;
      seenInternal = false;
      if (Date.now() - droppedAtRef.current < 300 || leftWindow) {
        finishDrag();
        return;
      }
      // DOM drop 被 webview 拦截的平台：dragend + 最近 dragover 坐标兜底完成投放
      const row = (e.target as HTMLElement | null)?.closest?.("[data-pane-id]") as HTMLElement | null;
      const source = row ? Number(row.dataset.paneId) : null;
      finishDrag();
      if (source === null || Number.isNaN(source)) return;
      // dataTransfer 已清空：paths 用源窗格当前选中（拖的就是选中组）或拖动行本身
      const pane = tabsRef.current.flatMap((t) => Object.values(t.panes)).find((p) => p.id === source);
      const rowPath =
        (e.target as HTMLElement | null)?.closest?.("[data-path]")?.getAttribute("data-path") ?? null;
      const paths =
        pane && rowPath && pane.selection.includes(rowPath) ? pane.selection : rowPath ? [rowPath] : [];
      fileDrop(source, paths, lastOp, lastPos.x, lastPos.y);
    };
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [doDropPaths, doDropIntoDir, swapPanePositions]);

  // 右键兜底：桌面应用里 WebView2 默认菜单只允许出现在文本编辑上下文。
  // 组件自己的右键菜单（Radix / 手写）已 preventDefault → defaultPrevented 放行；
  // input/textarea/contenteditable 放行系统复制粘贴菜单；其余区域一律屏蔽。
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable]")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const startRename = useCallback((paneId: number, entry: FileEntry) => {
    setRenaming({ paneId, path: entry.path, name: entry.name });
  }, []);

  const commitRename = useCallback(
    async (path: string, name: string) => {
      const r = renaming;
      setRenaming(null);
      if (!r) return;
      const trimmed = name.trim();
      if (trimmed === "" || trimmed === r.name) return;
      // HTTP autoindex 只读：此前 URL 直接喂给本地 fs::rename，报一串 ENOENT 让人摸不着头脑
      if (isHttpPath(path)) {
        showError("HTTP 目录为只读，不能重命名远程条目；可在标签视图中为其设置显示别名");
        return;
      }
      // 会话未连接（如重启后窗格还停在远程路径）→ 自动重连再改名，而不是报「未连接到该服务器」
      if (isSftpPath(path) && !(await sftp.ensureConnected(path))) return;
      try {
        const newPath = isSftpPath(path)
          ? await sftpRename(path, trimmed)
          : await renameEntry(path, trimmed);
        if (!isSftpPath(path)) {
          pushOp({ kind: "rename", oldPath: path, newPath, paneId: r.paneId });
        }
        refreshPane(r.paneId);
      } catch (e) {
        showError(String(e));
      }
    },
    [renaming, refreshPane, showError, pushOp, isSftpPath, sftp],
  );

  const doDeleteNow = useCallback(
    async (p: number, list: string[]) => {
      try {
        if (list.length > 0 && isSftpPath(list[0])) {
          await sftpDelete(list);
        } else {
          try {
            await deleteEntries(list);
            // 回收站删除可撤销：记录进撤销栈
            pushOp({ kind: "delete", paths: list, paneId: p });
          } catch (trashErr) {
            // 回收站失败（被占用/权限/回收站不可用）：对齐资源管理器，给永久删除退路。
            // v0.28.0 应用内确认框（原 Tauri 原生 confirm 在 Windows 是经典样式弹窗）
            const ok = await appConfirm({
              title: "移入回收站失败",
              message: `${trashErr}

要永久删除所选 ${list.length} 项吗？此操作不可恢复。`,
              confirmLabel: "永久删除",
              danger: true,
            });
            if (!ok) return;
            await permanentDeleteEntries(list);
          }
        }
        setTabs((ts) =>
          ts.map((t) => {
            const pane = t.panes[p];
            if (!pane) return t;
            return {
              ...t,
              panes: { ...t.panes, [p]: { ...pane, selection: [] } },
            };
          }),
        );
        refreshPane(p);
      } catch (e) {
        showError(String(e));
      }
    },
    [refreshPane, showError, isSftpPath, pushOp, appConfirm],
  );

  const doDelete = useCallback(
    async (paneId?: number, paths?: string[]) => {
      const p = paneId !== undefined ? paneId : activePane?.id;
      const list = paths ?? activePane?.selection ?? [];
      if (p === undefined || list.length === 0) return;
      // 一律弹确认框（含内部统计：与右键「属性」同一套递归引擎）
      const pane = tabs.flatMap((t) => Object.values(t.panes)).find((x) => x.id === p);
      const known = pane?.entries.filter((e) => list.includes(e.path)) ?? [];
      const knownSet = new Set(known.map((e) => e.path));
      const synthesized: FileEntry[] = list
        .filter((path) => !knownSet.has(path))
        .map((path) => ({
          name: path.split(/[\\/]/).pop() ?? path,
          path,
          is_dir: false,
          is_symlink: false,
          size: 0,
          modified: null,
          created: null,
          permissions: "",
          extension: "",
        }));
      setConfirmDelete({ paneId: p, paths: list, entries: [...known, ...synthesized] });
    },
    [activePane, tabs],
  );

  /** 确认删除弹窗的"删除"按钮 */
  const confirmDeleteNow = useCallback(() => {
    if (!confirmDelete) return;
    const { paneId, paths } = confirmDelete;
    setConfirmDelete(null);
    void doDeleteNow(paneId, paths);
  }, [confirmDelete, doDeleteNow]);

  /** 永久删除（绕过回收站，需确认；不进撤销栈） */
  const doDeletePermanent = useCallback(async () => {
    const p = activePane?.id;
    const list = activePane?.selection ?? [];
    if (p === undefined || list.length === 0) return;
    if (list.some(isSftpPath)) {
      showError("远程删除直接生效（服务器无回收站），请使用删除");
      return;
    }
    // v0.28.0 应用内确认框（原 Tauri 原生 confirm 在 Windows 是经典样式弹窗）
    if (
      !(await appConfirm({
        title: "永久删除",
        message: `永久删除 ${list.length} 项？此操作不可恢复。`,
        confirmLabel: "永久删除",
        danger: true,
      }))
    )
      return;
    try {
      await permanentDeleteEntries(list);
      setTabs((ts) =>
        ts.map((t) => {
          const pane = t.panes[p];
          if (!pane) return t;
          return { ...t, panes: { ...t.panes, [p]: { ...pane, selection: [] } } };
        }),
      );
      refreshPane(p);
    } catch (e) {
      showError(String(e));
    }
  }, [activePane, refreshPane, showError, isSftpPath, appConfirm]);

  const createAndRename = useCallback(
    async (paneId: number, kind: "dir" | "file") => {
      const pane = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === paneId);
      if (!pane) return;
      // 虚拟视图没有可写文件系统：不落盘、不进重命名（否则后端会在进程
      // 工作目录下创建名为 tags: / http: 的真实怪目录）
      if (!isSftpPath(pane.path) && (VIRTUAL_TAG_RE.test(pane.path) || isHttpPath(pane.path))) {
        showError("标签 / HTTP 视图不支持新建，请先进入本地或远程目录");
        return;
      }
      const name = kind === "dir" ? "新建文件夹" : "新建文件.txt";
      try {
        const p = isSftpPath(pane.path)
          ? kind === "dir"
            ? await sftpMkdir(pane.path, name)
            : await sftpCreateFile(pane.path, name)
          : kind === "dir"
            ? await createDir(pane.path, name)
            : await createFile(pane.path, name);
        if (!isSftpPath(pane.path)) {
          pushOp({ kind: "create", path: p, isDir: kind === "dir", paneId });
        }
        refreshPane(paneId);
        setRenaming({ paneId, path: p, name });
      } catch (e) {
        showError(String(e));
      }
    },
    [tabs, refreshPane, showError, pushOp, isSftpPath],
  );

  /** 撤销：copy→删产物；move→按原目录移回；rename→改回；create→删除 */
  const undo = useCallback(async () => {
    const op = undoStack[undoStack.length - 1];
    if (!op) return;
    setUndoStack((s) => s.slice(0, -1));
    try {
      if (op.kind === "copy") {
        await deleteEntries(op.created);
        refreshPane(op.srcPane);
        refreshPane(op.destPane);
      } else if (op.kind === "move") {
        const groups = new Map<string, string[]>();
        for (const [from, to] of op.pairs) {
          const dir = parentPath(from);
          groups.set(dir, [...(groups.get(dir) ?? []), to]);
        }
        for (const [dir, paths] of groups) await moveEntries(paths, dir);
        refreshPane(op.srcPane);
        refreshPane(op.destPane);
      } else if (op.kind === "rename") {
        await renameEntry(op.newPath, basename(op.oldPath));
        refreshPane(op.paneId);
      } else if (op.kind === "create") {
        await deleteEntries([op.path]);
        refreshPane(op.paneId);
      } else if (op.kind === "delete") {
        await restoreFromTrash(op.paths);
        refreshPane(op.paneId);
      }
      setRedoStack((s) => [...s.slice(-49), op]);
    } catch (e) {
      showError(`撤销失败：${e}`);
    }
  }, [undoStack, refreshPane, showError]);

  /** 重做：重放原操作 */
  const redo = useCallback(async () => {
    const op = redoStack[redoStack.length - 1];
    if (!op) return;
    setRedoStack((s) => s.slice(0, -1));
    try {
      if (op.kind === "copy") {
        await copyEntries(op.src, op.dest);
        refreshPane(op.srcPane);
        refreshPane(op.destPane);
      } else if (op.kind === "move") {
        await moveEntries(
          op.pairs.map(([from]) => from),
          op.dest,
        );
        refreshPane(op.srcPane);
        refreshPane(op.destPane);
      } else if (op.kind === "rename") {
        await renameEntry(op.oldPath, basename(op.newPath));
        refreshPane(op.paneId);
      } else if (op.kind === "create") {
        await (op.isDir
          ? createDir(parentPath(op.path), basename(op.path))
          : createFile(parentPath(op.path), basename(op.path)));
        refreshPane(op.paneId);
      } else if (op.kind === "delete") {
        await deleteEntries(op.paths);
        refreshPane(op.paneId);
      }
      setUndoStack((s) => [...s.slice(-49), op]);
    } catch (e) {
      showError(`重做失败：${e}`);
    }
  }, [redoStack, refreshPane, showError]);

  // M2 分屏
  const splitPane = useCallback(
    (dir: SplitDir) => {
      if (!activeTab || !activePane) return;
      const newPane = makePane(activePane.path);
      const split = makeSplit(
        nextSplitId++,
        dir,
        { type: "pane", paneId: activePane.id },
        { type: "pane", paneId: newPane.id },
      );
      setTabs((ts) =>
        ts.map((t) =>
          t.id === activeTab.id
            ? {
                ...t,
                root: replacePane(t.root, activePane.id, split),
                panes: { ...t.panes, [newPane.id]: newPane },
                activePane: newPane.id,
                title: newPane.title,
              }
            : t,
        ),
      );
    },
    [activeTab, activePane],
  );

  const closePane = useCallback(() => {
    if (!activeTab || !activePane) return;
    const root = removePane(activeTab.root, activePane.id);
    if (!root) return;
    const first = firstPaneId(root);
    setTabs((ts) =>
      ts.map((t) =>
        t.id === activeTab.id
          ? { ...t, root, activePane: first, title: t.panes[first]?.title ?? t.title }
          : t,
      ),
    );
  }, [activeTab, activePane]);

  /** 窗格头面包屑导航：作用于指定窗格（不要求是活动窗格），并激活该窗格。
   *  与 navigate 的差异：路径来自面包屑段（已是绝对路径，无需解析/补全），
   *  sftp/tags 同样走 patchPane——连接中的会话内导航不涉及连接框分支。 */
  const navigatePane = useCallback((paneId: number, path: string) => {
    setTabs((ts) =>
      ts.map((t) => {
        const p = t.panes[paneId];
        if (!p || p.path === path) return t;
        const history = [...p.history.slice(0, p.histIndex + 1), path];
        const m = path.match(VIRTUAL_TAG_RE);
        return {
          ...t,
          activePane: paneId,
          panes: {
            ...t.panes,
            [paneId]: {
              ...p,
              path,
              title: m ? tagTitle(m[1]) : basename(path),
              tagId: m ? m[1] : undefined,
              history,
              histIndex: history.length - 1,
              selection: [],
              error: null,
            },
          },
        };
      }),
    );
  }, []);

  /** 关闭指定窗格（窗格头关闭钮）；单窗格时 removePane 返回空 → 无操作 */
  const closePaneById = useCallback((paneId: number) => {
    setTabs((ts) => {
      const target = ts.find((t) => t.panes[paneId]);
      if (!target) return ts;
      const root = removePane(target.root, paneId);
      if (!root) return ts;
      const first = firstPaneId(root);
      return ts.map((t) =>
        t.id === target.id
          ? { ...t, root, activePane: first, title: t.panes[first]?.title ?? t.title }
          : t,
      );
    });
  }, []);

  const focusNextPane = useCallback(() => {
    if (!activeTab) return;
    const ids = collectPaneIds(activeTab.root);
    if (ids.length <= 1) return;
    const idx = ids.indexOf(activeTab.activePane);
    const next = ids[(idx + 1) % ids.length];
    setTabs((ts) =>
      ts.map((t) =>
        t.id === activeTab.id
          ? { ...t, activePane: next, title: t.panes[next]?.title ?? t.title }
          : t,
      ),
    );
  }, [activeTab]);

  const onRatioChange = useCallback(
    (splitId: number, ratio: number) => {
      if (!activeTab) return;
      setTabs((ts) =>
        ts.map((t) =>
          t.id === activeTab.id ? { ...t, root: setSplitRatio(t.root, splitId, ratio) } : t,
        ),
      );
    },
    [activeTab],
  );

  const resetSplitRatio = useCallback(() => {
    if (!activeTab) return;
    setTabs((ts) =>
      ts.map((t) =>
        t.id === activeTab.id ? { ...t, root: resetRatios(t.root) } : t,
      ),
    );
  }, [activeTab]);

  /** 标签页拖拽重排 */
  const reorderTab = useCallback((from: number, to: number) => {
    if (from === to) return;
    setTabs((ts) => {
      const next = [...ts];
      const [t] = next.splice(from, 1);
      next.splice(to, 0, t);
      return next;
    });
  }, []);

  // 搜索外部命令
  const openSearch = useCallback(
    (tab: "name" | "content") => {
      setSearchPaneId(activePane?.id ?? null);
      setSearchOpen(true);
      setSearchCmd({ tab, tick: Date.now() });
    },
    [activePane],
  );

  /** 打开搜索面板：冻结当前活动窗格（切换窗格不再自动重搜） */
  const openSearchPanel = useCallback(() => {
    setSearchPaneId(activePane?.id ?? null);
    setSearchOpen(true);
  }, [activePane]);
  const closeSearchPanel = useCallback(() => setSearchOpen(false), []);
  const toggleSearchPanel = useCallback(() => {
    if (searchOpen) closeSearchPanel();
    else openSearchPanel();
  }, [searchOpen, openSearchPanel, closeSearchPanel]);

  /** v0.8 窗口级缩放更新（Ctrl+滚轮，0.5–2.0，步进 0.1） */
  const setPaneZoom = useCallback((paneId: number, zoom: number) => {
    setTabs((ts) =>
      ts.map((t) => {
        const pane = t.panes[paneId];
        if (!pane) return t;
        const z = Math.min(2, Math.max(0.5, Math.round(zoom * 10) / 10));
        return { ...t, panes: { ...t.panes, [paneId]: { ...pane, zoom: z } } };
      }),
    );
  }, []);

  // ---- v0.27 视图模式 / 图标档位（每窗格独立，随会话保存） ----
  const setPaneViewMode = useCallback((paneId: number, mode: ViewMode) => {
    setTabs((ts) =>
      ts.map((t) => {
        const pane = t.panes[paneId];
        if (!pane) return t;
        return { ...t, panes: { ...t.panes, [paneId]: { ...pane, viewMode: mode } } };
      }),
    );
  }, []);
  const setPaneIconSize = useCallback((paneId: number, size: IconSize) => {
    setTabs((ts) =>
      ts.map((t) => {
        const pane = t.panes[paneId];
        if (!pane) return t;
        return { ...t, panes: { ...t.panes, [paneId]: { ...pane, iconSize: size } } };
      }),
    );
  }, []);

  // ---- v0.27 图标自由摆放位置表（应用数据目录集中存储，防抖整表写回） ----
  const [iconPositions, setIconPositions] = useState<IconPositionMap>({});
  const iconPosTimer = useRef<number | null>(null);
  useEffect(() => {
    iconPositionsLoad()
      .then((m) => setIconPositions(m ?? {}))
      .catch((e) => console.warn("[rdir] 图标位置表读取失败：", e));
  }, []);
  const persistIconPositions = useCallback((next: IconPositionMap) => {
    if (iconPosTimer.current) window.clearTimeout(iconPosTimer.current);
    iconPosTimer.current = window.setTimeout(() => {
      iconPositionsSave(next).catch((e) => console.warn("[rdir] 图标位置表保存失败：", e));
    }, 600);
  }, []);
  const setIconPosition = useCallback(
    (dir: string, name: string, slot: [number, number]) => {
      setIconPositions((prev) => {
        const dirMap = { ...(prev[dir] ?? {}), [name]: slot };
        const next = { ...prev, [dir]: dirMap };
        persistIconPositions(next);
        return next;
      });
    },
    [persistIconPositions],
  );
  const clearIconPositions = useCallback(
    (dir: string) => {
      setIconPositions((prev) => {
        if (!(dir in prev)) return prev;
        const next = { ...prev };
        delete next[dir];
        persistIconPositions(next);
        return next;
      });
    },
    [persistIconPositions],
  );

  // ---- v0.27.1 大图标「自动排列」目录集合（localStorage，访达「保持排列方式」语义） ----
  const [autoArrangeDirs, setAutoArrangeDirs] = useState<string[]>(() => loadAutoArrangeDirs());
  const toggleAutoArrangeDir = useCallback((dir: string) => {
    setAutoArrangeDirs((prev) => {
      const next = prev.includes(dir) ? prev.filter((d) => d !== dir) : [...prev, dir];
      saveAutoArrangeDirs(next);
      return next;
    });
  }, []);

  /** v0.8 压缩选中项（zip / tar / tgz，仅打包，进度走 transfer-progress） */
  const doCompress = useCallback(
    async (paneId: number, paths: string[], format: "zip" | "tar" | "tgz") => {
      const pane = tabs.find((t) => t.panes[paneId])?.panes[paneId];
      if (!pane || paths.length === 0) return;
      try {
        const out = await compressItems(paths, pane.path, format);
        refreshPane(paneId);
        showError(`已生成 ${basename(out)}`);
      } catch (e) {
        showError(`压缩失败：${e}`);
      }
    },
    [tabs, refreshPane, showError],
  );

  /** v0.32 弹解压密码框（Promise 在提交/关闭时兑现：true=已解压成功 / false=放弃） */
  const promptExtractPassword = useCallback(
    (req: { name: string; archivePath: string; targetDir: string; paneId: number; wrong: boolean }) =>
      new Promise<boolean>((resolve) => setExtractPw({ ...req, resolve })),
    [],
  );

  /** v0.32 解压压缩包：here/folder/choose 三种落点；加密包弹密码框就地重试 */
  const doExtract = useCallback(
    async (paneId: number, paths: string[], mode: "here" | "folder" | "choose") => {
      const pane = tabs.find((t) => t.panes[paneId])?.panes[paneId];
      if (!pane || paths.length === 0) return;
      const archives = paths
        .map((p) => pane.entries.find((e) => e.path === p))
        .filter((e): e is FileEntry => !!e && !e.is_dir && isArchiveExt(e.extension));
      if (archives.length === 0) return;
      let targetDir = pane.path;
      if (mode === "choose") {
        const picked = await openDialog({
          title: "选择解压目标目录",
          multiple: false,
          directory: true,
        });
        if (!picked || Array.isArray(picked)) return;
        targetDir = picked;
      }
      for (const a of archives) {
        try {
          const out = await extractArchive(
            a.path,
            targetDir,
            mode === "folder" ? "folder" : "smart",
          );
          refreshPane(paneId);
          // 解到别处时同步刷新展示该目录的其他窗格
          if (targetDir !== pane.path) {
            const ids = tabs
              .flatMap((t) => Object.values(t.panes))
              .filter((p) => p.path === targetDir && p.id !== paneId)
              .map((p) => p.id);
            if (ids.length > 0) refreshPanes(ids);
          }
          showError(`已解压到 ${basename(out.dest)}（${out.files} 项）`);
        } catch (e) {
          const msg = String(e);
          if (msg === "需要密码" || msg === "密码错误") {
            // 密码框内就地重试，true = 已解压成功
            const ok = await promptExtractPassword({
              name: a.name,
              archivePath: a.path,
              targetDir,
              paneId,
              wrong: msg === "密码错误",
            });
            if (!ok) return;
            continue;
          }
          showTransferError(e);
          return;
        }
      }
    },
    [tabs, refreshPane, refreshPanes, showError, showTransferError, promptExtractPassword],
  );

  // 快捷键：统一 keydown 分发（动作注册表 keymap.ts）
  const actionsRef = useRef<Record<string, () => void>>({});
  actionsRef.current = {
    goUp: () => void goUp(),
    goBack: () => goBack(),
    goForward: () => goForward(),
    refresh: () => refresh(),
    focusAddress: () => setAddressFocusTick((t) => t + 1),
    goHome: () => homePath && navigate(homePath),
    selectAll: () => activePane && selectAllIn(activePane.id),
    invertSelection: () => activePane && invertSelectionIn(activePane.id),
    clearSelection: () => {
      if (activePane) clearSelection(activePane.id);
      if (renaming) setRenaming(null);
    },
    copy: () => doCopy(),
    cut: () => doCut(),
    paste: () => void doPaste(),
    duplicate: () => void doDuplicate(),
    rename: () => {
      if (activePane?.selection.length === 1) {
        const e = activePane.entries.find((x) => x.path === activePane.selection[0]);
        if (e) startRename(activePane.id, e);
      }
    },
    open: () => {
      if (activePane?.selection.length === 1) {
        const e = activePane.entries.find((x) => x.path === activePane.selection[0]);
        if (e) openEntry(activePane.id, e);
      }
    },
    delete: () => void doDelete(),
    deletePermanent: () => void doDeletePermanent(),
    newFolder: () => activePane && void createAndRename(activePane.id, "dir"),
    newFile: () => activePane && void createAndRename(activePane.id, "file"),
    copyPath: () => {
      if (activePane?.selection[0]) copyPath(activePane.selection[0]);
    },
    undo: () => void undo(),
    redo: () => void redo(),
    properties: () => setShowProperties((v) => !v),
    newTab: () => newTab(),
    closeTab: () => activeTab && closeTab(activeTab.id),
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    reopenTab: () => reopenTab(),
    jumpTab1: () => jumpTab(1),
    jumpTab2: () => jumpTab(2),
    jumpTab3: () => jumpTab(3),
    jumpTab4: () => jumpTab(4),
    jumpTab5: () => jumpTab(5),
    jumpTab6: () => jumpTab(6),
    jumpTab7: () => jumpTab(7),
    jumpTab8: () => jumpTab(8),
    jumpTab9: () => jumpTab(9),
    splitRow: () => splitPane("row"),
    splitCol: () => splitPane("col"),
    focusNextPane: () => focusNextPane(),
    closePane: () => closePane(),
    resetSplitRatio: () => resetSplitRatio(),
    focusSearch: () => openSearch("name"),
    focusSearchContent: () => openSearch("content"),
    toggleHidden: () => setShowHidden((v) => !v),
    viewDetails: () => {
      if (activePane) setPaneViewMode(activePane.id, "details");
    },
    viewIcons: () => {
      if (activePane) setPaneViewMode(activePane.id, "icons");
    },
    viewGallery: () => {
      if (activePane) setPaneViewMode(activePane.id, "gallery");
    },
    toggleTheme: () => toggleTheme(),
    openSettings: () => setSettingsOpen(true),
    openHelp: () => setSettingsOpen(true),
    toggleSyncResults: () => {
      if (!syncLinkRef.current) {
        showError("未开启同步比对（命令面板或右上 ⋮ 菜单 → 工具 可开启）");
        return;
      }
      setSyncResultsOpen((v) => !v);
    },
    // v0.28 预览栏：总开关关闭时按空格不直接预览，提示去设置开启（点文件同理不预览）
    togglePreview: () => {
      if (!previewPrefs.enabled) {
        showError("预览栏未开启：设置 → 预览 → 启用预览栏");
        return;
      }
      updatePreviewPrefs({ expanded: !previewPrefs.expanded });
    },
    toggleBrowse: () => {
      if (browseOpen) {
        setBrowseOpen(false);
        return;
      }
      if (browseList.length === 0) {
        showError("当前目录没有可预览的图片或文档");
        return;
      }
      setBrowseOpen(true);
    },
    // v0.20 命令面板 + 无默认键位的应用命令（面板 / ⋮ 菜单共用此分发表）
    commandPalette: () => setPaletteOpen((v) => !v),
    // 标签收藏夹面板（mod+b，与命令面板同款开关语义）
    openFavorites: () => setFavoritesOpen((v) => !v),
    // v0.34 主动保存会话布局（mod+s，与退出保存 / 自动保存共用同一入口）
    saveSession: () => void saveSessionNow(),
    // v0.23 「退出」统一走确认对话框（与窗口 X 一致），不再静默保存退出
    quit: () => setCloseDialogOpen(true),
    openDiff: () => openDiff(),
    openSyncDiff: () => toggleSyncDiff(),
    openGitDiff: () => setGitDiffOpen(true),
    toggleExtensions: () => toggleExtensions(),
    checkUpdate: () => void checkUpdate(false),
    openRepo: () => openRepo(),
    openDocs: () => openDocs(),
  };

  /** 命令面板条目 = ACTIONS 注册表（键位提示跟随自定义键位）+ 无键位的应用命令 */
  const paletteItems: CommandItem[] = useMemo(
    () => [
      ...ACTIONS.map((a) => ({
        id: a.id,
        label: a.label,
        group: a.group,
        binding: bindingOf(a),
      })),
      { id: "openDiff", label: "差异比对（左右窗格）…", group: "工具" },
      {
        id: "openSyncDiff",
        label: syncLink ? "断开同步比对" : "同步比对（左右窗格）",
        group: "工具",
      },
      { id: "openGitDiff", label: "打开 Git Diff…", group: "工具" },
      { id: "toggleExtensions", label: "显示 / 隐藏文件扩展名", group: "视图 / 全局" },
      { id: "checkUpdate", label: "检查更新…", group: "帮助" },
      { id: "openRepo", label: "打开 GitHub 仓库", group: "帮助" },
      { id: "openDocs", label: "打开使用指南", group: "帮助" },
      { id: "quit", label: "退出（询问是否保存会话）", group: "文件" },
    ],
    // keymapVer：bindingOf 读模块级自定义键位（非响应式），键位变化后重算
    [syncLink, keymapVer],
  );

  // v0.34.1 弹层打开时暂停全局快捷键分发。syncResultsOpen / browseOpen 不算弹层：
  // mod+shift+x / mod+shift+e 是它们文档化的开关键位，保持可切换。
  const modalActive =
    searchOpen ||
    settingsOpen ||
    paletteOpen ||
    favoritesOpen ||
    shareDialogOpen ||
    sharePanelOpen ||
    closeDialogOpen ||
    gitDiffOpen ||
    !!comparePickFor ||
    !!diffTarget ||
    !!textDiffSource ||
    !!conflictReq ||
    !!appConfirmReq ||
    !!confirmDelete ||
    !!propertiesEntries ||
    sftp.connectOpen ||
    sftp.masterKeyOpen ||
    sftp.importPwOpen ||
    sftp.exportPwOpen ||
    !!extractPw;
  const modalActiveRef = useRef(false);
  modalActiveRef.current = modalActive;
  // 面板类（命令面板 / 收藏夹）打开时，输入框内 mod+k / mod+b 仍放行以便收起
  const paletteKeyRef = useRef(false);
  paletteKeyRef.current = paletteOpen || favoritesOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable === true;
      // v0.34.1 任意弹层打开时暂停全局分发（syncResultsOpen/browseOpen 除外：
      // mod+shift+x / mod+shift+e 是文档化的开关键位）。否则 Delete 会在比对模态
      // 后面拉起隐形确认框、⌘⇧F 会隔着弹层打开搜索面板、Esc 还会顺带清空文件选中。
      // 弹层自身的 Esc/Enter 由各组件的监听器处理，不经过这里。
      if (typing) {
        const combo = keyEventString(e);
        // 输入框聚焦时拦截"刷新"类快捷键，避免漏到 WebView 触发整页重载（状态全丢）
        if ((combo === "f5" || combo === "mod+r") && !modalActiveRef.current) {
          e.preventDefault();
          actionsRef.current.refresh?.();
        }
        // 命令面板开关在输入框内也放行（地址栏/搜索框中 Ctrl+K 直达）；
        // 面板自身打开时放行以便再次按键收起，其余弹层打开时拦截
        if ((combo === "mod+k" || combo === "mod+shift+p") && (!modalActiveRef.current || paletteKeyRef.current)) {
          e.preventDefault();
          actionsRef.current.commandPalette?.();
        }
        // 收藏夹面板同理放行（地址栏打字时 Ctrl+B 直达）
        if (combo === "mod+b" && (!modalActiveRef.current || paletteKeyRef.current)) {
          e.preventDefault();
          actionsRef.current.openFavorites?.();
        }
        return;
      }
      if (modalActiveRef.current) return;
      const combo = keyEventString(e);
      const action = findAction(combo);
      if (!action) return;
      const fn = actionsRef.current[action.id];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // SplitView handlers — useMemo 稳定引用：依赖全部是 useCallback 函数与低频状态，
  // 传输进度等高频状态更新不重建本对象，配合 PaneView 的 React.memo 阻断全树重渲染。
  const handlers: PaneHandlers = useMemo<PaneHandlers>(() => ({
    onSort: (paneId, key: SortKey) => {
      setTabs((ts) =>
        ts.map((t) => {
          const pane = t.panes[paneId];
          if (!pane) return t;
          const same = pane.sortKey === key;
          const sortDir: SortDir =
            same
              ? pane.sortDir === "asc"
                ? "desc"
                : "asc"
              : key === "name"
                ? "asc"
                : "desc";
          const updated = { ...pane, sortKey: key, sortDir };
          return { ...t, panes: { ...t.panes, [paneId]: updated } };
        }),
      );
    },
    onSelect: select,
    onSelectRange: selectRange,
    onClearSelection: clearSelection,
    onOpen: openEntry,
    onOpenFile: openFileExternal,
    onRevealPath: revealPath,
    onMiddleOpen: (_paneId, path) => newTab(path),
    openers,
    shells,
    vscodeDetected: vscodeOk,
    gitTools,
    pluginOpener: plugins?.find((p) => p.id === "opener")?.enabled ?? true,
    pluginTerminal: plugins?.find((p) => p.id === "terminal")?.enabled ?? true,
    onOpenWith: handleOpenWith,
    onOpenTerminal: handleOpenTerminal,
    onOpenVscode: handleOpenVscode,
    onOpenGitTool: handleOpenGitTool,
    quickTools,
    onOpenQuickTool: handleOpenQuickTool,
    onConfigureQuickTools: openQuickToolsSettings,
    onAddCustomOpener: handleAddCustomOpener,
    onCopy: (paneId, paths) => doCopy(paneId, paths),
    onCut: (paneId, paths) => doCut(paneId, paths),
    onDelete: (paneId, paths) => void doDelete(paneId, paths),
    onRename: startRename,
    onRenameCommit: (path, name) => void commitRename(path, name),
    onRenameCancel: () => setRenaming(null),
    onTagRename: (path, name) => void renameTagEntry(path, name),
    entryAliases,
    onCopyPath: copyPath,
    onRefresh: refreshPane,
    onDropPaths: (src, paths, op, target) => void doDropPaths(src, paths, op, target),
    onDragOverChange: setDragOver,
    onActivate: setActivePane,
    onRatioChange,
    onNewFolder: (paneId) => void createAndRename(paneId, "dir"),
    onNewFile: (paneId) => void createAndRename(paneId, "file"),
    onShareDir: async (dir) => {
      setShareDir(dir);
      // 检查是否已有同目录的活跃分享
      try {
        const sessions = await shareList();
        const existing = sessions.find((s) => s.dir === dir);
        if (existing) {
          // 已有活跃分享 → 打开分享面板查看当前配置
          setSharePanelOpen(true);
          return;
        }
      } catch {
        /* ignore */
      }
      setShareDialogOpen(true);
    },
    onPaste: (paneId) => void doPaste(paneId),
    onUndo: () => void undo(),
    onRedo: () => void redo(),
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    onSelectAll: selectAllIn,
    onInvertSelection: invertSelectionIn,
    onToggleTag: toggleTag,
    onToggleQuick: toggleQuick,
    onZoomChange: setPaneZoom,
    onViewModeChange: setPaneViewMode,
    onIconSizeChange: setPaneIconSize,
    onSetIconPosition: setIconPosition,
    onClearIconPositions: clearIconPositions,
    iconPositions,
    autoArrangeDirs,
    onToggleAutoArrange: toggleAutoArrangeDir,
    onDropIntoDir: doDropIntoDir,
    onBack: goBack,
    onForward: goForward,
    onCompress: (paneId, paths, fmt) => void doCompress(paneId, paths, fmt),
    onExtract: (paneId, paths, mode) => void doExtract(paneId, paths, mode),
    onProperties: (list) => setPropertiesEntries(list),
    onPropertiesDir: (dir) => {
      // 空白处右键：统计当前目录本身（不受地址栏选中路径影响）
      void statEntry(dir)
        .then((e) => setPropertiesEntries([e]))
        .catch((err) => showError(String(err)));
    },
    onDiff: openDiff,
    onSyncDiff: toggleSyncDiff,
    onNavigatePane: navigatePane,
    onClosePane: closePaneById,
    onSetCompareBase: handleSetCompareBase,
    onCompareWithBase: handleCompareWithBase,
    onComparePick: (entry) => setComparePickFor(entry),
    onCompareSelected: handleCompareSelected,
    onViewPatch: (path) => setTextDiffSource({ kind: "patchFile", path }),
  }), [
    // 值依赖（对象/数组仅低频变化；长度是原始值）
    openers,
    shells,
    vscodeOk,
    gitTools,
    plugins,
    undoStack.length,
    redoStack.length,
    // 函数依赖（均为 useCallback 稳定引用）
    select,
    selectRange,
    clearSelection,
    openEntry,
    openFileExternal,
    revealPath,
    navigatePane,
    closePaneById,
    newTab,
    handleOpenWith,
    handleOpenTerminal,
    handleOpenVscode,
    handleOpenGitTool,
    quickTools,
    openQuickToolsSettings,
    handleAddCustomOpener,
    doCopy,
    doCut,
    doDelete,
    startRename,
    commitRename,
    renameTagEntry,
    entryAliases,
    copyPath,
    refreshPane,
    doDropPaths,
    doDropIntoDir,
    setPaneViewMode,
    setPaneIconSize,
    setIconPosition,
    clearIconPositions,
    iconPositions,
    autoArrangeDirs,
    toggleAutoArrangeDir,
    createAndRename,
    doPaste,
    undo,
    redo,
    selectAllIn,
    invertSelectionIn,
    toggleTag,
    toggleQuick,
    goBack,
    goForward,
    doCompress,
    doExtract,
    openDiff,
    toggleSyncDiff,
    handleSetCompareBase,
    handleCompareWithBase,
    handleCompareSelected,
    showError,
    onRatioChange,
  ]);

  // Set 化 + 仅在活动窗格数据变化时重算：避免全选万级条目时每次渲染 O(n·m) 字符串比较
  const selectedSize = useMemo(() => {
    if (!activePane) return 0;
    const sel = new Set(activePane.selection);
    return activePane.entries.reduce((s, e) => (sel.has(e.path) ? s + e.size : s), 0);
  }, [activePane]);

  /** 地址栏显示路径（v0.14）：单选文件时直接显示其完整路径；否则当前目录 */
  const addressPath = (() => {
    if (!activePane) return "";
    if (activePane.selection.length === 1) return activePane.selection[0];
    const m = activePane.path.match(VIRTUAL_TAG_RE);
    return m ? tagTitle(m[1], tagNames) : activePane.path;
  })();

  return (
    <LanguageProvider language={language} onLanguageChange={changeLanguage}>
    <>
    {splashVisible && (
      <div
        className={
          "fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background transition-opacity duration-500 " +
          (splashFading ? "opacity-0" : "opacity-100")
        }
      >
        <div className="relative flex h-12 w-48 items-center justify-center overflow-hidden">
          <Bird
            className="absolute text-primary"
            style={{
              width: 32,
              height: 32,
              animation: "rdir-bird-fly 1.2s ease-in-out forwards",
            }}
          />
        </div>
        <div className="mt-4 h-0.5 w-48 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary"
            style={{ animation: "rdir-progress 1.2s ease-out forwards" }}
          />
        </div>
        <style>{`
          @keyframes rdir-bird-fly {
            0% { left: -40px; transform: translateY(0); }
            25% { transform: translateY(-6px); }
            50% { transform: translateY(2px); }
            75% { transform: translateY(-4px); }
            100% { left: 100%; transform: translateY(0); }
          }
          @keyframes rdir-progress {
            0% { width: 0%; }
            70% { width: 85%; }
            100% { width: 100%; }
          }
        `}</style>
      </div>
    )}
    <div
      className="flex flex-col overflow-hidden bg-background text-foreground"
      // 根元素带 CSS zoom（界面字体缩放）时，100vh 会被放大成 100vh×zoom 导致整页
      // 溢出滚动、状态栏被顶出视口；高度按 zoom 折算后视觉上恰好占满一屏（v0.18.3）
      style={{ height: "calc(100vh / var(--rdir-zoom, 1))" }}
    >
      <TabBar
        tabs={tabs.map((t) => ({ id: t.id, title: t.customTitle ?? t.title }))}
        activeId={activeId}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
        onReorder={reorderTab}
        onRename={renameTab}
        onReopen={reopenTab}
        canReopen={closedTabsRef.current.length > 0}
        onCloseOthers={closeOtherTabs}
        onCloseRight={closeTabsToRight}
        onFavoriteTab={addFavorite}
        onOpenFavorites={() => setFavoritesOpen(true)}
        trailing={
          <AppMenu
            keymapVersion={keymapVer}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenFavorites={() => setFavoritesOpen(true)}
            onNewTab={() => newTab()}
            onCloseTab={() => activeTab && closeTab(activeTab.id)}
            onSaveSession={() => void saveSessionNow()}
            onQuit={() => setCloseDialogOpen(true)}
            onNewFolder={() => activePane && void createAndRename(activePane.id, "dir")}
            onNewFile={() => activePane && void createAndRename(activePane.id, "file")}
            onUndo={() => void undo()}
            canUndo={undoStack.length > 0}
            onRedo={() => void redo()}
            canRedo={redoStack.length > 0}
            onCopy={() => doCopy()}
            onCut={() => doCut()}
            onPaste={() => void doPaste()}
            canPaste={!!activePane}
            onDuplicate={() => void doDuplicate()}
            canDuplicate={(activePane?.selection.length ?? 0) > 0}
            onRename={() => {
              if (activePane?.selection.length === 1) {
                const e = activePane.entries.find((x) => x.path === activePane.selection[0]);
                if (e) startRename(activePane.id, e);
              }
            }}
            canRename={(activePane?.selection.length ?? 0) === 1}
            onDelete={() => void doDelete()}
            canDelete={(activePane?.selection.length ?? 0) > 0}
            onCopyPath={() => {
              if (activePane?.selection[0]) copyPath(activePane.selection[0]);
            }}
            onToggleProperties={() => setShowProperties((v) => !v)}
            onToggleHidden={() => setShowHidden((v) => !v)}
            showHidden={showHidden}
            onToggleExtensions={toggleExtensions}
            showExtensions={showExtensions}
            viewMode={activePane?.viewMode ?? "details"}
            onViewModeChange={(mode) => activePane && setPaneViewMode(activePane.id, mode)}
            onToggleSearch={toggleSearchPanel}
            onRefresh={refresh}
            onBack={goBack}
            onForward={goForward}
            onUp={goUp}
            onHome={() => homePath && navigate(homePath)}
            onSplitRow={() => splitPane("row")}
            onSplitCol={() => splitPane("col")}
            onClosePane={closePane}
            canClosePane={!!activeTab && !isSinglePane(activeTab.root)}
            onFocusNextPane={focusNextPane}
            onOpenDiff={openDiff}
            onOpenSyncDiff={toggleSyncDiff}
            syncDiffActive={!!syncLink}
            onOpenGitDiff={() => setGitDiffOpen(true)}
            onAddSftp={() => sftp.openConnect({})}
            onMasterKey={() => sftp.setMasterKeyOpen(true)}
            onExportServers={() => void sftp.exportServers()}
            onImportServers={() => void sftp.importServers()}
            onOpenSettings={() => setSettingsOpen(true)}
            onCheckUpdate={() => void checkUpdate(false)}
            onOpenRepo={openRepo}
            onOpenDocs={openDocs}
            appName={appName}
            appVersion={appVersion}
            dark={dark}
            onToggleTheme={toggleTheme}
          />
        }
      />

      <Toolbar
        canBack={(activePane?.histIndex ?? 0) > 0}
        canForward={
          !!activePane && activePane.histIndex < activePane.history.length - 1
        }
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        onRefresh={refresh}
        onPropertiesDir={handlers.onPropertiesDir}
        path={addressPath}
        cwd={activePane?.path ?? homePath}
        isSftpConnected={isSftpConnectedPath}
        leafIsFile={
          !!activePane &&
          activePane.selection.length === 1 &&
          !(activePane.entries.find((e) => e.path === activePane.selection[0])?.is_dir ?? false)
        }
        onRevealFile={(p) => openSearchResult(parentPath(p), p)}
        onNavigate={navigate}
        searchOpen={searchOpen}
        onToggleSearch={toggleSearchPanel}
        syncDiffActive={!!syncLink}
        onToggleSyncDiff={toggleSyncDiff}
        focusTick={addressFocusTick}
        trailing={
          <PaneListMenu
            panes={paneList}
            onActivate={activatePane}
            markPaneKey={
              compareBase && compareBase.tabId >= 0
                ? `${compareBase.tabId}:${compareBase.paneId}`
                : undefined
            }
          />
        }
      />

      <div className="relative flex min-h-0 flex-1">
        <Sidebar
          quickAccess={quickAccess}
          volumes={volumes}
          currentPath={activePane?.path ?? ""}
          onNavigate={navigate}
          onMiddleOpen={(path) => newTab(path)}
          customQuick={customQuick}
          onRemoveQuick={toggleQuick}
          entryAliases={entryAliases}
          onRenameQuick={setEntryAlias}
          tagCounts={Object.fromEntries(tags.map((t) => [t.id, tagPaths(t.id).length]))}
          tags={tags}
          tagNames={tagNames}
          onRenameTag={renameTag}
          onAddTag={addTag}
          onTagsFullHint={tagsFullHint}
          activeTagId={activePane?.tagId ?? null}
          onSelectTag={(tagId) => navigate(`tags://${tagId}`)}
          sftpServers={plugins?.find((p) => p.id === "sftp")?.enabled === false ? [] : sftp.servers}
          onSftpOpen={sftp.openServer}
          onSftpDisconnect={sftp.disconnect}
          onSftpEdit={sftp.editServer}
          onSftpRemove={sftp.removeServer}
          onSftpAdd={() => sftp.openConnect({})}
          onSftpExport={() => void sftp.exportServers()}
          onSftpImport={() => void sftp.importServers()}
          onSftpClearTemp={() => void sftp.clearOpenTemp()}
          onSftpSetGroup={(ids, group) => void sftp.setServerGroup(ids, group)}
          shells={shells}
          pluginTerminal={plugins?.find((p) => p.id === "terminal")?.enabled ?? true}
          onOpenTerminal={handleOpenTerminal}
          onPropertiesDir={handlers.onPropertiesDir}
          onCopyPath={copyPath}
        />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab
            ? tabs.map((t) => {
                const isActive = t.id === activeId;
                // 未进 keep-alive 集合的非活动标签不挂载（LRU 淘汰态，激活时重建）
                if (!isActive && !keptTabIds.includes(t.id)) return null;
                return (
                  <Activity key={t.id} mode={isActive ? "visible" : "hidden"}>
                    <SplitView
                      node={t.root}
                      panes={t.panes}
                      activePaneId={t.activePane}
                      showHidden={showHidden}
                      showExtensions={showExtensions}
                      showProperties={showProperties}
                      previewSpace={previewPrefs.enabled}
                      canPaste={!!t.panes[t.activePane]}
                      renaming={renaming}
                      dragOver={dragOver}
                      dragDir={dragDir}
                      paneSwap={paneSwap}
                      fileTags={fileTags}
                      tags={tags}
                      tagNames={tagNames}
                      onRenameTag={renameTag}
                      customQuick={customQuick}
                      onOpenTagFile={openTagFile}
                      onExitTag={exitTagViewForPane}
                      highlight={!isSinglePane(t.root)}
                      diffMarksByPane={syncMarks}
                      linkBadgeByPane={syncBadges}
                      compareBase={compareBase}
                      handlers={handlers}
                    />
                  </Activity>
                );
              })
            : null}
        </div>

        {searchOpen && searchPane && (
          <SearchPanel
            entries={searchPane.entries}
            dir={searchPane.path}
            cmd={searchCmd}
            onClose={closeSearchPanel}
            // v0.29.0 模态框化：定位导航发生在遮罩后面的窗格里，关掉框才能看到定位结果
            onReveal={(p, isDir) => {
              revealPath(p, isDir);
              closeSearchPanel();
            }}
            onOpenFile={openFileExternal}
            onCopyPath={copyPath}
            onRenamed={handleSearchRenamed}
            onError={showError}
          />
        )}

        {/* v0.28 预览栏：右侧覆盖式拉门（悬浮在侧边栏+文件区上方，工具栏/状态栏保留） */}
        <PreviewDrawer
          entry={previewEntry}
          enabled={previewPrefs.enabled}
          expanded={previewPrefs.expanded}
          width={previewPrefs.width}
          canBrowse={browseList.length > 0}
          onExpand={() => updatePreviewPrefs({ expanded: true })}
          onCollapse={() => updatePreviewPrefs({ expanded: false })}
          onWidthChange={(w) => updatePreviewPrefs({ width: w })}
          onBrowse={() => actionsRef.current.toggleBrowse?.()}
          onOpenExternal={openFileExternal}
        />

        {/* v0.28 图文浏览模式：沉浸覆盖内容区，导航即选中（与列表/预览栏三方同步） */}
        {browseOpen && (
          <BrowseMode
            entries={activePane?.entries ?? []}
            sortKey={activePane?.sortKey ?? "name"}
            sortDir={activePane?.sortDir ?? "asc"}
            showHidden={showHidden}
            primaryPath={activePane?.selection[0] ?? null}
            onNavigate={(path) => activePane && selectRange(activePane.id, [path])}
            onClose={() => setBrowseOpen(false)}
            onOpenExternal={openFileExternal}
          />
        )}
      </div>

      {/* v0.18.2 同步比对结果模态:状态栏段 / Ctrl+Shift+X 打开,实时更新;断开链接 = 清理 */}
      {syncLink && syncPanes && (
        <SyncDiffModal
          open={syncResultsOpen}
          link={syncLink}
          leftPath={syncPanes.lp.path}
          rightPath={syncPanes.rp.path}
          alignment={syncPanes.alignment}
          status={syncRun?.status ?? "running"}
          entries={syncRun?.entries ?? null}
          error={syncRun?.error ?? null}
          canCreateMissing={canCreateMissing}
          onRealign={realignSync}
          onSwap={swapSyncSides}
          onCreateMissing={() => void createMissingAndEnter()}
          onReturnAlign={returnToAlignment}
          onUnlink={() => unlinkSync(activeId)}
          onCompare={(l, r, name) => openTextDiff(l, r, name, name)}
          onClose={() => setSyncResultsOpen(false)}
        />
      )}

      <StatusBar
        path={activePane?.path ?? ""}
        total={activePane?.entries.length ?? 0}
        selected={activePane?.selection ?? []}
        selectedSize={selectedSize}
        showHidden={showHidden}
        error={activePane?.error ?? null}
        notice={notice}
        transfer={transfer}
        onCancelTransfer={(id, phase) => {
          // v0.23 SFTP 递归传输的 id 带 sftp: 前缀走通用取消；
          // 无前缀的 download 是 HTTP 下载（id = url，走专用断点续传取消）
          if (id.startsWith("sftp:") || phase !== "download") {
            void cancelTransfer(id).catch(() => {});
          } else {
            void cancelHttpDownload(id);
          }
        }}
        onSharePanel={() => setSharePanelOpen(true)}
        syncDiff={
          syncLink && syncPanes
            ? {
                summary: {
                  status: syncRun?.status ?? "running",
                  total: syncRun?.entries?.length ?? 0,
                  diffCount: syncDiffCount,
                  diverged: syncPanes.alignment.state === "diverged",
                  error: syncRun?.error ?? null,
                },
                onOpen: () => setSyncResultsOpen(true),
              }
            : undefined
        }
        compareBase={
          compareBase
            ? { name: compareBase.name, path: compareBase.path, onClear: handleClearCompareBase }
            : undefined
        }
        baseHint={compareBaseHint}
      />

      <ShareDialog
        open={shareDialogOpen}
        dir={shareDir}
        onClose={() => setShareDialogOpen(false)}
        onCreated={() => {
          setShareDialogOpen(false);
          setSharePanelOpen(true);
        }}
        onError={(msg) => {
          showError(msg);
          setShareDialogOpen(false);
        }}
      />

      <SharePanel
        key={shareVer}
        open={sharePanelOpen}
        onClose={() => setSharePanelOpen(false)}
        onNewShare={() => {
          setSharePanelOpen(false);
          if (activePane) {
            setShareDir(activePane.path);
            setShareDialogOpen(true);
          }
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsJump(null);
        }}
        themeMode={themeMode}
        onThemeModeChange={changeThemeMode}
        language={language}
        onLanguageChange={changeLanguage}
        onBindingsChanged={() => setKeymapVer((v) => v + 1)}
        previewEnabled={previewPrefs.enabled}
        onPreviewEnabledChange={(v) => updatePreviewPrefs({ enabled: v })}
        previewWidth={previewPrefs.width}
        onPreviewWidthChange={(n) => updatePreviewPrefs({ width: n })}
        plugins={plugins}
        onTogglePlugin={handleTogglePlugin}
        uiFontSize={uiFontSize}
        onUiFontChange={(n) => {
          setUiFontSize(n);
          saveUiFontSize(n);
        }}
        uiFontFamily={uiFontFamily}
        onUiFontFamilyChange={(id) => {
          setUiFontFamily(id);
          saveUiFontFamily(id);
        }}
        fontFamilies={UI_FONT_FAMILIES}
        openers={openers}
        onAddOpener={() => void handleAddCustomOpener()}
        onRemoveOpener={handleRemoveCustomOpener}
        onSetOpenerExtensions={handleSetOpenerExtensions}
        jumpTo={settingsJump}
        quickTools={quickTools}
        editorSuggestions={editorSugs}
        onAddQuickTool={() => void handleAddQuickTool()}
        onAddSuggestedTool={(c) => void handleAddSuggestedTool(c)}
        onRemoveQuickTool={handleRemoveQuickTool}
        onMoveQuickTool={handleMoveQuickTool}
        onSetQuickToolArgs={handleSetQuickToolArgs}
        remoteTempDir={remoteTempDir}
        onRemoteTempDirChange={(d) => {
          saveRemoteTempDir(d);
          setRemoteTempDir(d);
        }}
        onCleanRemoteTemp={() => sftp.clearOpenTemp()}
        appName={appName}
        appVersion={appVersion}
        onOpenRepo={openRepo}
        onOpenDocs={openDocs}
        onCheckUpdate={() => void checkUpdate(false)}
        onOpenFavorites={() => setFavoritesOpen(true)}
      />

      {/* v0.20 命令面板：动作经 actionsRef 分发，与快捷键语义一致 */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        items={paletteItems}
        onRun={(id) => actionsRef.current[id]?.()}
      />

      {/* 标签收藏夹面板：数据与增删改查逻辑在本组件，面板只受控展示 */}
      <FavoritesPalette
        open={favoritesOpen}
        onOpenChange={setFavoritesOpen}
        favorites={favorites}
        onOpenFavorite={openFavorite}
        onAddFavorite={() => activeTab && addFavorite(activeTab.id)}
        onRenameFavorite={renameFavorite}
        onRemoveFavorite={removeFavorite}
        onUpdateFavorite={updateFavorite}
      />

      <ConnectDialog
        open={sftp.connectOpen}
        initial={sftp.connectInitial}
        masterKey={sftp.masterKeyStatus}
        onNeedMasterKey={sftp.requestMasterKey}
        onSaveOnly={(cfg) => sftp.saveServerOnly(cfg)}
        onClose={sftp.closeConnect}
        onConnected={sftp.handleConnected}
      />

      {/* 主密钥（master-key）：仅内存，用于加密保存的密码 */}
      <MasterKeyDialog
        open={sftp.masterKeyOpen}
        configured={sftp.masterKeyStatus.configured}
        onClose={sftp.closeMasterKey}
        onDone={(ok) => void sftp.handleMasterKeyDone(ok)}
      />

      {/* v0.31 导入服务器清单的主密码框：导出文件含加密密码时必须输入导出方主密码解析 */}
      <PasswordDialog
        open={sftp.importPwOpen}
        title="输入主密码"
        description={
          <>
            导入文件包含加密保存的服务器密码，需输入<b>导出时使用的主密码</b>解析。
            校验通过后按本机主密钥重新加密合并（同 id 服务器跳过）。
          </>
        }
        submitLabel="导入"
        onSubmit={sftp.submitImportPassword}
        onClose={sftp.closeImportPassword}
      />

      {/* v0.31.1 导出服务器清单的主密码框：清单里有明文保存的密码且本会话未解锁主密钥时，
          输入主密码就地加密后再写出（首次 = 设置主密码；已设过 = 校验） */}
      <PasswordDialog
        open={sftp.exportPwOpen}
        title={sftp.masterKeyStatus.configured ? "输入主密码" : "设置主密码"}
        description={
          sftp.masterKeyStatus.configured ? (
            <>
              清单中有<b>以明文保存的服务器密码</b>（在主密钥未解锁时保存的）。导出文件会离开本机，
              需输入主密码把它们加密后再写出；本机清单同时升级为密文。导入时需要同一主密码。
            </>
          ) : (
            <>
              清单中有<b>以明文保存的服务器密码</b>。导出文件会离开本机，请设置一个主密码用于加密——
              导入到其他设备时需要输入同一主密码。本机清单同时升级为密文，之后启动输入此密码解锁。
            </>
          )
        }
        placeholder={sftp.masterKeyStatus.configured ? "输入主密码" : "设置主密码（请牢记）"}
        submitLabel="加密并导出"
        onSubmit={sftp.submitExportPassword}
        onClose={sftp.closeExportPassword}
      />

      {/* v0.32 解压加密压缩包的密码框：onSubmit 就地重试（抛错 = 框内报错保持打开），
          成功/关闭时兑现 promise（true = 已解压成功，主循环继续下一个归档） */}
      <PasswordDialog
        open={!!extractPw}
        title={extractPw?.wrong ? "密码错误，请重试" : "输入归档密码"}
        description={
          <>
            「<b>{extractPw?.name}</b>」是加密压缩包，输入密码继续解压。
          </>
        }
        placeholder="归档密码"
        submitLabel="解压"
        onSubmit={async (password) => {
          if (!extractPw) return;
          try {
            const out = await extractArchive(extractPw.archivePath, extractPw.targetDir, "smart", password);
            refreshPane(extractPw.paneId);
            showError(`已解压到 ${basename(out.dest)}（${out.files} 项）`);
            extractPw.resolve(true);
          } catch (e) {
            const msg = String(e);
            if (msg === "需要密码" || msg === "密码错误") {
              setExtractPw({ ...extractPw, wrong: true });
              throw new Error("密码不正确，请重试");
            }
            if (msg.includes("取消")) {
              showError("已取消");
            } else {
              showTransferError(e);
            }
            extractPw.resolve(false);
          }
        }}
        onClose={() => {
          extractPw?.resolve(false);
          setExtractPw(null);
        }}
      />

      {/* 同名冲突裁决弹窗 */}
      {conflictReq && (
        <ConflictDialog conflicts={conflictReq} onDone={finishConflicts} />
      )}
      {/* v0.28.0 应用内确认框（永久删除 / 回收站失败转永久删除等） */}
      {appConfirmReq && (
        <AppConfirmDialog
          req={appConfirmReq}
          onConfirm={() => settleAppConfirm("confirm")}
          onCancel={() => settleAppConfirm("cancel")}
          onAlt={() => settleAppConfirm("alt")}
        />
      )}

      {/* 删除确认弹窗（一律确认；目录内部统计与右键「属性」同一套引擎） */}
      {confirmDelete && (
        <DeleteConfirmDialog
          key={confirmDelete.paths.join("|")}
          entries={confirmDelete.entries}
          onConfirm={confirmDeleteNow}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* v0.16 属性弹窗：目录递归统计大小 + 滚动数字 */}
      {propertiesEntries && (
        <PropertiesDialog
          key={propertiesEntries.map((e) => e.path).join("|")}
          entries={propertiesEntries}
          onClose={() => setPropertiesEntries(null)}
        />
      )}

      {/* v0.17 差异比对窗口 */}
      {diffTarget && (
        <DiffDialog
          leftDir={diffTarget.left}
          rightDir={diffTarget.right}
          onClose={() => setDiffTarget(null)}
          onLocate={locateFromDiff}
          onSynced={() => {
            refreshPane(diffTarget.leftPane);
            refreshPane(diffTarget.rightPane);
          }}
        />
      )}

      {/* v0.19 文本比较窗口：文件 vs 文件 / git diff 解析共用 */}
      {textDiffSource && (
        <TextDiffDialog source={textDiffSource} onClose={() => setTextDiffSource(null)} />
      )}

      {/* v0.19 与另一文件比较：窗格选择器 */}
      {comparePickFor && (
        <ComparePickDialog
          baseName={comparePickFor.name}
          panes={comparePickPanes}
          onPick={(f) => {
            openTextDiff(comparePickFor.path, f.path, comparePickFor.name, f.name);
            setComparePickFor(null);
          }}
          onClose={() => setComparePickFor(null)}
        />
      )}

      {/* v0.19 Git Diff 粘贴导入 */}
      {gitDiffOpen && (
        <GitDiffDialog
          onConfirm={(text) => {
            setGitDiffOpen(false);
            setTextDiffSource({ kind: "patchText", text });
          }}
          onClose={() => setGitDiffOpen(false)}
        />
      )}

      {/* v0.14 复制/剪切成功提示：窗内居中，约 1 秒消失；error 变体 = 传输/覆盖失败（红色、停留更久） */}
      {clipboardTip && (
        <div
          key={clipboardTip.tick}
          data-toast=""
          data-variant={clipboardTip.variant ?? "info"}
          className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center"
        >
          <div
            className={cn(
              "max-w-[70vw] rounded-lg border px-5 py-2.5 text-sm font-medium shadow-xl backdrop-blur-sm",
              clipboardTip.variant === "error"
                ? "flex items-start gap-2 border-destructive/40 bg-destructive/10 text-destructive"
                : "border-primary/25 bg-background/90 text-foreground",
            )}
          >
            {clipboardTip.variant === "error" && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="break-words whitespace-pre-wrap">{clipboardTip.text}</span>
          </div>
        </div>
      )}

      {/* 退出询问：是否保存会话布局（v0.3.0） */}
      {closeDialogOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCloseDialogOpen(false);
          }}
        >
          <div className="w-[360px] max-w-[92vw] rounded-lg border bg-background p-4 shadow-xl">
            <div className="text-sm font-semibold">保存会话布局？</div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              会话已随使用自动保存，程序意外中断后下次启动会恢复最近布局。
              「保存并退出」立即保存当前布局；「不保存」将清除已保存会话，下次启动回到默认页。
              <br />
              SFTP 远程目录需验证主密钥后恢复，否则显示占位。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCloseDialogOpen(false)}>
                取消<span className="ml-1.5 text-[10px] opacity-60">Esc</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleExitNoSave()}>
                不保存<span className="ml-1.5 text-[10px] opacity-60">Ctrl+C</span>
              </Button>
              <Button size="sm" onClick={() => void handleExitWithSave()} autoFocus>
                保存并退出
                <span className="ml-1.5 text-[10px] opacity-60">{isMac ? "⌘S" : "Ctrl+S"}</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
    </LanguageProvider>
  );
}
