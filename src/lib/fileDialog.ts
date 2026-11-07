/**
 * 文件对话框适配：桌面走 plugin-dialog 原生对话框；浏览器（web 模式）退化为
 * 输入框——让用户手填**服务端机器上**的路径（主题包安装/导出、SFTP 密钥与
 * 服务器清单导入导出、解压目标目录等流程在 web 模式由此保持可用）。
 *
 * 原生对话框选项在浏览器分支被忽略（过滤扩展名等无从谈起）；confirm 同理
 * 退化为 window.confirm。桌面分支与直接调 plugin-dialog 行为逐字节一致。
 */

import { isTauri } from "./ipc";
import {
  confirm as tauriConfirm,
  open as tauriOpen,
  save as tauriSave,
} from "@tauri-apps/plugin-dialog";

/** plugin-dialog open/save 选项的兼容子集（桌面原样透传；浏览器忽略高级项） */
export interface FileDialogOptions {
  title?: string;
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

const WEB_HINT = "（web 模式：请输入服务端机器上的路径）";

/** 选择已有文件/目录；浏览器 → 输入框（multiple 时返回单元素数组） */
export async function dialogOpen(
  opts: FileDialogOptions = {},
): Promise<string | string[] | null> {
  if (isTauri()) {
    return tauriOpen(opts as Parameters<typeof tauriOpen>[0]);
  }
  const v = window.prompt(`${opts.title ?? "选择路径"}${WEB_HINT}`, opts.defaultPath ?? "");
  const t = v?.trim();
  if (!t) return null;
  return opts.multiple ? [t] : t;
}

/** 选择保存位置；浏览器 → 输入框（默认值为 defaultPath） */
export async function dialogSave(opts: FileDialogOptions = {}): Promise<string | null> {
  if (isTauri()) {
    return tauriSave(opts as Parameters<typeof tauriSave>[0]);
  }
  const v = window.prompt(`${opts.title ?? "保存到"}${WEB_HINT}`, opts.defaultPath ?? "");
  const t = v?.trim();
  return t ? t : null;
}

/** 原生确认框；浏览器 → window.confirm */
export async function dialogConfirm(message: string): Promise<boolean> {
  if (isTauri()) {
    return tauriConfirm(message);
  }
  return window.confirm(message);
}
