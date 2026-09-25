import type { OpenerItem } from "@/lib/openerApi";

/** 通配扩展名：关联所有类型 */
export const ALL_EXTS = "*";

/** 归一化单个扩展名：去空白、去前导点、小写 */
export function normalizeExt(ext: string): string {
  return ext.trim().replace(/^\.+/, "").toLowerCase();
}

/** 归一化扩展名列表：去重保序、丢弃空值 */
export function normalizeExts(exts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of exts) {
    const n = normalizeExt(e);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * 某文件可用的打开方式：扩展名命中，或该应用关联了通配 `*`。
 * 空 extensions = 不关联任何类型（不在右键出现）。
 * 无扩展名文件（如 Makefile）只有 `*` 能匹配。
 */
export function openersForEntry(openers: OpenerItem[], ext: string): OpenerItem[] {
  const e = normalizeExt(ext);
  return openers.filter(
    (o) =>
      o.kind === "custom" &&
      (o.extensions.includes(ALL_EXTS) || (e !== "" && o.extensions.includes(e))),
  );
}
