import { invoke } from "@tauri-apps/api/core";
import type {
  FileEntry,
  FindEntry,
  QuickAccessItem,
  SearchMatch,
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
