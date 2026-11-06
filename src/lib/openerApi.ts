import { invoke } from "@tauri-apps/api/core";

export interface OpenerItem {
  id: string;
  name: string;
  kind: string;
  detected: boolean;
  exec: string | null;
  cli: boolean;
  extensions: string[];
}

export interface ShellItem {
  id: string;
  name: string;
  detected: boolean;
}

/** 列出打开方式（内置 + Agent + 自定义，带探测结果） */
export const listOpeners = () => invoke<OpenerItem[]>("list_openers");

/** 用指定工具打开路径 */
export const openWith = (toolId: string, path: string) =>
  invoke<void>("open_with", { toolId, path });

/** 添加自定义打开方式 */
export const addCustomOpener = (name: string, exec: string, extensions: string[]) =>
  invoke<OpenerItem>("add_custom_opener", { name, exec, extensions });

/** 删除自定义打开方式 */
export const removeCustomOpener = (id: string) =>
  invoke<void>("remove_custom_opener", { id });

/** 覆盖设置某打开方式的关联扩展名 */
export const setOpenerExtensions = (id: string, extensions: string[]) =>
  invoke<void>("set_opener_extensions", { id, extensions });

/** 列出可用终端 */
export const listShells = () => invoke<ShellItem[]>("list_shells");

/** 在指定目录打开终端 */
export const openTerminal = (shellId: string, path: string) =>
  invoke<void>("open_terminal", { shellId, path });

// ==================== 双击/回车打开本地文件 ====================

/** 用系统默认方式打开本地文件；exe/bat/cmd 以其父目录为工作目录启动（资源管理器
 *  双击语义——ShellExecute lpDirectory=NULL 会把 R-Dir 自身进程 cwd 传给子程序，
 *  依赖 cwd 的程序如 Go 的 filepath.Abs(".") 会拿到错目录） */
export const openLocalFile = (path: string) => invoke<void>("open_local_file", { path });

// ==================== v0.29.0 右键 VSCode / Git 打开 ====================

/** 「Git 打开」工具条目（未安装的 detected=false，前端折叠组内置灰展示） */
export interface GitToolItem {
  id: string;
  name: string;
  detected: boolean;
}

/** 是否探测到 VSCode */
export const vscodeDetected = () => invoke<boolean>("vscode_detected");

/** 用 VSCode 打开路径（文件/目录均可） */
export const openVscode = (path: string) => invoke<void>("open_vscode", { path });

/** 「Git 打开」工具清单（含未安装项） */
export const listGitTools = () => invoke<GitToolItem[]>("list_git_tools");

/** 在指定目录打开 Git 工具 */
export const openGitTool = (toolId: string, path: string) =>
  invoke<void>("open_git_tool", { toolId, path });

// ==================== v0.29.0 常用工具条 ====================

/** 常用工具条条目（右键菜单顶部横排；未安装 detected=false 前端置灰） */
export interface QuickToolItem {
  id: string;
  name: string;
  exec: string;
  /** v0.31.1 启动参数串（支持 {path} / {dir} / $pwd / {name} 占位符；空 = 默认行为） */
  args: string;
  detected: boolean;
}

/** 本机检测到的编辑器（设置页「检测到已安装」建议芯片） */
export interface EditorCandidate {
  id: string;
  name: string;
  exec: string;
}

export const listQuickTools = () => invoke<QuickToolItem[]>("list_quick_tools");

/** 添加常用工具（id 缺省生成；建议芯片传稳定 slug）；返回最新清单 */
export const addQuickTool = (id: string | null, name: string, exec: string) =>
  invoke<QuickToolItem[]>("add_quick_tool", { id, name, exec });

export const removeQuickTool = (id: string) =>
  invoke<QuickToolItem[]>("remove_quick_tool", { id });

export const moveQuickTool = (id: string, up: boolean) =>
  invoke<QuickToolItem[]>("move_quick_tool", { id, up });

/** 设置常用工具的启动参数串（v0.31.1）；返回最新清单 */
export const setQuickToolArgs = (id: string, args: string) =>
  invoke<QuickToolItem[]>("set_quick_tool_args", { id, args });

/** 用常用工具打开路径（目录=工作区，文件=打开文件） */
export const openQuickTool = (id: string, path: string) =>
  invoke<void>("open_quick_tool", { id, path });

/** 检测本机已安装的常见编辑器 */
export const detectEditors = () => invoke<EditorCandidate[]>("detect_editors");

// ==================== v0.5 插件注册表 ====================

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  protocols: string[];
  operations: string[];
  enabled: boolean;
  configurable: boolean;
  /** v0.40 外置插件安装态（builtin 恒为 true；false 时面板给安装入口） */
  installed: boolean;
}

/** 插件清单（内置插件注册表 + 启用状态） */
export const listPlugins = () => invoke<PluginInfo[]>("list_plugins");

/** 启用 / 禁用插件并持久化；返回最新清单 */
export const setPluginEnabled = (id: string, enabled: boolean) =>
  invoke<PluginInfo[]>("set_plugin_enabled", { id, enabled });

/** v0.40 NFS 伴生进程插件状态（安装态 / 版本 / 协议匹配） */
export interface NfsPluginStatus {
  source: "builtin" | "external";
  installed: boolean;
  version: string | null;
  protocolMatch: boolean;
  enabled: boolean;
  error: string | null;
}

/** 本地导入 .rdplugin（zip 容器，含 manifest + 二进制，sha256 / 协议版本 / 平台三重校验） */
export const nfsPluginImport = (file: string) =>
  invoke<NfsPluginStatus>("nfs_plugin_import", { file });

/** 在线获取（官方 GitHub Release 通道，整包 + 包内双校验） */
export const nfsPluginInstallOnline = () =>
  invoke<NfsPluginStatus>("nfs_plugin_install_online");

/** 卸载（删除插件目录与安装信息） */
export const nfsPluginUninstall = () =>
  invoke<NfsPluginStatus>("nfs_plugin_uninstall");

/** HTTP autoindex：下载文件到本地目录（流式 + 进度条），返回实际路径 */
export const cancelHttpDownload = (url: string) =>
  invoke("cancel_http_download", { url });

export const httpDownloadTo = (localDir: string, url: string) =>
  invoke<string>("http_download_to", { localDir, url });
