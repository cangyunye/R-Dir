import { invoke } from "@tauri-apps/api/core";
import type {
  FileEntry,
  FindEntry,
  MasterKeyStatus,
  QuickAccessItem,
  SearchMatch,
  SessionLayout,
  SftpServerConfig,
  SftpServerView,
  VolumeInfo,
} from "./types";

export const listDir = (path: string) =>
  invoke<FileEntry[]>("list_dir", { path });

export const completePath = (input: string, cwd: string) =>
  invoke<string[]>("complete_path", { input, cwd });

export const getVolumes = () => invoke<VolumeInfo[]>("get_volumes");

export const getQuickAccess = () =>
  invoke<QuickAccessItem[]>("get_quick_access");

export const getHomeDir = () => invoke<string>("get_home_dir");

export const parentDir = (path: string) => invoke<string>("parent_dir", { path });

/** 条目类型探测：返回 "dir" / "file" / "symlink" */
export const statPath = (path: string) => invoke<string>("stat_path", { path });

/** 复制条目到目标目录；返回实际创建路径列表（冲突自动改名，供撤销记录） */
export const copyEntries = (paths: string[], dest: string) =>
  invoke<string[]>("copy_entries", { paths, dest });

/** 移动条目到目标目录；返回 (源, 目标) 路径对（供撤销反向移动） */
export const moveEntries = (paths: string[], dest: string) =>
  invoke<[string, string][]>("move_entries", { paths, dest });

/** 扫描复制/移动前需用户裁决的同名冲突（同名目录可合并，不返回冲突） */
export const scanConflicts = (paths: string[], dest: string) =>
  invoke<import("./types").TransferConflict[]>("scan_conflicts", { paths, dest });

/** 按冲突裁决表复制，返回实际创建路径（供撤销记录） */
export const copyEntriesPlan = (
  paths: string[],
  dest: string,
  resolutions: import("./types").ResolutionPlan,
) => invoke<string[]>("copy_entries_plan", { paths, dest, resolutions });

/** 按冲突裁决表移动，返回 (源, 目标) 路径对（供撤销反向移动） */
export const moveEntriesPlan = (
  paths: string[],
  dest: string,
  resolutions: import("./types").ResolutionPlan,
) => invoke<[string, string][]>("move_entries_plan", { paths, dest, resolutions });

/** 把文件列表写入系统剪贴板（跨应用复制，best-effort） */
export const clipboardWriteFiles = (paths: string[]) =>
  invoke<void>("clipboard_write_files", { paths });

/** 从系统剪贴板读取文件列表（跨应用粘贴，无文件时返回空数组） */
export const clipboardReadFiles = () =>
  invoke<string[]>("clipboard_read_files");

export const renameEntry = (path: string, newName: string) =>
  invoke<string>("rename_entry", { path, newName });

export const deleteEntries = (paths: string[]) =>
  invoke<void>("delete_entries", { paths });

/** 永久删除（绕过回收站，不可恢复） */
export const permanentDeleteEntries = (paths: string[]) =>
  invoke<void>("permanent_delete_entries", { paths });

export const createDir = (parent: string, name: string) =>
  invoke<string>("create_dir", { parent, name });

export const createFile = (parent: string, name: string) =>
  invoke<string>("create_file", { parent, name });

/** 压缩选中条目到 target_dir（zip / tar / tgz，仅打包）；返回生成文件路径 */
export const compressItems = (paths: string[], targetDir: string, format: "zip" | "tar" | "tgz") =>
  invoke<string>("compress_items", { paths, targetDir, format });

/** 内容搜索（字面量关键词，可递归/大小写开关） */
export const searchContent = (
  query: string,
  dir: string,
  recursive: boolean,
  caseSensitive: boolean,
) =>
  invoke<SearchMatch[]>("search_content", { query, dir, recursive, caseSensitive });

/** fd 快速文件检索（正则 + smart case + 递归） */
export const findFiles = (
  pattern: string,
  dir: string,
  showHidden: boolean,
  maxDepth: number | null,
) =>
  invoke<FindEntry[]>("find_files", { pattern, dir, showHidden, maxDepth });

// ==================== SFTP 远程服务器 ====================

export const sftpListServers = () =>
  invoke<SftpServerView[]>("sftp_list_servers");

export const sftpMasterKeyStatus = () =>
  invoke<MasterKeyStatus>("sftp_master_key_status");

export const sftpSetMasterKey = (key: string) =>
  invoke<void>("sftp_set_master_key", { key });

export const sftpResetMasterKey = () =>
  invoke<void>("sftp_reset_master_key");

export const sftpSaveServer = (server: SftpServerConfig) =>
  invoke<SftpServerView[]>("sftp_save_server", { server });

export const sftpRemoveServer = (id: string) =>
  invoke<SftpServerView[]>("sftp_remove_server", { id });

export const sftpConnect = (server: SftpServerConfig) =>
  invoke<SftpServerView>("sftp_connect", { server });

export const sftpDisconnect = (id: string) =>
  invoke<void>("sftp_disconnect", { id });

/** 下载远程文件到临时目录，返回本地路径（供 opener 打开） */
export const sftpDownload = (path: string) =>
  invoke<string>("sftp_download", { path });

/** 下载远程文件到指定本地目录（粘贴/拖拽 远程→本地），返回本地路径 */
export const sftpDownloadTo = (localDir: string, path: string) =>
  invoke<string>("sftp_download_to", { localDir, path });

/** 上传本地文件到远程目录（拖拽/复制） */
export const sftpUpload = (local: string, dest: string, name: string) =>
  invoke<string>("sftp_upload", { local, dest, name });

export const sftpMkdir = (dir: string, name: string) =>
  invoke<string>("sftp_mkdir", { dir, name });

export const sftpCreateFile = (dir: string, name: string) =>
  invoke<string>("sftp_create_file", { dir, name });

export const sftpDelete = (paths: string[]) =>
  invoke<void>("sftp_delete", { paths });

export const sftpRename = (path: string, newName: string) =>
  invoke<string>("sftp_rename", { path, newName });

// ---- 会话保存 / 恢复（v0.3.0） ----
export const sessionSave = (layout: SessionLayout) =>
  invoke<void>("session_save", { layout });

export const sessionLoad = () =>
  invoke<SessionLayout | null>("session_load");

export const sessionClear = () =>
  invoke<void>("session_clear");

// ---- 窗口分享（v0.7） ----
export const shareCreate = (
  dir: string,
  allowParent: boolean,
  maxConns: number,
  expiresHours: number | null
) =>
  invoke<import("./types").ShareCreateResult>("share_create", {
    dir,
    allowParent,
    maxConns,
    expiresHours,
  });

export const shareList = () =>
  invoke<import("./types").ShareSessionView[]>("share_list");

export const shareStop = (id: string) =>
  invoke<void>("share_stop", { id });

export const shareStopByDir = (dir: string) =>
  invoke<number>("share_stop_by_dir", { dir });
