/**
 * 远程条目的递归统计（删除确认框 / 属性弹窗共用）。
 *
 * 后端 `compute_size`（sizestat）只认本地文件系统——sftp://、http:// 等
 * 虚拟路径递归失败，弹窗统计框此前一律停在 0 个文件 / 0 个文件夹 / 0 字节。
 * 这里在前端按 `listDir` 的统一后端路由做 BFS 遍历：SFTP / HTTP 目录逐层列取，
 * 已知文件大小直接计入；单个目录列取失败（权限 / 断连）跳过不中断。
 * 已访问集合防符号链接成环。进度按目录粒度回调，供弹窗增量刷新。
 */
import { listDir } from "./api";
import type { FileEntry } from "./types";
import { isHttpPath, isSftpPath } from "./sftp-path";

export interface RemoteSizeStat {
  bytes: number;
  files: number;
  dirs: number;
}

export const isLocalEntryPath = (p: string): boolean => !isSftpPath(p) && !isHttpPath(p);

/** 全部条目都是本地路径 → 仍走后端原生统计（快）；否则用本模块的远程遍历 */
export const needsRemoteStat = (entries: readonly { path: string }[]): boolean =>
  entries.some((e) => !isLocalEntryPath(e.path));

/**
 * 递归统计条目集合。onProgress 每统计完一个目录回调一次（含种子文件的已知大小）；
 * cancelled() 返回 true 时提前停止（弹窗已关闭）。返回最终统计。
 */
export async function statEntriesWalk(
  entries: readonly FileEntry[],
  onProgress: (s: RemoteSizeStat) => void,
  cancelled: () => boolean,
): Promise<RemoteSizeStat> {
  const seedFiles = entries.filter((e) => !e.is_dir);
  let bytes = seedFiles.reduce((s, e) => s + e.size, 0);
  let files = seedFiles.length;
  let dirs = 0;
  onProgress({ bytes, files, dirs });
  const seen = new Set(entries.filter((e) => e.is_dir).map((e) => e.path));
  const queue = [...seen];
  while (queue.length > 0 && !cancelled()) {
    const dir = queue.shift()!;
    dirs++;
    let kids: FileEntry[] = [];
    try {
      kids = await listDir(dir);
    } catch {
      // 目录不可读（权限 / 已断连 / 已被删）：跳过，统计其余部分
    }
    for (const k of kids) {
      if (k.is_dir) {
        if (!seen.has(k.path)) {
          seen.add(k.path);
          queue.push(k.path);
        }
      } else {
        files++;
        bytes += k.size;
      }
    }
    onProgress({ bytes, files, dirs });
    // 每个目录之间让出事件循环，大目录树不阻塞弹窗交互
    await new Promise<void>((r) => window.setTimeout(r, 0));
  }
  return { bytes, files, dirs };
}
