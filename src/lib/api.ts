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
  TabFavorite,
  VolumeInfo,
} from "./types";

export const listDir = (path: string) =>
  invoke<FileEntry[]>("list_dir", { path });

export const completePath = (input: string, cwd: string) =>
  invoke<string[]>("complete_path", { input, cwd });

/** 解析地址栏输入为绝对路径：展开 "~"（主目录）与相对路径（v0.18） */
export const resolvePath = (input: string, cwd: string) =>
  invoke<string>("resolve_path", { input, cwd });

/** 地址栏命令补全：PATH 可执行前缀匹配（v0.22.0，插件停用时返回空） */
export const completeCommands = (prefix: string) =>
  invoke<import("./types").CommandSuggest[]>("complete_commands", { prefix });

/** 地址栏命令执行：在 cwd 新开终端窗口执行命令串（v0.22.0） */
export const runCommand = (input: string, cwd: string) =>
  invoke<void>("run_command", { input, cwd });

export const getVolumes = () => invoke<VolumeInfo[]>("get_volumes");

export const getQuickAccess = () =>
  invoke<QuickAccessItem[]>("get_quick_access");

export const getHomeDir = () => invoke<string>("get_home_dir");

export const parentDir = (path: string) => invoke<string>("parent_dir", { path });

/** 条目类型探测：返回 "dir" / "file" / "symlink" */
export const statPath = (path: string) => invoke<string>("stat_path", { path });

/** 批量条目类型探测：返回等长 kind 列表（"dir"/"file"/"symlink"/"missing"） */
export const statPaths = (paths: string[]) =>
  invoke<string[]>("stat_paths", { paths });

/** 复制条目到目标目录；返回实际创建路径列表（冲突自动改名，供撤销记录） */
export const copyEntries = (paths: string[], dest: string) =>
  invoke<string[]>("copy_entries", { paths, dest });

/** 移动条目到目标目录；返回 (源, 目标) 路径对（供撤销反向移动） */
export const moveEntries = (paths: string[], dest: string) =>
  invoke<[string, string][]>("move_entries", { paths, dest });

/** 扫描复制/移动前需用户裁决的同名冲突（同名目录可合并，不返回冲突） */
export const scanConflicts = (paths: string[], dest: string) =>
  invoke<import("./types").TransferConflict[]>("scan_conflicts", { paths, dest });

/** v0.28.0 目录复制语义：顶层同名目录重复检测 + `name (2)` 建议名 */
export interface DirDuplicate {
  src: string;
  suggest: string;
}
export const scanDirDuplicates = (paths: string[], dest: string) =>
  invoke<DirDuplicate[]>("scan_dir_duplicates", { paths, dest });

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

/** 系统剪贴板中的文件列表（跨应用粘贴）；cut=true 表示剪切/移动语义 */
export interface ClipboardFiles {
  paths: string[];
  cut: boolean;
}

/** 把文件列表写入系统剪贴板（跨应用复制/剪切，best-effort；cut=true 资源管理器按移动处理） */
export const clipboardWriteFiles = (paths: string[], cut = false) =>
  invoke<void>("clipboard_write_files", { paths, cut });

/** 从系统剪贴板读取文件列表（跨应用粘贴，无文件时 paths 为空） */
export const clipboardReadFiles = () =>
  invoke<ClipboardFiles>("clipboard_read_files");

/** 清空系统剪贴板：消费外部剪切（移动粘贴完成）后调用，避免残留失效的剪切项 */
export const clipboardClearFiles = () =>
  invoke<void>("clipboard_clear_files");

/**
 * 发起原生 OLE 拖拽（Windows：CF_HDROP 文件引用），阻塞到松手，
 * 返回最终投放效果（0 = 无目标/取消，1 = copy，2 = move，4 = shortcut）。
 * 空列表为 no-op（前端启动时的能力探测）。
 */
export const dragOutFiles = (paths: string[]) =>
  invoke<number>("drag_out_files", { paths });

/**
 * 修饰键实时状态（v0.34）：Windows 启用 Tauri 原生拖放后事件不带按键状态，
 * 应用内拖出「按住 Alt = 移动」在投放时查询。非 Windows 恒为未按下。
 */
export interface ModifierState {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
}

export const queryModifiers = () => invoke<ModifierState>("query_modifiers");

export const renameEntry = (path: string, newName: string) =>
  invoke<string>("rename_entry", { path, newName });

export const deleteEntries = (paths: string[]) =>
  invoke<void>("delete_entries", { paths });

/** 永久删除（绕过回收站，不可恢复） */
export const permanentDeleteEntries = (paths: string[]) =>
  invoke<void>("permanent_delete_entries", { paths });

/** 从回收站还原（撤销删除），返回还原的路径 */
export const restoreFromTrash = (paths: string[]) =>
  invoke<string[]>("restore_from_trash", { paths });

/** 取消进行中的本地复制/移动（id 来自 transfer-progress 事件载荷） */
export const cancelTransfer = (id: string) => invoke<void>("cancel_transfer", { id });

/** 全量替换目录内容监视集合（本地窗格当前目录；变化经 fs://changed 事件回推） */
export const fsWatchSet = (dirs: string[]) => invoke<void>("fs_watch_set", { dirs });

export const createDir = (parent: string, name: string) =>
  invoke<string>("create_dir", { parent, name });

export const createFile = (parent: string, name: string) =>
  invoke<string>("create_file", { parent, name });

/** 压缩选中条目到 target_dir（zip / tar / tgz，仅打包）；返回生成文件路径 */
export const compressItems = (paths: string[], targetDir: string, format: "zip" | "tar" | "tgz") =>
  invoke<string>("compress_items", { paths, targetDir, format });

/** 解压结果：落点 + 统计（v0.32） */
export interface ExtractOutcome {
  dest: string;
  files: number;
  skipped: number;
  bytes: number;
}

/**
 * 解压压缩包（v0.32）：zip / tar 系 / gz / bz2 内置解码，rar / 7z / tar.xz 走系统 tar。
 * mode：smart = 单顶层条目且不冲突 → targetDir 本身，否则 targetDir/<归档名>/；
 *       folder = 无条件 targetDir/<归档名>/。
 * 密码信号：「需要密码」（未提供）/「密码错误」（提供但不对），前端弹密码框重试。
 */
export const extractArchive = (path: string, targetDir: string, mode: "smart" | "folder", password?: string) =>
  invoke<ExtractOutcome>("extract_archive", { path, targetDir, mode, password: password ?? null });

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

/** 批量设置服务器分组（侧边栏拖拽换组 / 分组整体重命名共用）；返回最新清单 */
export const sftpSetServerGroup = (ids: string[], group: string) =>
  invoke<SftpServerView[]>("sftp_set_server_group", { ids, group });

export const sftpConnect = (server: SftpServerConfig) =>
  invoke<SftpServerView>("sftp_connect", { server });

export const sftpDisconnect = (id: string) =>
  invoke<void>("sftp_disconnect", { id });

/** 下载远程文件到临时目录，返回本地路径（供 opener 打开） */
export const sftpDownload = (path: string) =>
  invoke<string>("sftp_download", { path });

/** 下载远程文件到指定本地目录（粘贴/拖拽 远程→本地），返回本地路径；
 *  overwrite=true 直接覆盖同名（拖拽经覆盖确认后），false 同名自动加 " (n)" 后缀 */
export const sftpDownloadTo = (localDir: string, path: string, overwrite = false) =>
  invoke<string>("sftp_download_to", { localDir, path, overwrite });

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

// ---- v0.31 服务器清单导出/导入 + 远程打开临时目录 ----

/** 远程文件「打开」临时目录占用信息（确定性路径，可整体清理） */
export interface SftpTempInfo {
  path: string;
  files: number;
  bytes: number;
}

export const sftpTempInfo = () => invoke<SftpTempInfo>("sftp_temp_info");

/** 清空远程打开临时目录，返回释放的字节数 */
export const sftpClearTemp = () => invoke<number>("sftp_clear_temp");

/** 导出结果：exported 台数；encrypted = 文件含密文密码（导入时需输入这把主密码） */
export interface SftpExportSummary {
  exported: number;
  encrypted: boolean;
}

/** 导出服务器清单到目标文件。存在明文保存的密码且未解锁主密钥 → 抛 NEED_MASTER_KEY
 *  （前端弹主密码框后带 masterKey 重试；后端用它就地加密并落盘） */
export const sftpExportServers = (target: string, exportedAt: string, masterKey?: string) =>
  invoke<SftpExportSummary>("sftp_export_servers", {
    target,
    exportedAt,
    masterKey: masterKey ?? null,
  });

/** 导入结果：imported 新增台数；skipped 本机已有同 id 跳过台数 */
export interface SftpImportSummary {
  imported: number;
  skipped: number;
}

/** 导入服务器清单；文件含加密密码而未给主密码 → 抛 NEED_MASTER_KEY（弹框重试） */
export const sftpImportServers = (filePath: string, masterKey?: string) =>
  invoke<SftpImportSummary>("sftp_import_servers", {
    filePath,
    masterKey: masterKey ?? null,
  });

// ---- 会话保存 / 恢复（v0.3.0） ----
export const sessionSave = (layout: SessionLayout) =>
  invoke<void>("session_save", { layout });

export const sessionLoad = () =>
  invoke<SessionLayout | null>("session_load");

/** 清除已保存会话（v0.34「不保存并退出」用；文件不存在时静默成功） */
export const sessionClear = () =>
  invoke<void>("session_clear");

// ---- 标签收藏夹（favorites.json，独立于退出时的整体会话保存） ----
export const favoritesLoad = async (): Promise<TabFavorite[] | null> => {
  const file = await invoke<{ version: number; items: TabFavorite[] } | null>(
    "favorites_load",
  );
  return file ? file.items : null;
};

export const favoritesSave = (items: TabFavorite[]) =>
  invoke<void>("favorites_save", { items });

/** v0.23 退出确认后放行下一次应用退出（否则 Rust 侧 prevent_exit 会拦住 exit(0)） */
export const allowExit = () => invoke<void>("allow_exit");

// ---- 目录大小统计（v0.16 右键「属性」） ----
export const computeSize = (id: string, paths: string[]) =>
  invoke<import("./types").SizeStat>("compute_size", { id, paths });

export const cancelSize = (id: string) =>
  invoke<void>("cancel_size", { id });

// ---- 目录差异比对（v0.17 / v0.18 进度与取消） ----
export const diffDirs = (
  id: string,
  left: string,
  right: string,
  level: number,
  caseSensitive: boolean,
  mtimeToleranceMs: number,
) =>
  invoke<import("./types").DiffOutcome>("diff_dirs", {
    id,
    left,
    right,
    level,
    caseSensitive,
    mtimeToleranceMs,
  });

/** 取消进行中的差异比对 */
export const cancelDiff = (id: string) => invoke<void>("cancel_diff", { id });

// ---- v0.19 文本比较 ----

/** 任意两侧（本地/SFTP/HTTP）的行级文本比较；encoding 为 WhatWG 标签（gbk/big5/…，缺省 UTF-8），两侧同时应用 */
export const diffTextFiles = (left: string, right: string, encoding?: string) =>
  invoke<import("./types").TextDiffOutcome>("diff_text_files", {
    left,
    right,
    encoding: encoding && encoding !== "utf-8" ? encoding : null,
  });

/** 读取文本文件内容（.patch/.diff 解析用；支持 SFTP/HTTP 路径） */
export const readTextFile = (path: string) =>
  invoke<import("./types").TextFileContent>("read_text_file", { path });

/**
 * v0.34 保存文本比较一侧的编辑：整份行数组写回原文件。
 * 本地直写；SFTP 写临时文件后原名覆盖回传；HTTP 远端只读（后端拒绝）。
 * eol 为该侧原行尾格式（lf/crlf/mixed/none）；encoding 为当前比较编码（WhatWG 标签）。
 */
export const writeTextSide = (path: string, lines: string[], eol: string, encoding?: string) =>
  invoke<void>("write_text_file", {
    path,
    lines,
    eol,
    encoding: encoding && encoding !== "utf-8" ? encoding : null,
  });

/** 读取单个路径的元信息（「属性」统计当前目录用） */
export const statEntry = (path: string) =>
  invoke<FileEntry>("stat_entry", { path });

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

// ---- v0.27 图标自由摆放位置（应用数据目录集中存储，按目录路径索引） ----

/** 槽位坐标（列, 行），分辨率无关；目录 → 条目名 → 槽位 */
export type IconPositionMap = Record<string, Record<string, [number, number]>>;

export const iconPositionsLoad = () =>
  invoke<IconPositionMap>("icon_positions_load");

export const iconPositionsSave = (positions: IconPositionMap) =>
  invoke<void>("icon_positions_save", { positions });

// ---- v0.27 缩略图（画廊模式；本地图片文件，PNG base64 data URL 返回） ----

export const thumbGet = (path: string, size: number) =>
  invoke<string | null>("thumb_get", { path, size });

// ---- v0.28 预览原图（预览栏；原字节 data URL，GIF 保动画；不支持/过大返回 null） ----

export const previewData = (path: string) =>
  invoke<string | null>("preview_data", { path });
