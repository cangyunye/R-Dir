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

/** 列出可用终端 */
export const listShells = () => invoke<ShellItem[]>("list_shells");

export interface FileTypes {
  groups: Record<string, string[]>;
  defaultApps: Record<string, string>;
}

/** 读取文件类型目录（无配置时首次生成 + 系统默认应用探测） */
export const getFileTypes = () => invoke<FileTypes>("get_filetypes");

/** 刷新文件关联：重新探测系统默认打开应用并持久化 */
export const refreshFileTypes = () => invoke<FileTypes>("refresh_filetypes");

/** 在指定目录打开终端 */
export const openTerminal = (shellId: string, path: string) =>
  invoke<void>("open_terminal", { shellId, path });

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
}

/** 插件清单（内置插件注册表 + 启用状态） */
export const listPlugins = () => invoke<PluginInfo[]>("list_plugins");

/** 启用 / 禁用插件并持久化；返回最新清单 */
export const setPluginEnabled = (id: string, enabled: boolean) =>
  invoke<PluginInfo[]>("set_plugin_enabled", { id, enabled });
