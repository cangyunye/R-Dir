import { useCallback, useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  listOpeners as apiListOpeners,
  listPlugins as apiListPlugins,
  setPluginEnabled as apiSetPluginEnabled,
  openWith as apiOpenWith,
  addCustomOpener as apiAddCustomOpener,
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
  SessionLayout,
  SortDir,
  SortKey,
  SplitDir,
  TabState,
  TransferProgress,
  VolumeInfo,
} from "@/lib/types";
import {
  copyEntries,
  createDir,
  createFile,
  deleteEntries,
  getHomeDir,
  getQuickAccess,
  getVolumes,
  listDir,
  moveEntries,
  parentDir,
  permanentDeleteEntries,
  renameEntry,
  sftpConnect,
  sftpCreateFile,
  sftpDelete,
  sftpDownload,
  sftpDownloadTo,
  sftpListServers,
  sftpMasterKeyStatus,
  sftpMkdir,
  sftpRename,
  sftpSaveServer,
  sftpRemoveServer,
  sftpDisconnect,
  sftpUpload,
  sessionLoad,
  sessionSave,
  statPath,
} from "@/lib/api";
import { ConnectDialog, type SftpConnectInitial } from "@/components/ConnectDialog";
import { MasterKeyDialog } from "@/components/MasterKeyDialog";
import type { MasterKeyStatus, SftpServerConfig, SftpServerView } from "@/lib/types";
import { basename } from "@/lib/format";
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
import {
  loadCustomQuick,
  loadFileTags,
  parentOf,
  saveCustomQuick,
  saveFileTags,
  tagById,
  TAG_DEFS,
  type FileTags,
} from "@/lib/persist";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
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
      activePane: t.activePane,
      root: t.root,
      panes: Object.values(t.panes).map((p) => {
        if (p.path.startsWith("sftp://")) {
          return {
            id: p.id,
            path: p.path,
            kind: "sftp",
            serverId: sftpAuthorityId(p.path) ?? undefined,
          };
        }
        if (p.tagId) return { id: p.id, path: p.path, kind: "tag", tagId: p.tagId };
        return { id: p.id, path: p.path, kind: "local" };
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

function tagTitle(tagId: string): string {
  return `标签：${tagById(tagId)?.label ?? tagId}`;
}
import { TabBar } from "@/components/TabBar";
import { Toolbar } from "@/components/Toolbar";
import { Sidebar } from "@/components/Sidebar";
import { SplitView, type PaneHandlers } from "@/components/SplitView";
import { SearchPanel } from "@/components/SearchPanel";
import { StatusBar } from "@/components/StatusBar";
import { SettingsDialog } from "@/components/SettingsDialog";

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
  const [homePath, setHomePath] = useState("");
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [renaming, setRenaming] = useState<{
    paneId: number;
    path: string;
    name: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  /** 退出询问：拦截窗口关闭，询问是否保存会话布局（v0.3.0） */
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  /** 最新 tabs/activeId（退出保存用，避免闭包过期） */
  const tabsRef = useRef<TabState[]>([]);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // ==================== SFTP 远程服务器（v0.2 插件） ====================
  const [sftpServers, setSftpServers] = useState<SftpServerView[]>([]);
  /** 已连接 id 集合（ref 同步，供 navigate 同步判断） */
  const sftpConnectedRef = useRef<Set<string>>(new Set());
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectInitial, setConnectInitial] = useState<SftpConnectInitial | null>(null);
  /** master-key 状态：configured（曾设置）/ active（本会话已输入） */
  const [masterKeyStatus, setMasterKeyStatus] = useState<MasterKeyStatus>({
    configured: false,
    active: false,
  });
  const [masterKeyOpen, setMasterKeyOpen] = useState(false);
  /** 主密钥设置后待重连的服务器（来自连接框解密失败） */
  const pendingConnectRef = useRef<SftpServerConfig | null>(null);
  /** 会话恢复中挂起的 SFTP 连接（master-key 输入成功后重试） */
  const pendingSftpRestoreRef = useRef<{ paneId: number; serverId: string; path: string }[]>([]);
  /** 主密钥设置后待保存的服务器（来自连接成功但保存失败） */
  const pendingSaveRef = useRef<SftpServerConfig | null>(null);

  // ==================== 传输/复制进度（本地 + SFTP） ====================
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);

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

  const syncSftpConnected = useCallback((list: SftpServerView[]) => {
    sftpConnectedRef.current = new Set(list.filter((s) => s.connected).map((s) => s.id));
  }, []);

  const openConnect = useCallback((initial?: SftpConnectInitial | null) => {
    setConnectInitial(initial ?? null);
    setConnectOpen(true);
  }, []);

  /** 解析 sftp://user@host:port 的 authority */
  const parseSftpAuthority = useCallback((path: string): { id: string; host: string; port: number; user: string } | null => {
    const rest = path.startsWith("sftp://") ? path.slice("sftp://".length) : path;
    const authority = rest.split("/")[0] ?? "";
    const [userPart, hostPort] = authority.includes("@")
      ? authority.split("@")
      : ["", authority];
    if (!userPart || !hostPort) return null;
    const [host, portStr] = hostPort.includes(":") ? hostPort.split(":") : [hostPort, "22"];
    const port = Number(portStr) || 22;
    return { id: `${userPart}@${host}:${port}`, host, port, user: userPart };
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activePane = activeTab?.panes[activeTab.activePane] ?? null;
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
  useEffect(() => {
    refreshOpeners();
    refreshShells();
    refreshPlugins();
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
  const handleAddCustomOpener = useCallback(async () => {
    try {
      const picked = await openDialog({
        title: "选择可执行文件",
        multiple: false,
        directory: false,
      });
      if (!picked || Array.isArray(picked)) return;
      const name = window.prompt("为该程序输入显示名称：", "");
      if (!name || !name.trim()) return;
      await apiAddCustomOpener(name.trim(), picked, []);
      refreshOpeners();
    } catch (e) {
      showError(`添加打开方式失败：${e}`);
    }
  }, [refreshOpeners, showError]);

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
      } catch (e) {
        console.error("启动失败", e);
      }
    })();
    // SFTP 服务器清单（v0.2）
    sftpListServers()
      .then((list) => {
        syncSftpConnected(list);
        setSftpServers(list);
      })
      .catch(() => {});
    // master-key 状态（configured 曾设置 / active 本会话已输入）
    sftpMasterKeyStatus()
      .then(setMasterKeyStatus)
      .catch(() => {});
  }, [syncSftpConnected]);

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
          remap.set(sp.id, p.id);
          if (sp.kind === "tag" && sp.tagId) p.tagId = sp.tagId;
          if (sp.kind === "sftp" && sp.serverId) {
            sftpPanes.push({ paneId: p.id, serverId: sp.serverId, path: sp.path });
          }
          panes[p.id] = p;
        }
        const root = remapNode(st.root as PaneNode, remap);
        const activePane = remap.get(st.activePane) ?? firstPaneId(root);
        restored.push({ id: tabId, title: st.title || "", root, activePane, panes });
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
      for (const t of restored) {
        for (const p of Object.values(t.panes)) {
          if (!p.path.startsWith("sftp://")) localPanes.push({ paneId: p.id, path: p.path });
        }
      }
      void Promise.all(localPanes.map((lp) => loadPaneNow(lp.paneId, lp.path)));
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
            sftpConnectedRef.current.add(sp.serverId);
            await loadPaneNow(sp.paneId, sp.path);
            void syncSftpConnected(
              sftpServers.map((s) => (s.id === sp.serverId ? { ...s, connected: true } : s)),
            );
          } catch (e) {
            const msg = String(e);
            if (msg.includes("NEED_MASTER_KEY")) {
              pendingSftpRestoreRef.current.push(sp);
              setMasterKeyOpen(true);
            } else {
              patchPane(sp.paneId, { error: `会话未恢复：SFTP 需要验证（${msg}）` });
            }
          }
        }),
      );
    },
    [patchPane, syncSftpConnected, sftpServers],
  );

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
  const navigate = useCallback(
    (path: string) => {
      if (!activePane || activePane.path === path) return;
      // SFTP：未连接的服务器先弹连接对话框
      if (path.startsWith("sftp://")) {
        const au = parseSftpAuthority(path);
        if (au && !sftpConnectedRef.current.has(au.id)) {
          openConnect({ host: au.host, port: au.port, user: au.user });
          return;
        }
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
    [activePane, patchPane, parseSftpAuthority, openConnect],
  );

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

  /** 连接成功：保存清单 + 刷新状态 + 导航到服务器默认目录（root 或 home） */
  const handleSftpConnected = useCallback(
    async (config: SftpServerConfig, view?: SftpServerView) => {
      let list: SftpServerView[] | null = null;
      try {
        list = await sftpSaveServer(config);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("NEED_MASTER_KEY")) {
          // 勾选"记住密码"但未设置主密钥 → 挂起保存，弹主密钥框
          pendingSaveRef.current = config;
          setMasterKeyOpen(true);
          return;
        }
        showError(`保存服务器失败：${e}`);
      }
      if (!list) list = await sftpListServers().catch(() => []);
      syncSftpConnected(list);
      setSftpServers(list);
      const v = view ?? list.find((s) => s.id === config.id);
      const remote = v?.defaultRemote || "/";
      navigate(`sftp://${config.user}@${config.host}:${config.port}${remote}`);
    },
    [navigate, showError, syncSftpConnected],
  );

  /** 主密钥设置/验证成功后的统一处理：刷新状态 → 重试挂起的保存或连接 */
  const handleMasterKeyDone = useCallback(
    async (ok: boolean) => {
      setMasterKeyOpen(false);
      if (!ok) {
        // 用户取消：放弃所有挂起的连接/保存/会话恢复，保持布局不连接、不刷新
        pendingSaveRef.current = null;
        pendingConnectRef.current = null;
        const pending = pendingSftpRestoreRef.current;
        pendingSftpRestoreRef.current = [];
        for (const sp of pending) {
          patchPane(sp.paneId, { loading: false, error: "SFTP 未连接（需要主密钥验证）" });
        }
        return;
      }
      try {
        const st = await sftpMasterKeyStatus();
        setMasterKeyStatus(st);
      } catch {
        /* 忽略 */
      }
      // 1) 挂起的保存（连接成功但保存密码需主密钥）
      if (pendingSaveRef.current) {
        const cfg = pendingSaveRef.current;
        pendingSaveRef.current = null;
        await handleSftpConnected(cfg);
        return;
      }
      // 2) 挂起的连接（连接框解密已保存密码需主密钥）
      if (pendingConnectRef.current) {
        const cfg = pendingConnectRef.current;
        pendingConnectRef.current = null;
        setConnectOpen(false);
        try {
          await sftpConnect(cfg);
          await handleSftpConnected(cfg);
        } catch (e) {
          showError(`连接失败：${e}`);
        }
      }
      // 3) 挂起的会话恢复连接（主密钥验证后重试）
      const pending = pendingSftpRestoreRef.current;
      if (pending.length > 0) {
        pendingSftpRestoreRef.current = [];
        for (const sp of pending) {
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
            sftpConnectedRef.current.add(sp.serverId);
            const entries = await listDir(sp.path);
            patchPane(sp.paneId, { entries, loading: false, error: null });
          } catch (e) {
            patchPane(sp.paneId, { error: `会话未恢复：SFTP 需要验证（${e}）` });
          }
        }
      }
    },
    [handleSftpConnected, showError, patchPane],
  );

  /** 连接框需要主密钥：记录挂起连接并弹出主密钥框 */
  const requestMasterKey = useCallback((config: SftpServerConfig) => {
    pendingConnectRef.current = config;
    setMasterKeyOpen(true);
  }, []);

  /** 侧边栏点击服务器：已连接直达（默认目录）；已保存凭据 → 一键重连；否则弹连接框 */
  const openSftpServer = useCallback(
    (sv: SftpServerView) => {
      if (sftpConnectedRef.current.has(sv.id)) {
        navigate(`sftp://${sv.user}@${sv.host}:${sv.port}${sv.defaultRemote || "/"}`);
        return;
      }
      if (sv.hasSecret) {
        // 已保存密码/口令：后端从 servers.json 取密文（master-key 解密）直接重连
        const cfg: SftpServerConfig = {
          id: sv.id,
          name: sv.name,
          host: sv.host,
          port: sv.port,
          user: sv.user,
          root: sv.root ?? null,
          group: sv.group,
          auth: sv.auth === "key" ? "publicKey" : "password",
          ...(sv.auth === "key"
            ? { keyPath: "", savePassphrase: true }
            : { password: "", savePassword: true }),
        };
        void (async () => {
          try {
            const view = await sftpConnect(cfg);
            await handleSftpConnected(cfg, view);
          } catch (e) {
            const msg = String(e);
            if (msg.includes("NEED_MASTER_KEY")) {
              // 主密钥未输入 → 挂起连接，弹主密钥框后自动重试
              pendingConnectRef.current = cfg;
              setMasterKeyOpen(true);
              return;
            }
            // 重连失败（如凭据已失效）→ 回退弹连接框让用户输入
            openConnect({ host: sv.host, port: sv.port, user: sv.user, name: sv.name });
            showError(`重连失败：${e}`);
          }
        })();
        return;
      }
      openConnect({ host: sv.host, port: sv.port, user: sv.user, name: sv.name });
    },
    [navigate, openConnect, showError, handleSftpConnected],
  );

  /** 侧边栏右键"编辑"：回填连接框（含 root/分组/认证方式） */
  const handleSftpEdit = useCallback(
    (sv: SftpServerView) => {
      openConnect({
        id: sv.id,
        host: sv.host,
        port: sv.port,
        user: sv.user,
        name: sv.name,
        root: sv.root ?? "",
        group: sv.group,
        auth: sv.auth === "key" ? "publicKey" : "password",
      });
    },
    [openConnect],
  );

  /** 侧边栏右键"删除服务器配置"（连接不断开） */
  const handleSftpRemove = useCallback(
    async (sv: SftpServerView) => {
      if (!window.confirm(`删除服务器配置「${sv.name}」？连接不会断开。`)) return;
      try {
        const list = await sftpRemoveServer(sv.id);
        syncSftpConnected(list);
        setSftpServers(list);
      } catch (e) {
        showError(`删除服务器失败：${e}`);
      }
    },
    [showError, syncSftpConnected],
  );

  const handleSftpDisconnect = useCallback(
    async (id: string) => {
      try {
        await sftpDisconnect(id);
        const list = await sftpListServers();
        syncSftpConnected(list);
        setSftpServers(list);
      } catch (e) {
        showError(`断开失败：${e}`);
      }
    },
    [showError, syncSftpConnected],
  );

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
        if (target) closedTabsRef.current.push({ tab: target, index: idx });
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
        if (entry.path.startsWith("sftp://")) {
          // 远程文件：先下载到临时目录再打开
          showError("正在下载远程文件…");
          sftpDownload(entry.path)
            .then((local) => openPath(local))
            .catch((e) => showError(`远程打开失败：${e}`));
        } else {
          openPath(entry.path).catch((e) => showError(`打开失败：${e}`));
        }
      }
    },
    [showError],
  );

  const copyPath = useCallback((path: string) => {
    navigator.clipboard?.writeText(path).catch(() => {});
  }, []);

  // M1 文件操作
  const isSftpPath = useCallback((p: string) => p.startsWith("sftp://"), []);

  const doCopy = useCallback(
    (paneId?: number, paths?: string[]) => {
      const p = paneId !== undefined ? paneId : activePane?.id;
      const list = paths ?? activePane?.selection ?? [];
      if (p === undefined || list.length === 0) return;
      setClipboard({ op: "copy", paths: list });
    },
    [activePane],
  );

  const doCut = useCallback(
    (paneId?: number, paths?: string[]) => {
      const p = paneId !== undefined ? paneId : activePane?.id;
      const list = paths ?? activePane?.selection ?? [];
      if (p === undefined || list.length === 0) return;
      setClipboard({ op: "cut", paths: list });
    },
    [activePane],
  );

  /** 删除文件夹确认弹窗 */
  const [confirmDelete, setConfirmDelete] = useState<{
    paneId: number;
    paths: string[];
  } | null>(null);

  /** 文件标签（path → tagId[]，持久化） */
  const [fileTags, setFileTags] = useState<FileTags>(() => loadFileTags());
  /** 自定义快捷访问（持久化） */
  const [customQuick, setCustomQuick] = useState<string[]>(() => loadCustomQuick());

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
      if (!clipboard) return;
      const pid = paneId ?? activePane?.id;
      if (pid === undefined) return;
      const pane = tabs
        .flatMap((t) => Object.values(t.panes))
        .find((p) => p.id === pid);
      if (!pane) return;
      const dest = pane.path;
      const srcs = clipboard.paths;
      const isCut = clipboard.op === "cut";
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
          if (isCut) {
            const pairs = await moveEntries(localSrcs, dest);
            pushOp({ kind: "move", pairs, dest, srcPane: pid, destPane: pid });
          } else {
            const created = await copyEntries(localSrcs, dest);
            pushOp({
              kind: "copy",
              src: localSrcs,
              created,
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
    [clipboard, activePane, tabs, refreshPane, showError, pushOp, isSftpPath],
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
      const created = await copyEntries(activePane.selection, dest);
      pushOp({
        kind: "copy",
        src: activePane.selection,
        created,
        dest,
        srcPane: paneId,
        destPane: paneId,
      });
      refreshPane(paneId);
    } catch (e) {
      showError(String(e));
    }
  }, [activePane, refreshPane, showError, pushOp]);

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
      try {
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
        // 本地 ⇄ 本地：原逻辑
        if (op === "move") {
          const pairs = await moveEntries(paths, dest);
          pushOp({ kind: "move", pairs, dest, srcPane: sourcePaneId, destPane: targetPaneId });
        } else {
          const created = await copyEntries(paths, dest);
          pushOp({
            kind: "copy",
            src: paths,
            created,
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
    [tabs, refreshPane, showError, pushOp, isSftpPath],
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
    if (!window.confirm(`永久删除 ${list.length} 项？此操作不可恢复。`)) return;
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
  const openSearch = useCallback((tab: "name" | "content") => {
    setSearchOpen(true);
    setSearchCmd({ tab, tick: Date.now() });
  }, []);

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
    onPaste: (paneId) => void doPaste(paneId),
    onSelectAll: selectAllIn,
    onInvertSelection: invertSelectionIn,
    onToggleTag: toggleTag,
    onToggleQuick: toggleQuick,
  };

  const selectedSize = activePane
    ? activePane.entries
        .filter((e) => activePane.selection.includes(e.path))
        .reduce((s, e) => s + e.size, 0)
    : 0;

  return (
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
        onToggleSearch={() => setSearchOpen((v) => !v)}
        onCopy={() => doCopy()}
        onCut={() => doCut()}
        onPaste={() => void doPaste()}
        canPaste={!!clipboard && !!activePane}
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
        showHidden={showHidden}
        searchOpen={searchOpen}
        dark={dark}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <TabBar
        tabs={tabs.map((t) => ({ id: t.id, title: t.title }))}
        activeId={activeId}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
        onReorder={reorderTab}
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
        path={activePane?.path ?? ""}
        cwd={activePane?.path ?? homePath}
        onNavigate={navigate}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((v) => !v)}
        focusTick={addressFocusTick}
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
          activeTagId={activePane?.tagId ?? null}
          onSelectTag={(tagId) => navigate(`tags://${tagId}`)}
          sftpServers={plugins?.find((p) => p.id === "sftp")?.enabled === false ? [] : sftpServers}
          onSftpOpen={openSftpServer}
          onSftpDisconnect={handleSftpDisconnect}
          onSftpEdit={handleSftpEdit}
          onSftpRemove={handleSftpRemove}
        />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab ? (
            <SplitView
              node={activeTab.root}
              panes={activeTab.panes}
              activePaneId={activeTab.activePane}
              showHidden={showHidden}
              showProperties={showProperties}
              canPaste={!!clipboard && !!activePane}
              renaming={renaming}
              dragOver={dragOver}
              fileTags={fileTags}
              customQuick={customQuick}
              onOpenTagFile={openTagFile}
              onExitTag={goBack}
              handlers={handlers}
            />
          ) : null}
        </div>

        {searchOpen && activePane && (
          <SearchPanel
            entries={activePane.entries}
            dir={activePane.path}
            cmd={searchCmd}
            onOpen={(e) => {
              if (e.is_dir) {
                navigate(e.path);
              } else {
                navigate(parentPath(e.path));
              }
            }}
            onOpenContent={(dir, filePath) => openSearchResult(dir, filePath)}
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
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        dark={dark}
        onToggleTheme={toggleTheme}
        onBindingsChanged={() => setKeymapVer((v) => v + 1)}
        plugins={plugins}
        onTogglePlugin={handleTogglePlugin}
      />

      <ConnectDialog
        open={connectOpen}
        initial={connectInitial}
        masterKey={masterKeyStatus}
        onNeedMasterKey={requestMasterKey}
        onClose={() => setConnectOpen(false)}
        onConnected={handleSftpConnected}
      />

      {/* 主密钥（master-key）：仅内存，用于加密保存的密码 */}
      <MasterKeyDialog
        open={masterKeyOpen}
        configured={masterKeyStatus.configured}
        onClose={() => {
          setMasterKeyOpen(false);
          pendingConnectRef.current = null;
          pendingSaveRef.current = null;
        }}
        onDone={(ok) => void handleMasterKeyDone(ok)}
      />

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
  );
}
