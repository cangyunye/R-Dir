import { useCallback, useRef, useState } from "react";
import {
  sftpConnect,
  sftpDisconnect,
  sftpListServers,
  sftpMasterKeyStatus,
  sftpRemoveServer,
  sftpSaveServer,
} from "@/lib/api";
import type {
  FileEntry,
  MasterKeyStatus,
  PaneState,
  SftpServerConfig,
  SftpServerView,
} from "@/lib/types";
import type { SftpConnectInitial } from "@/components/ConnectDialog";
import { sftpUrl } from "@/lib/sftp-path";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";

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
}

/**
 * SFTP 远程服务器（v0.2 内置插件）的全部状态与流程。
 *
 * 从 App.tsx 抽出：服务器清单 / 连接框 / master-key 四个挂起槽位。
 * 四个 pending ref 是这块最容易出错的地方（主密钥验证后要按序重试
 * 保存 → 连接 → 会话恢复），集中在这里便于单独理解。
 */
export function useSftp({ navigate, patchPane, listDir, showError }: UseSftpDeps) {
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
  };
}
