/**
 * v0.42 未知类型内容探测缓存层：probe_local_file 的会话级缓存 + 同步查询。
 *
 * - TextProbe（预览栏/浏览模式中央内容）与 useSniffPreviewList（浏览模式懒收录）
 *   共用同一份结果：同一文件只探测一次。
 * - key = path|mtime|size：文件变化自然失效（下载中的半截文件改完即重探）。
 * - peekProbe/isSniffedImage 供渲染路径同步判定（tile 出缩略图还是图标）。
 */
import { probeLocalFile } from "@/lib/api";
import type { FileEntry, ProbeResult } from "@/lib/types";

const cache = new Map<string, ProbeResult>();

const keyOf = (e: Pick<FileEntry, "path" | "modified" | "size">) =>
  `${e.path}|${e.modified}|${e.size}`;

/** 探测（带缓存；同 path|mtime|size 只发一次 IPC） */
export function probeFile(entry: FileEntry): Promise<ProbeResult> {
  const key = keyOf(entry);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  return probeLocalFile(entry.path).then((r) => {
    cache.set(key, r);
    return r;
  });
}

/** 同步查询缓存（未探测过返回 undefined，不发 IPC） */
export function peekProbe(entry: FileEntry): ProbeResult | undefined {
  return cache.get(keyOf(entry));
}

/** 该未知类型条目是否已被嗅探为图片（tile/浏览收录判定用） */
export function isSniffedImage(entry: FileEntry): boolean {
  return peekProbe(entry)?.kind === "image";
}
