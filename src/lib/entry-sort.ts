/** 目录条目排序（v0.27 从 FileList 抽出供 IconGrid 共用；语义保持一致）。 */
import type { FileEntry, SortDir, SortKey } from "@/lib/types";
import { extLabel } from "@/lib/format";

/** 过滤隐藏文件 + 按键排序。名称/类型排序时目录恒在前（资源管理器惯例）；
 *  修改时间/大小按键值混排——目录的 mtime/size 与文件一视同仁，
 *  否则「按修改时间」最新变更永远被压在目录堆下。 */
export function sortEntries(
  entries: FileEntry[],
  sortKey: SortKey,
  sortDir: SortDir,
  showHidden: boolean,
): FileEntry[] {
  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
  const dir = sortDir === "asc" ? 1 : -1;
  const dirsFirst = sortKey === "name" || sortKey === "type";
  return [...visible].sort((a, b) => {
    if (dirsFirst && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    switch (sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        break;
      case "size":
        cmp = a.size - b.size;
        break;
      case "modified":
        cmp = (a.modified ?? 0) - (b.modified ?? 0);
        break;
      case "type":
        cmp = extLabel(a).localeCompare(extLabel(b));
        break;
    }
    return cmp * dir;
  });
}
