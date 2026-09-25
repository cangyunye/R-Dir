import { useCallback, useEffect, useRef, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getName, getVersion } from "@tauri-apps/api/app";
import {
  open as openDialog,
  confirm as confirmDialog,
  ask as askDialog,
  message as messageDialog,
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
  type OpenerItem,
  type PluginInfo,
  type ShellItem,
} from "@/lib/openerApi";
import type {
  ClipboardState,
  FileEntry,
  PaneNode,
  PaneState,
  QuickAccessItem,
  ResolutionPlan,
  SessionLayout,
  SortDir,
  SortKey,
  SplitDir,
  TabState,
  TransferConflict,
  TransferProgress,
  VolumeInfo,
} from "@/lib/types";
import { parseSftpAuthority, isSftpPath, isHttpPath } from "@/lib/sftp-path";
import { useSftp } from "@/hooks/useSftp";
import {
  copyEntries,
  copyEntriesPlan,
  createDir,
  createFile,
  deleteEntries,
  getHomeDir,
  getQuickAccess,
  getVolumes,
  listDir,
  moveEntries,
  moveEntriesPlan,
  scanConflicts,
  clipboardWriteFiles,
  clipboardReadFiles,
  parentDir,
  permanentDeleteEntries,
  renameEntry,
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
  statPath,
  compressItems,
} from "@/lib/api";
import { ConnectDialog } from "@/components/ConnectDialog";
import { ConflictDialog } from "@/components/ConflictDialog";
import { MasterKeyDialog } from "@/components/MasterKeyDialog";
import { basename } from "@/lib/format";
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
} from "@/lib/paneTree";
import { findAction, keyEventString } from "@/lib/keymap";
import { fetchLatestRelease, REPO_URL } from "@/lib/update";
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
  loadUiFontSize,
  saveUiFontSize,
  uiFontZoom,
  loadUiFontFamily,
  saveUiFontFamily,
  uiFontFamilyStack,
  UI_FONT_FAMILIES,
  loadShowExtensions,
  saveShowExtensions,
  loadPrefsFromDisk,
  mergeDiskPrefs,
  flushPrefsToDisk,
  type FileTags,
  type TagNames,
} from "@/lib/persist";
import { shareStopByDir, shareList } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Trash2, Bird } from "lucide-react";
import { PaneListMenu } from "@/components/PaneListMenu";
import { PropertiesDialog } from "@/components/PropertiesDialog";
import { DiffDialog } from "@/components/DiffDialog";
import { MenuBar } from "@/components/MenuBar";

/** 虚拟标签目录：tags://<tagId>（地址栏可直接输入） */
const VIRTUAL_TAG_RE = /^tags:\/\/([a-z0-9_-]+)$/;

/** 从 sftp://user@host:port/path 提取 authority（= 服务器 id） */
function sftpAuthorityId(path: string): string | null {
  const rest = path.startsWith("sftp://") ? path.slice("sftp://".length) : path;
  const authority = rest.split("/")[0] ?? "";
  if (!authority || !authority.includes("@")) return null;
  return authority;
}

/** 序列化当前标签页布局为会话快照（SFTP 只存 serverId，不含任何凭据） */
function serializeSession(tabs: TabState[], activeId: number): SessionLayout {
  const activeIdx = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    activeTab: activeIdx,
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      customTitle: t.customTitle,
      activePane: t.activePane,
      root: t.root,
      panes: Object.values(t.panes).map((p) => {
        if (p.path.startsWith("sftp://")) {
          return {
            id: p.id,
            path: p.path,
            kind: "sftp",
            serverId: sftpAuthorityId(p.path) ?? undefined,
            zoom: p.zoom,
          };
        }
        if (p.tagId)
          return { id: p.id, path: p.path, kind: "tag", tagId: p.tagId, zoom: p.zoom };
        return { id: p.id, path: p.path, kind: "local", zoom: p.zoom };
      }),
    })),
  };
}

/** 恢复时把旧 paneId 重映射到本次新分配的 id（分屏树原样保留比例/方向） */
function remapNode(node: PaneNode, remap: Map<number, number>): PaneNode {
  if (node.type === "pane") {
    const nid = remap.get(node.paneId);
    return nid !== undefined ? { type: "pane", paneId: nid } : node;
  }
  return { ...node, a: remapNode(node.a, remap), b: remapNode(node.b, remap) };
}

function tagTitle(tagId: string, names?: TagNames): string {
  const def = tagById(tagId);
  const n = names ?? loadTagNames();
  return `标签：${def ? tagLabel(def, n) : tagId}`;
}
import { TabBar } from "@/components/TabBar";
import { Toolbar } from "@/components/Toolbar";
import { Sidebar } from "@/components/Sidebar";
import { SplitView, type PaneHandlers } from "@/components/SplitView";
import { SearchPanel } from "@/components/SearchPanel";
import { StatusBar } from "@/components/StatusBar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { SharePanel } from "@/components/SharePanel";

let nextTabId = 1;
let nextPaneId = 1;
let nextSplitId = 1;

/** 可撤销/重做的文件操作记录（只记录可安全反向的操作；回收站删除不记录） */
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
  | { kind: "create"; path: string; isDir: boolean; paneId: number };

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

export default function App() {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeId, setActiveId] = useState<number>(0);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [quickAccess, setQuickAccess] = useState<QuickAccessItem[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 搜索面板冻结的目标窗格 id（打开时锁定，切换窗格不再自动重搜） */
  const [searchPaneId, setSearchPaneId] = useState<number | null>(null);
  const [homePath, setHomePath] = useState("");
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  /** 同名冲突裁决：非空时显示 ConflictDialog，resolve 存 ref 供异步等待 */
  const [conflictReq, setConflictReq] = useState<TransferConflict[] | null>(null);
  const conflictResolver = useRef<((plan: ResolutionPlan | null) => void) | null>(null);
  const [renaming, setRenaming] = useState<{
    paneId: number;
    path: string;
    name: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** v0.14 复制/剪切成功后的中央提示（约 1 秒内消失） */
  const [clipboardTip, setClipboardTip] = useState<{ text: string; tick: number } | null>(null);
  const clipboardTipTimer = useRef<number | null>(null);
  const flashClipboardTip = useCallback((text: string) => {
    setClipboardTip({ text, tick: Date.now() });
    if (clipboardTipTimer.current) window.clearTimeout(clipboardTipTimer.current);
    clipboardTipTimer.current = window.setTimeout(() => setClipboardTip(null), 900);
  }, []);
  /** 拖拽悬停目标窗格（自实现 DnD） */
  const [dragOver, setDragOver] = useState<{
    targetPaneId: number;
    op: "copy" | "move";
  } | null>(null);
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
  /** 设置 / 快捷键一览对话框 */
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  /** 主题（默认浅色，M5 持久化到 localStorage "rfm.theme"） */
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rfm.theme") === "dark";
    } catch {
      return false;
    }
  });
  /** 快捷键配置版本号：自定义键位变更时 +1，触发菜单/设置重渲染 */
  const [keymapVer, setKeymapVer] = useState(0);
  /** v0.8 界面字体大小（13px=100%，作用于整个界面，根缩放） */
  const [uiFontSize, setUiFontSize] = useState<number>(() => loadUiFontSize());
  /** v0.8.1 字体族 */
  const [uiFontFamily, setUiFontFamily] = useState<string>(() => loadUiFontFamily());
  /** v0.8.5 开屏飞鸟：React mount 后短暂显示，800ms 后淡出 */
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  /** 退出询问：拦截窗口关闭，询问是否保存会话布局（v0.3.0） */
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
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
  /** 内容搜索结果定位：目录加载完成后选中该文件 */
  const pendingSelectRef = useRef<string | null>(null);
  /** 已关闭标签页（恢复用） */
  const closedTabsRef = useRef<{ tab: TabState; index: number }[]>([]);

  const showError = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  /** v0.17 打开差异比对：需活动标签正好两个本地窗格（各指向一个目录） */
  const openDiff = useCallback(() => {
    if (!activeTab) return;
    const local = collectPaneIds(activeTab.root)
      .map((id) => activeTab.panes[id])
      .filter(
        (p): p is NonNullable<typeof p> =>
          !!p && !p.path.startsWith("sftp://") && !p.path.startsWith("http") && !p.tagId,
      );
    if (local.length !== 2) {
      showError("差异比对需要正好两个本地窗格（请先左右分屏，并各打开一个目录）");
      return;
    }
    setDiffTarget({ left: local[0].path, right: local[1].path });
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

  /**
   * 检查更新：GitHub Releases API 比对最新 tag。
   * silent=true 用于启动后台静默检查（仅在有新版时提示，不弹对话框）。
   */
  const checkUpdate = useCallback(
    async (silent = false) => {
      const current = appVersion || "0.0.0";
      try {
        const info = await fetchLatestRelease(current);
        if (!info) {
          if (!silent) {
            await messageDialog(`当前已是最新版本 v${current}`, { title: "检查更新" });
          }
          return;
        }
        if (silent) {
          showError(`发现新版本 v${info.version}（帮助 → 检查更新）`);
          return;
        }
        const go = await askDialog(
          `发现新版本 v${info.version}（当前 v${current}），是否前往下载？`,
          { title: "检查更新", kind: "info" },
        );
        if (go) void openUrl(info.url);
      } catch (e) {
        if (!silent) showError(`检查更新失败：${e}`);
      }
    },
    [appVersion, showError],
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
      refreshPlugins();
    }, 300);
    return () => window.clearTimeout(t);
  }, [refreshOpeners, refreshShells, refreshPlugins]);
  const handleOpenWith = useCallback(
    (toolId: string, path: string) => {
      void apiOpenWith(toolId, path).catch((e) => showError(`打开失败：${e}`));
    },
    [showError],
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
          if (path) void apiOpenWith(existing.id, path).catch((e) => showError(`打开失败：${e}`));
          return;
        }
        // 名称取可执行文件名（去掉 .app），无需再弹输入框（Tauri WKWebView 不支持 window.prompt）
        const name = basename(picked).replace(/\.app$/i, "");
        const item = await apiAddCustomOpener(name, picked, wanted);
        refreshOpeners();
        // 选定即用：直接用新注册的应用打开当前文件
        if (path) void apiOpenWith(item.id, path).catch((e) => showError(`打开失败：${e}`));
      } catch (e) {
        showError(`添加打开方式失败：${e}`);
      }
    },
    [openers, refreshOpeners, showError],
  );

  /** 设置面板：删除某个自定义打开方式 */
  const handleRemoveCustomOpener = useCallback(
    async (id: string) => {
      const o = openers.find((x) => x.id === id);
      if (!(await confirmDialog(`删除打开方式「${o?.name ?? id}」？`))) return;
      try {
        await apiRemoveCustomOpener(id);
        refreshOpeners();
      } catch (e) {
        showError(`删除打开方式失败：${e}`);
      }
    },
    [openers, refreshOpeners, showError],
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

  // 主题同步
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggleTheme = useCallback(() => {
    setDark((v) => {
      const nv = !v;
      try {
        localStorage.setItem("rfm.theme", nv ? "dark" : "light");
      } catch {
        /* ignore */
      }
      return nv;
    });
  }, []);



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

  /** 会话恢复（v0.3.0）：重建标签集合 + 分屏树 + pane 路径；SFTP 并发重连（需 master-key） */

  // 活动 pane 路径/刷新键变化时加载目录
  useEffect(() => {
    if (!activePane) return;
    // 虚拟标签目录：不请求后端，清空 entries（由 TagView 渲染）
    if (VIRTUAL_TAG_RE.test(activePane.path)) {
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
        setTabs((ts) =>
          ts.map((t) => {
            const p = t.panes[activePane.id];
            if (!p) return t;
            let selection = p.selection;
            const pending = pendingSelectRef.current;
            if (pending && entries.some((e) => e.path === pending)) {
              selection = [pending];
              pendingSelectRef.current = null;
            }
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
  const sftp = useSftp({ navigate: navigateVia, patchPane, listDir, showError });

  const navigate = useCallback(
    (path: string) => {
      if (!activePane) return;
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
          // 有 authority 但未连接：记住目标路径，弹连接框预填，连上后直达该路径
          sftp.rememberPendingPath(
            au.remotePath && au.remotePath !== "/" ? au.remotePath : null,
          );
          sftp.openConnect({ host: au.host, port: au.port, user: au.user });
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

  const restoreSession = useCallback(
    async (layout: SessionLayout) => {
      const remap = new Map<number, number>();
      const restored: TabState[] = [];
      const sftpPanes: { paneId: number; serverId: string; path: string }[] = [];
      for (const st of layout.tabs) {
        const panes: Record<number, PaneState> = {};
        const tabId = nextTabId++;
        for (const sp of st.panes) {
          const p = makePane(sp.path);
          if (typeof sp.zoom === "number" && sp.zoom >= 0.5 && sp.zoom <= 2) p.zoom = sp.zoom;
          remap.set(sp.id, p.id);
          if (sp.kind === "tag" && sp.tagId) p.tagId = sp.tagId;
          if (sp.kind === "sftp" && sp.serverId) {
            sftpPanes.push({ paneId: p.id, serverId: sp.serverId, path: sp.path });
          }
          panes[p.id] = p;
        }
        const root = remapNode(st.root as PaneNode, remap);
        const activePane = remap.get(st.activePane) ?? firstPaneId(root);
        restored.push({
          id: tabId,
          title: st.title || "",
          customTitle: st.customTitle,
          root,
          activePane,
          panes,
        });
      }
      if (restored.length === 0) return;
      setTabs(restored);
      const idx = Math.min(Math.max(layout.activeTab, 0), restored.length - 1);
      setActiveId(restored[idx].id);
      // 显式加载所有窗格（listDir effect 只监听活动 pane，非活动窗格不会自动加载）
      const loadPaneNow = async (paneId: number, path: string) => {
        try {
          const entries = await listDir(path);
          patchPane(paneId, { entries, loading: false, error: null });
        } catch (e) {
          patchPane(paneId, { loading: false, error: String(e) });
        }
      };
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
      await Promise.all(
        sftpPanes.map(async (sp) => {
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
        }),
      );
    },
    [patchPane, sftp],
  );

  // 首次启动
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      try {
        const [home, vols, qa] = await Promise.all([
          getHomeDir(),
          getVolumes(),
          getQuickAccess(),
        ]);
        setHomePath(home);
        setVolumes(vols);
        setQuickAccess(qa);
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

  /** 退出：保存当前会话布局后退出进程（exit 兜底，避免 destroy 链路挂起） */
  const handleExitWithSave = useCallback(async () => {
    try {
      await sessionSave(serializeSession(tabsRef.current, activeIdRef.current));
    } catch {
      /* 保存失败不阻塞退出 */
    }
    await exit(0).catch(() => getCurrentWindow().destroy());
  }, []);

  /** 退出：不保存，直接退出进程 */
  const handleExitNoSave = useCallback(async () => {
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
          closedTabsRef.current.push({ tab: target, index: idx });
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
        pendingSelectRef.current = filePath;
        navigate(dir);
      }
    },
    [activePane, navigate, selectRange],
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

  /** 用系统关联程序打开文件（按扩展名 / 协议）；http 走浏览器，sftp 先下载到临时目录 */
  const openFileExternal = useCallback(
    (path: string) => {
      if (path.startsWith("http://") || path.startsWith("https://")) {
        openUrl(path).catch((e) => showError(`打开 URL 失败：${e}`));
      } else if (path.startsWith("sftp://")) {
        showError("正在下载远程文件…");
        sftpDownload(path)
          .then((local) => openPath(local))
          .catch((e) => showError(`远程打开失败：${e}`));
      } else {
        openPath(path).catch((e) => showError(`打开失败：${e}`));
      }
    },
    [showError],
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
      void clipboardWriteFiles(list).catch(() => {});
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
      void clipboardWriteFiles(list).catch(() => {});
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
   */
  const runTransfer = useCallback(
    async (
      op: "copy" | "move",
      paths: string[],
      dest: string,
    ): Promise<{ created?: string[]; moved?: [string, string][] } | null> => {
      const conflicts = await scanConflicts(paths, dest);
      let plan: ResolutionPlan = {};
      if (conflicts.length > 0) {
        const decision = await promptConflicts(conflicts);
        if (!decision) return null;
        plan = decision;
      }
      if (op === "move") {
        return { moved: await moveEntriesPlan(paths, dest, plan) };
      }
      return { created: await copyEntriesPlan(paths, dest, plan) };
    },
    [promptConflicts],
  );

  /** 删除文件夹确认弹窗 */
  const [confirmDelete, setConfirmDelete] = useState<{
    paneId: number;
    paths: string[];
  } | null>(null);

  /** v0.16 属性弹窗：右键「属性」选中的条目（目录递归统计大小） */
  const [propertiesEntries, setPropertiesEntries] = useState<FileEntry[] | null>(null);

  /** v0.17 差异比对窗口：左右两个本地目录 */
  const [diffTarget, setDiffTarget] = useState<{ left: string; right: string } | null>(null);

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
  /** 自定义快捷访问（持久化） */
  const [customQuick, setCustomQuick] = useState<string[]>(() => loadCustomQuick());
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

  const toggleQuick = useCallback((path: string) => {
    setCustomQuick((prev) => {
      const next = prev.includes(path)
        ? prev.filter((p) => p !== path)
        : [...prev, path];
      saveCustomQuick(next);
      return next;
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

  /** 撤销/重做栈：只记录可安全反向的操作 */
  const pushOp = useCallback((op: FileOp) => {
    setUndoStack((s) => [...s.slice(-49), op]);
    setRedoStack([]);
  }, []);

  const doPaste = useCallback(
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
      if (srcs.length === 0) {
        srcs = await clipboardReadFiles().catch(() => []);
        op = "copy";
        if (srcs.length === 0) return;
      }
      const isCut = op === "cut";
      const localSrcs = srcs.filter((p) => !isSftpPath(p));
      const sftpSrcs = srcs.filter((p) => isSftpPath(p));
      const destIsSftp = isSftpPath(dest);
      try {
        if (destIsSftp) {
          // 目标远程：仅支持本地 → 远程上传；远程→远程暂不支持
          if (sftpSrcs.length > 0) {
            showError("双端远程传输暂不支持（方案已评估保留）");
            if (localSrcs.length === 0) return;
          }
          for (const src of localSrcs) {
            await sftpUpload(src, dest, basename(src));
          }
          setClipboard(null);
          refreshPane(pid);
          return;
        }
        // 目标本地
        for (const src of sftpSrcs) {
          await sftpDownloadTo(dest, src);
        }
        if (localSrcs.length > 0) {
          const r = await runTransfer(isCut ? "move" : "copy", localSrcs, dest);
          if (r === null) return; // 用户「停止」：保留剪贴板，不清理
          if (r.moved) {
            pushOp({ kind: "move", pairs: r.moved, dest, srcPane: pid, destPane: pid });
          } else if (r.created) {
            pushOp({
              kind: "copy",
              src: localSrcs,
              created: r.created,
              dest,
              srcPane: pid,
              destPane: pid,
            });
          }
        }
        if (sftpSrcs.length > 0 && localSrcs.length === 0 && isCut) {
          // 纯远程剪切粘贴：v0.2 按复制处理（不删源）
          showError("远程剪切暂按复制处理（不删除源文件）");
        }
        setClipboard(null);
        refreshPane(pid);
      } catch (e) {
        showError(String(e));
      }
    },
    [clipboard, activePane, tabs, refreshPane, showError, pushOp, isSftpPath, runTransfer],
  );

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
      showError(String(e));
    }
  }, [activePane, refreshPane, showError, pushOp, runTransfer]);

  /** 跨窗格拖拽落盘：目标 pane 的路径执行复制/移动，源、目标均刷新 */
  const doDropPaths = useCallback(
    async (sourcePaneId: number, paths: string[], op: "copy" | "move", targetPaneId: number) => {
      const target = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === targetPaneId);
      if (!target || target.path === "") return;
      const dest = target.path;
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
          refreshPane(targetPaneId);
          refreshPane(sourcePaneId);
          return;
        }
        // 远程 ⇄ 远程：暂不支持（方案已评估保留）
        if (srcIsSftp && destIsSftp) {
          showError("双端远程传输暂不支持");
          return;
        }
        // 远程 → 本地：下载
        if (srcIsSftp && !destIsSftp) {
          for (const p of paths) {
            await sftpDownloadTo(dest, p);
          }
          refreshPane(targetPaneId);
          refreshPane(sourcePaneId);
          return;
        }
        // 本地 → 远程：上传
        if (!srcIsSftp && destIsSftp) {
          for (const p of paths) {
            await sftpUpload(p, dest, basename(p));
          }
          refreshPane(targetPaneId);
          refreshPane(sourcePaneId);
          return;
        }
        // 本地 ⇄ 本地：带冲突裁决
        const r = await runTransfer(op, paths, dest);
        if (r === null) return; // 用户「停止」
        if (r.moved) {
          pushOp({ kind: "move", pairs: r.moved, dest, srcPane: sourcePaneId, destPane: targetPaneId });
        } else if (r.created) {
          pushOp({
            kind: "copy",
            src: paths,
            created: r.created,
            dest,
            srcPane: sourcePaneId,
            destPane: targetPaneId,
          });
        }
        refreshPane(targetPaneId);
        refreshPane(sourcePaneId);
      } catch (e) {
        showError(String(e));
      }
    },
    [tabs, refreshPane, showError, pushOp, isSftpPath, isHttpPath, runTransfer],
  );

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
    [renaming, refreshPane, showError, pushOp, isSftpPath],
  );

  const doDeleteNow = useCallback(
    async (p: number, list: string[]) => {
      try {
        if (list.length > 0 && isSftpPath(list[0])) {
          await sftpDelete(list);
        } else {
          await deleteEntries(list);
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
    [refreshPane, showError, isSftpPath],
  );

  const doDelete = useCallback(
    async (paneId?: number, paths?: string[]) => {
      const p = paneId !== undefined ? paneId : activePane?.id;
      const list = paths ?? activePane?.selection ?? [];
      if (p === undefined || list.length === 0) return;
      // 删除文件夹前弹确认框（文件直接进回收站）
      const pane = tabs.flatMap((t) => Object.values(t.panes)).find((x) => x.id === p);
      const hasDir = !!pane?.entries.some((e) => e.is_dir && list.includes(e.path));
      if (hasDir) {
        setConfirmDelete({ paneId: p, paths: list });
        return;
      }
      void doDeleteNow(p, list);
    },
    [activePane, tabs, doDeleteNow],
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
    if (!(await confirmDialog(`永久删除 ${list.length} 项？此操作不可恢复。`))) return;
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
  }, [activePane, refreshPane, showError, isSftpPath]);

  const createAndRename = useCallback(
    async (paneId: number, kind: "dir" | "file") => {
      const pane = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === paneId);
      if (!pane) return;
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
    toggleTheme: () => toggleTheme(),
    openSettings: () => setSettingsOpen(true),
    openHelp: () => setSettingsOpen(true),
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      // 输入框聚焦时拦截"刷新"类快捷键，避免漏到 WebView 触发整页重载（状态全丢）
      if (typing) {
        const combo = keyEventString(e);
        if (combo === "f5" || combo === "mod+r") {
          e.preventDefault();
          actionsRef.current.refresh?.();
        }
        return;
      }
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

  // SplitView handlers
  const handlers: PaneHandlers = {
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
    pluginOpener: plugins?.find((p) => p.id === "opener")?.enabled ?? true,
    pluginTerminal: plugins?.find((p) => p.id === "terminal")?.enabled ?? true,
    onOpenWith: handleOpenWith,
    onOpenTerminal: handleOpenTerminal,
    onAddCustomOpener: handleAddCustomOpener,
    onCopy: (paneId, paths) => doCopy(paneId, paths),
    onCut: (paneId, paths) => doCut(paneId, paths),
    onDelete: (paneId, paths) => void doDelete(paneId, paths),
    onRename: startRename,
    onRenameCommit: (path, name) => void commitRename(path, name),
    onRenameCancel: () => setRenaming(null),
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
    onSelectAll: selectAllIn,
    onInvertSelection: invertSelectionIn,
    onToggleTag: toggleTag,
    onToggleQuick: toggleQuick,
    onZoomChange: setPaneZoom,
    onBack: goBack,
    onForward: goForward,
    onCompress: (paneId, paths, fmt) => void doCompress(paneId, paths, fmt),
    onProperties: (list) => setPropertiesEntries(list),
  };

  const selectedSize = activePane
    ? activePane.entries
        .filter((e) => activePane.selection.includes(e.path))
        .reduce((s, e) => s + e.size, 0)
    : 0;

  /** 地址栏显示路径（v0.14）：单选文件时直接显示其完整路径；否则当前目录 */
  const addressPath = (() => {
    if (!activePane) return "";
    if (activePane.selection.length === 1) return activePane.selection[0];
    const m = activePane.path.match(VIRTUAL_TAG_RE);
    return m ? tagTitle(m[1], tagNames) : activePane.path;
  })();

  return (
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
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <MenuBar
        keymapVersion={keymapVer}
        onNewTab={newTab}
        onCloseTab={() => activeTab && closeTab(activeTab.id)}
        onQuit={() => exit(0).catch(() => window.close())}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        onHome={() => homePath && navigate(homePath)}
        onRefresh={refresh}
        onToggleHidden={() => setShowHidden((v) => !v)}
        showExtensions={showExtensions}
        onToggleExtensions={toggleExtensions}
        onToggleSearch={toggleSearchPanel}
        onCopy={() => doCopy()}
        onCut={() => doCut()}
        onPaste={() => void doPaste()}
        canPaste={!!activePane}
        onRename={() => {
          if (activePane?.selection.length === 1) {
            const e = activePane.entries.find((x) => x.path === activePane.selection[0]);
            if (e) startRename(activePane.id, e);
          }
        }}
        canRename={(activePane?.selection.length ?? 0) === 1}
        onDelete={() => void doDelete()}
        canDelete={(activePane?.selection.length ?? 0) > 0}
        onNewFolder={() => activePane && void createAndRename(activePane.id, "dir")}
        onNewFile={() => activePane && void createAndRename(activePane.id, "file")}
        onCopyPath={() => {
          if (activePane?.selection[0]) copyPath(activePane.selection[0]);
        }}
        onUndo={() => void undo()}
        canUndo={undoStack.length > 0}
        onRedo={() => void redo()}
        canRedo={redoStack.length > 0}
        onDuplicate={() => void doDuplicate()}
        canDuplicate={(activePane?.selection.length ?? 0) > 0}
        onToggleProperties={() => setShowProperties((v) => !v)}
        onSplitRow={() => splitPane("row")}
        onSplitCol={() => splitPane("col")}
        onClosePane={closePane}
        canClosePane={!!activeTab && !isSinglePane(activeTab.root)}
        onFocusNextPane={focusNextPane}
        onOpenDiff={openDiff}
        showHidden={showHidden}
        searchOpen={searchOpen}
        dark={dark}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
        appName={appName}
        appVersion={appVersion}
        onOpenRepo={openRepo}
        onCheckUpdate={() => void checkUpdate(false)}
      />

      <TabBar
        tabs={tabs.map((t) => ({ id: t.id, title: t.customTitle ?? t.title }))}
        activeId={activeId}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
        onReorder={reorderTab}
        onRename={renameTab}
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
        path={addressPath}
        cwd={activePane?.path ?? homePath}
        onNavigate={navigate}
        searchOpen={searchOpen}
        onToggleSearch={toggleSearchPanel}
        focusTick={addressFocusTick}
        trailing={<PaneListMenu panes={paneList} onActivate={activatePane} />}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          quickAccess={quickAccess}
          volumes={volumes}
          currentPath={activePane?.path ?? ""}
          onNavigate={navigate}
          onMiddleOpen={(path) => newTab(path)}
          customQuick={customQuick}
          onRemoveQuick={toggleQuick}
          tagCounts={Object.fromEntries(TAG_DEFS.map((t) => [t.id, tagPaths(t.id).length]))}
          tagNames={tagNames}
          onRenameTag={renameTag}
          activeTagId={activePane?.tagId ?? null}
          onSelectTag={(tagId) => navigate(`tags://${tagId}`)}
          sftpServers={plugins?.find((p) => p.id === "sftp")?.enabled === false ? [] : sftp.servers}
          onSftpOpen={sftp.openServer}
          onSftpDisconnect={sftp.disconnect}
          onSftpEdit={sftp.editServer}
          onSftpRemove={sftp.removeServer}
        />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab ? (
            <SplitView
              node={activeTab.root}
              panes={activeTab.panes}
              activePaneId={activeTab.activePane}
              showHidden={showHidden}
              showExtensions={showExtensions}
              showProperties={showProperties}
              canPaste={!!activePane}
              renaming={renaming}
              dragOver={dragOver}
              fileTags={fileTags}
              tagNames={tagNames}
              onRenameTag={renameTag}
              customQuick={customQuick}
              onOpenTagFile={openTagFile}
              onExitTag={exitTagViewForPane}
              highlight={!(activeTab && isSinglePane(activeTab.root))}
              handlers={handlers}
            />
          ) : null}
        </div>

        {searchOpen && searchPane && (
          <SearchPanel
            entries={searchPane.entries}
            dir={searchPane.path}
            cmd={searchCmd}
            onClose={closeSearchPanel}
            onReveal={revealPath}
            onOpenFile={openFileExternal}
            onCopyPath={copyPath}
          />
        )}
      </div>

      <StatusBar
        path={activePane?.path ?? ""}
        total={activePane?.entries.length ?? 0}
        selected={activePane?.selection ?? []}
        selectedSize={selectedSize}
        showHidden={showHidden}
        error={activePane?.error ?? null}
        notice={notice}
        transfer={transfer}
        onCancelDownload={(url) => void cancelHttpDownload(url)}
        onSharePanel={() => setSharePanelOpen(true)}
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
        onClose={() => setSettingsOpen(false)}
        dark={dark}
        onToggleTheme={toggleTheme}
        onBindingsChanged={() => setKeymapVer((v) => v + 1)}
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
        appName={appName}
        appVersion={appVersion}
        onOpenRepo={openRepo}
        onCheckUpdate={() => void checkUpdate(false)}
      />

      <ConnectDialog
        open={sftp.connectOpen}
        initial={sftp.connectInitial}
        masterKey={sftp.masterKeyStatus}
        onNeedMasterKey={sftp.requestMasterKey}
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

      {/* 同名冲突裁决弹窗 */}
      {conflictReq && (
        <ConflictDialog conflicts={conflictReq} onDone={finishConflicts} />
      )}

      {/* 删除文件夹确认弹窗 */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDelete(null);
          }}
        >
          <div className="w-[380px] max-w-[92vw] rounded-lg border bg-background p-4 shadow-xl">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Trash2 className="h-4 w-4 text-destructive" /> 确认删除
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              将删除 {confirmDelete.paths.length} 个项目（含文件夹），移入回收站。
              <br />
              文件夹的删除需要确认，文件删除不弹此框。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={confirmDeleteNow}
                autoFocus
              >
                删除
              </Button>
            </div>
          </div>
        </div>
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
          onSynced={() => {
            if (activeTab) {
              for (const p of Object.values(activeTab.panes)) refreshPane(p.id);
            }
          }}
        />
      )}

      {/* v0.14 复制/剪切成功提示：窗内居中，约 1 秒消失 */}
      {clipboardTip && (
        <div
          key={clipboardTip.tick}
          className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center"
        >
          <div className="rounded-lg border border-primary/25 bg-background/90 px-5 py-2.5 text-sm font-medium text-foreground shadow-xl backdrop-blur-sm">
            {clipboardTip.text}
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
              下次启动可恢复当前标签页、分屏布局与各窗格路径。
              <br />
              SFTP 远程目录需验证主密钥后恢复，否则显示占位。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCloseDialogOpen(false)}>
                取消
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleExitNoSave()}>
                不保存
              </Button>
              <Button size="sm" onClick={() => void handleExitWithSave()} autoFocus>
                保存并退出
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
