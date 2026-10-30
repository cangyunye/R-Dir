import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSftp, type PendingSftpRestore } from "./useSftp";
import type { FileEntry, PaneState, SftpServerView } from "@/lib/types";

// api 模块整体桩掉：hook 只关心调用与返回，不触真实 Tauri invoke
vi.mock("@/lib/api", () => ({
  sftpListServers: vi.fn(async () => [] as SftpServerView[]),
  sftpMasterKeyStatus: vi.fn(async () => ({ configured: true, active: false })),
  sftpSaveServer: vi.fn(async () => [] as SftpServerView[]),
  sftpConnect: vi.fn(async () => undefined),
  sftpDisconnect: vi.fn(async () => undefined),
  sftpRemoveServer: vi.fn(async () => undefined),
  sftpSetServerGroup: vi.fn(async () => undefined),
  sftpExportServers: vi.fn(async () => "{}"),
  sftpImportServers: vi.fn(async () => "{}"),
  remoteTempClear: vi.fn(async () => undefined),
  remoteTempInfo: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(async () => true),
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

import { sftpConnect, sftpListServers, sftpMasterKeyStatus } from "@/lib/api";

const entries: FileEntry[] = [
  {
    name: "a.txt",
    path: "sftp://user@host:22/dir/a.txt",
    is_dir: false,
    is_symlink: false,
    size: 1,
    modified: 0,
    created: null,
    permissions: "rw-r--r--",
    extension: "txt",
  },
];

function setupDeps() {
  const navigate = vi.fn();
  const patchPane = vi.fn((paneId: number, patch: Partial<PaneState>) => ({ paneId, patch }));
  const listDir = vi.fn(async () => entries);
  const showError = vi.fn();
  const showInfo = vi.fn();
  return { navigate, patchPane, listDir, showError, showInfo };
}

describe("useSftp master-key 挂起会话恢复（v0.34.1 补充：此前 586 行零测试）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sftpListServers).mockResolvedValue([]);
    vi.mocked(sftpMasterKeyStatus).mockResolvedValue({ configured: true, active: false });
  });

  const pending: PendingSftpRestore = { paneId: 2, serverId: "srv-1", path: "sftp://user@host:22/dir" };

  it("验证成功：按序重连 → 读目录 → 窗格填充 entries，清空挂起队列", async () => {
    const deps = setupDeps();
    const { result } = renderHook(() => useSftp(deps));

    // App 在会话恢复失败时把挂起项推进 pendingRestoreRef（暴露的 ref）
    act(() => {
      result.current.pendingRestoreRef.current = [pending];
    });
    await act(async () => {
      await result.current.handleMasterKeyDone(true);
    });

    expect(sftpConnect).toHaveBeenCalledTimes(1);
    expect(deps.listDir).toHaveBeenCalledWith(pending.path);
    expect(deps.patchPane).toHaveBeenCalledWith(2, { entries, loading: false, error: null });
    expect(result.current.pendingRestoreRef.current).toEqual([]);
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("验证成功但重连失败：窗格标记错误而非崩溃，不填充条目", async () => {
    vi.mocked(sftpConnect).mockRejectedValueOnce("connection refused");
    const deps = setupDeps();
    const { result } = renderHook(() => useSftp(deps));

    act(() => {
      result.current.pendingRestoreRef.current = [pending];
    });
    await act(async () => {
      await result.current.handleMasterKeyDone(true);
    });

    expect(deps.listDir).not.toHaveBeenCalled();
    expect(deps.patchPane).toHaveBeenCalledWith(2, {
      error: "会话未恢复：SFTP 需要验证（connection refused）",
    });
    expect(result.current.pendingRestoreRef.current).toEqual([]);
  });

  it("用户取消主密钥：全部挂起项放弃，窗格显示未连接提示且不发起连接", async () => {
    const deps = setupDeps();
    const { result } = renderHook(() => useSftp(deps));

    act(() => {
      result.current.pendingRestoreRef.current = [pending, { ...pending, paneId: 3 }];
    });
    await act(async () => {
      await result.current.handleMasterKeyDone(false);
    });

    expect(sftpConnect).not.toHaveBeenCalled();
    expect(deps.patchPane).toHaveBeenCalledTimes(2);
    expect(deps.patchPane).toHaveBeenCalledWith(2, {
      loading: false,
      error: "SFTP 未连接（需要主密钥验证）",
    });
    expect(deps.patchPane).toHaveBeenCalledWith(3, {
      loading: false,
      error: "SFTP 未连接（需要主密钥验证）",
    });
    expect(result.current.pendingRestoreRef.current).toEqual([]);
  });

  it("主密钥成功后刷新状态：masterKeyStatus 更新为后端返回", async () => {
    vi.mocked(sftpMasterKeyStatus).mockResolvedValue({ configured: true, active: true });
    const deps = setupDeps();
    const { result } = renderHook(() => useSftp(deps));

    expect(result.current.masterKeyStatus.active).toBe(false);
    await act(async () => {
      await result.current.handleMasterKeyDone(true);
    });
    expect(result.current.masterKeyStatus.active).toBe(true);
  });
});
