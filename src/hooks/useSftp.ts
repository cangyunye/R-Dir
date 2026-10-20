import { useCallback, useRef, useState } from "react";
import {
  sftpClearTemp,
  sftpConnect,
  sftpDisconnect,
  sftpExportServers,
  sftpImportServers,
  sftpListServers,
  sftpMasterKeyStatus,
  sftpRemoveServer,
  sftpSaveServer,
  sftpSetServerGroup,
  sftpTempInfo,
} from "@/lib/api";
import type {
  FileEntry,
  MasterKeyStatus,
  PaneState,
  SftpServerConfig,
  SftpServerView,
} from "@/lib/types";
import type { SftpConnectInitial } from "@/components/ConnectDialog";
import { parseSftpAuthority, sftpUrl } from "@/lib/sftp-path";
import { formatSize } from "@/lib/format";
import {
  confirm as confirmDialog,
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";

/** 会话恢复中挂起的 SFTP 连接（master-key 输入成功后重试） */
export interface PendingSftpRestore {
  paneId: number;
  serverId: string;
  path: string;
}

export interface UseSftpDeps {
  navigate: (path: string) => void;
  patchPane: (paneId: number, patch: Partial<PaneState>) => void;
  listDir: (path: string) => Promise<FileEntry[]>;
  showError: (msg: string) => void;
  /** 操作成功提示（导出/导入/清理临时文件的中央轻提示） */
  showInfo: (msg: string) => void;
}

/**
 * SFTP 远程服务器（v0.2 内置插件）的全部状态与流程。
 *
 * 从 App.tsx 抽出：服务器清单 / 连接框 / master-key 四个挂起槽位。
 * 四个 pending ref 是这块最容易出错的地方（主密钥验证后要按序重试
 * 保存 → 连接 → 会话恢复），集中在这里便于单独理解。
 */
export function useSftp({ navigate, patchPane, listDir, showError, showInfo }: UseSftpDeps) {
  const [servers, setServers] = useState<SftpServerView[]>([]);
  /** 已连接 id 集合（ref 同步，供 navigate 同步判断） */
  const connectedRef = useRef<Set<string>>(new Set());
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
  const pendingRestoreRef = useRef<PendingSftpRestore[]>([]);
  /** 主密钥设置后待保存的服务器（来自连接成功但保存失败） */
  const pendingSaveRef = useRef<SftpServerConfig | null>(null);
  /** 地址栏输入带 path 的 sftp URL 时，记住目标远程路径，连接成功后直达 */
  const pendingPathRef = useRef<string | null>(null);

  const syncConnected = useCallback((list: SftpServerView[]) => {
    connectedRef.current = new Set(list.filter((s) => s.connected).map((s) => s.id));
  }, []);

  /** 启动时拉取服务器清单 + master-key 状态 */
  const refresh = useCallback(() => {
    sftpListServers()
      .then((list) => {
        syncConnected(list);
        setServers(list);
      })
      .catch(() => {});
    sftpMasterKeyStatus().then(setMasterKeyStatus).catch(() => {});
  }, [syncConnected]);

  const openConnect = useCallback((initial?: SftpConnectInitial | null) => {
    setConnectInitial(initial ?? null);
    setConnectOpen(true);
  }, []);

  /** 记住/清除地址栏带过来的目标远程路径（连接成功后直达） */
  const rememberPendingPath = useCallback((path: string | null) => {
    pendingPathRef.current = path;
  }, []);

  /** 连接框关闭：同时丢弃地址栏带过来的目标路径 */
  const closeConnect = useCallback(() => {
    setConnectOpen(false);
    pendingPathRef.current = null;
  }, []);

  /** 连接成功：保存清单 + 刷新状态 + 导航到指定/默认远程目录 */
  const handleConnected = useCallback(
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
      syncConnected(list);
      setServers(list);
      const v = view ?? list.find((s) => s.id === config.id);
      // 地址栏带 path 的 URL → 直达该路径；否则落到服务器默认目录（root/home）
      const pendingPath = pendingPathRef.current;
      pendingPathRef.current = null;
      const remote = pendingPath ?? v?.defaultRemote ?? "/";
      navigate(sftpUrl(config.user, config.host, config.port, remote));
    },
    [navigate, showError, syncConnected],
  );

  /** 主密钥设置/验证成功后的统一处理：刷新状态 → 重试挂起的保存或连接 */
  const handleMasterKeyDone = useCallback(
    async (ok: boolean) => {
      setMasterKeyOpen(false);
      if (!ok) {
        // 用户取消：放弃所有挂起的连接/保存/会话恢复，保持布局不连接、不刷新
        pendingSaveRef.current = null;
        pendingConnectRef.current = null;
        pendingPathRef.current = null;
        const pending = pendingRestoreRef.current;
        pendingRestoreRef.current = [];
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
        await handleConnected(cfg);
        return;
      }
      // 2) 挂起的连接（连接框解密已保存密码需主密钥）
      if (pendingConnectRef.current) {
        const cfg = pendingConnectRef.current;
        pendingConnectRef.current = null;
        setConnectOpen(false);
        try {
          await sftpConnect(cfg);
          await handleConnected(cfg);
        } catch (e) {
          showError(`连接失败：${e}`);
        }
      }
      // 3) 挂起的会话恢复连接（主密钥验证后重试）
      const pending = pendingRestoreRef.current;
      if (pending.length > 0) {
        pendingRestoreRef.current = [];
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
            connectedRef.current.add(sp.serverId);
            const entries = await listDir(sp.path);
            patchPane(sp.paneId, { entries, loading: false, error: null });
          } catch (e) {
            patchPane(sp.paneId, { error: `会话未恢复：SFTP 需要验证（${e}）` });
          }
        }
      }
    },
    [handleConnected, showError, patchPane, listDir],
  );

  /** 主密钥框关闭：丢弃挂起的连接与保存（会话恢复槽位保留给下次验证） */
  const closeMasterKey = useCallback(() => {
    setMasterKeyOpen(false);
    pendingConnectRef.current = null;
    pendingSaveRef.current = null;
  }, []);

  /** 连接框需要主密钥：记录挂起连接并弹出主密钥框 */
  const requestMasterKey = useCallback((config: SftpServerConfig) => {
    pendingConnectRef.current = config;
    setMasterKeyOpen(true);
  }, []);

  /** 侧边栏点击服务器：已连接直达（默认目录）；已保存凭据 → 一键重连；否则弹连接框 */
  const openServer = useCallback(
    (sv: SftpServerView) => {
      if (connectedRef.current.has(sv.id)) {
        navigate(sftpUrl(sv.user, sv.host, sv.port, sv.defaultRemote || "/"));
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
            await handleConnected(cfg, view);
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
    [navigate, openConnect, showError, handleConnected],
  );

  /**
   * v0.31.1 确保 sftp:// 路径所属服务器已连接（标签视图重命名等**不经导航**的远程操作用）：
   * 已连接 → true；已保存凭据 → 静默重连（不切换目录）→ true；
   * 需要主密钥 → 弹主密钥框 → false；无保存凭据 / 未知服务器 → 弹预填连接框 → false。
   * 返回 false 时调用方应提示「连接后重试」。
   */
  const ensureConnected = useCallback(
    async (path: string): Promise<boolean> => {
      const auth = parseSftpAuthority(path);
      if (!auth) return false;
      if (connectedRef.current.has(auth.id)) return true;
      const sv = servers.find((s) => s.id === auth.id);
      if (!sv) {
        openConnect({ host: auth.host, port: auth.port, user: auth.user });
        return false;
      }
      if (!sv.hasSecret) {
        openConnect({ host: sv.host, port: sv.port, user: sv.user, name: sv.name });
        return false;
      }
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
      try {
        await sftpConnect(cfg);
        connectedRef.current.add(sv.id);
        const list = await sftpListServers().catch(() => []);
        if (list.length > 0) {
          syncConnected(list);
          setServers(list);
        }
        return true;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("NEED_MASTER_KEY")) {
          // 已保存密码是密文、本会话还没解锁：弹主密钥框；验证后用户重做一次操作即可
          setMasterKeyOpen(true);
          return false;
        }
        openConnect({ host: sv.host, port: sv.port, user: sv.user, name: sv.name });
        showError(`自动连接失败：${e}`);
        return false;
      }
    },
    [servers, openConnect, showError, syncConnected],
  );

  /** 侧边栏右键"编辑"：回填连接框（含 root/分组/认证方式） */
  const editServer = useCallback(
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
  const removeServer = useCallback(
    async (sv: SftpServerView) => {
      if (!(await confirmDialog(`删除服务器配置「${sv.name}」？连接不会断开。`))) return;
      try {
        const list = await sftpRemoveServer(sv.id);
        syncConnected(list);
        setServers(list);
      } catch (e) {
        showError(`删除服务器失败：${e}`);
      }
    },
    [showError, syncConnected],
  );

  const disconnect = useCallback(
    async (id: string) => {
      try {
        await sftpDisconnect(id);
        const list = await sftpListServers();
        syncConnected(list);
        setServers(list);
      } catch (e) {
        showError(`断开失败：${e}`);
      }
    },
    [showError, syncConnected],
  );

  // ==================== v0.31 服务器清单导出 / 导入 + 临时目录清理 ====================

  /** 导入文件含加密密码时的主密码框；待导入文件路径挂起在 ref（验证成功后重试） */
  const [importPwOpen, setImportPwOpen] = useState(false);
  const pendingImportFileRef = useRef<string | null>(null);
  /** v0.31.1 导出遇到明文密码且主密钥未解锁时的主密码框；待写入的目标路径挂起在 ref */
  const [exportPwOpen, setExportPwOpen] = useState(false);
  const pendingExportTargetRef = useRef<string | null>(null);

  /** 导出成功收尾：提示台数 + 是否含密文；输入过主密码则刷新主密钥状态（已激活到内存） */
  const finishExport = useCallback(
    (s: { exported: number; encrypted: boolean }) => {
      pendingExportTargetRef.current = null;
      setExportPwOpen(false);
      showInfo(
        `已导出 ${s.exported} 台服务器${s.encrypted ? "（含加密密码，导入时需输入主密码）" : ""}`,
      );
      sftpMasterKeyStatus().then(setMasterKeyStatus).catch(() => {});
    },
    [showInfo],
  );

  /** 执行导出（masterKey 缺省时后端遇明文密码且无内存主密钥会抛 NEED_MASTER_KEY → 弹主密码框） */
  const runExport = useCallback(
    async (target: string, masterKey?: string) => {
      try {
        const s = await sftpExportServers(target, new Date().toISOString(), masterKey);
        finishExport(s);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("NEED_MASTER_KEY")) {
          pendingExportTargetRef.current = target;
          setExportPwOpen(true);
          return;
        }
        showError(`导出失败：${msg}`);
      }
    },
    [finishExport, showError],
  );

  /** 导出服务器清单（save 对话框选位置；明文密码需主密码就地加密后再写出） */
  const exportServers = useCallback(async () => {
    const target = await saveFileDialog({
      title: "导出远程服务器列表",
      defaultPath: `rdir-servers-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!target) return;
    await runExport(target);
  }, [runExport]);

  /** 导出主密码框提交：带主密码重试挂起的导出；失败把错误抛回框内展示（如主密码不正确） */
  const submitExportPassword = useCallback(
    async (password: string) => {
      const target = pendingExportTargetRef.current;
      if (!target) {
        setExportPwOpen(false);
        return;
      }
      const s = await sftpExportServers(target, new Date().toISOString(), password);
      finishExport(s);
    },
    [finishExport],
  );

  const closeExportPassword = useCallback(() => {
    setExportPwOpen(false);
    pendingExportTargetRef.current = null;
  }, []);

  /** 导入成功收尾：刷新清单 + 提示（供首次导入与主密码框重试共用） */
  const finishImport = useCallback(
    async (s: { imported: number; skipped: number }) => {
      pendingImportFileRef.current = null;
      setImportPwOpen(false);
      const list = await sftpListServers().catch(() => []);
      syncConnected(list);
      setServers(list);
      showInfo(
        `已导入 ${s.imported} 台服务器${s.skipped > 0 ? `（跳过 ${s.skipped} 台已存在）` : ""}`,
      );
    },
    [showInfo, syncConnected],
  );

  /** 执行导入（masterKey 缺省时后端检测到密文会抛 NEED_MASTER_KEY → 弹主密码框） */
  const runImport = useCallback(
    async (file: string, masterKey?: string) => {
      try {
        const s = await sftpImportServers(file, masterKey);
        await finishImport(s);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("NEED_MASTER_KEY")) {
          // 导入文件含加密密码：挂起文件、弹主密码框（导出方的主密码，非本机的）
          pendingImportFileRef.current = file;
          setImportPwOpen(true);
          return;
        }
        showError(`导入失败：${msg}`);
      }
    },
    [finishImport, showError],
  );

  /** 导入服务器清单（open 对话框选文件；需主密码时经 PasswordDialog 追加输入） */
  const importServers = useCallback(async () => {
    const file = await openFileDialog({
      title: "导入远程服务器列表",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof file !== "string") return;
    await runImport(file);
  }, [runImport]);

  /** 主密码框提交：用导出方主密码重试挂起的导入；失败把错误抛回框内展示 */
  const submitImportPassword = useCallback(
    async (password: string) => {
      const file = pendingImportFileRef.current;
      if (!file) {
        setImportPwOpen(false);
        return;
      }
      const s = await sftpImportServers(file, password);
      await finishImport(s);
    },
    [finishImport],
  );

  const closeImportPassword = useCallback(() => {
    setImportPwOpen(false);
    pendingImportFileRef.current = null;
  }, []);

  /** 清空远程文件打开临时目录（确定性路径，提示释放量） */
  const clearOpenTemp = useCallback(async () => {
    try {
      const info = await sftpTempInfo();
      if (info.files === 0) {
        showInfo("远程临时目录已是空的");
        return;
      }
      const freed = await sftpClearTemp();
      showInfo(`已清理 ${info.files} 个远程临时文件（释放 ${formatSize(freed)}）`);
    } catch (e) {
      showError(`清理失败：${e}`);
    }
  }, [showInfo, showError]);

  // ==================== v0.31 仅保存配置 + 分组整理 ====================

  /** 连接框「保存」：只写清单不连接、不导航（后端对已有条目留空字段保留原值）。
   *  错误原样抛出，由调用方（连接框）在框内展示。 */
  const saveServerOnly = useCallback(
    async (config: SftpServerConfig) => {
      const list = await sftpSaveServer(config);
      syncConnected(list);
      setServers(list);
      showInfo(`已保存「${config.name || config.id}」`);
    },
    [syncConnected, showInfo],
  );

  /** 批量设置分组（侧边栏拖拽换组 / 分组右键整体重命名共用） */
  const setServerGroup = useCallback(
    async (ids: string[], group: string) => {
      try {
        const list = await sftpSetServerGroup(ids, group);
        syncConnected(list);
        setServers(list);
      } catch (e) {
        showError(`修改分组失败：${e}`);
      }
    },
    [syncConnected, showError],
  );

  return {
    servers,
    setServers,
    connectedRef,
    syncConnected,
    refresh,
    connectOpen,
    connectInitial,
    openConnect,
    closeConnect,
    rememberPendingPath,
    masterKeyStatus,
    setMasterKeyStatus,
    masterKeyOpen,
    setMasterKeyOpen,
    closeMasterKey,
    handleConnected,
    handleMasterKeyDone,
    requestMasterKey,
    openServer,
    editServer,
    removeServer,
    disconnect,
    pendingRestoreRef,
    // v0.31 导出/导入 + 临时目录清理
    importPwOpen,
    exportServers,
    importServers,
    submitImportPassword,
    closeImportPassword,
    // v0.31.1 导出遇明文密码时的主密码框
    exportPwOpen,
    submitExportPassword,
    closeExportPassword,
    clearOpenTemp,
    // v0.31 仅保存配置 + 分组整理
    saveServerOnly,
    setServerGroup,
    // v0.31.1 不经导航的远程操作前自动连接
    ensureConnected,
  };
}
