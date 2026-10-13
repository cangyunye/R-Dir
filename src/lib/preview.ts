/**
 * 预览类型门控（v0.28.0）：FileKind → 预览栏/图文浏览模式的呈现方式。
 *
 * - image：原图预览（preview_data 原字节，保 GIF 动画）
 * - text：文本渲染（read_text_file）
 * - doc：首页缩略图卡（thumb_get，PDF/Office 走 QuickLook）
 * - info：不预览内容，仅元信息 + 外部打开
 *
 * 远程路径（sftp/http/tags）一律 info（下载链路后续版本再接）。
 */
import type { FileEntry } from "@/lib/types";
import { fileKindOf } from "@/lib/filekind";

export type PreviewKind = "image" | "text" | "doc" | "info";

/** 原图字节上限：超过后回退缩略图放大（后端 preview_data 同步把关） */
export const PREVIEW_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
/** 文本预览字符上限：超过后提示过大，不渲染 */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export function isRemotePath(path: string): boolean {
  return (
    path.startsWith("sftp://") ||
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("tags://")
  );
}

/** 该条目在预览栏/浏览模式中的呈现方式 */
export function previewKindOf(entry: FileEntry): PreviewKind {
  if (entry.is_dir || isRemotePath(entry.path)) return "info";
  switch (fileKindOf(entry)) {
    case "image":
      return "image";
    case "text":
      return "text";
    case "pdf":
    case "doc":
    case "sheet":
    case "slide":
      return "doc";
    default:
      return "info";
  }
}

/** 是否可预览内容（图文浏览模式收录依据；info 类不参与） */
export function isPreviewable(entry: FileEntry): boolean {
  return previewKindOf(entry) !== "info";
}
