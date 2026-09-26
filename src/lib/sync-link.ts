/**
 * 同步浏览链接（方案 A1：锚点相对路径镜像）纯函数。
 * 相对路径一律规范化为 "/" 分隔（跨协议可比），join 时转换回各自协议的分隔符。
 */
import type { DiffEntry, DiffStatus } from "./types";
import { pathScheme } from "./backends";

export interface SyncLink {
  /** 链接所属标签页（断链清理与面板定位用） */
  tabId: number;
  leftPaneId: number;
  rightPaneId: number;
  /** 锚点：开启链接时两侧窗格的当前路径 */
  leftRoot: string;
  rightRoot: string;
}

export type LinkSide = "left" | "right";

/** p 相对 side 锚点的相对路径（"/" 分隔）；不在锚点子树内时 null */
export function relOf(link: SyncLink, side: LinkSide, path: string): string | null {
  const root = side === "left" ? link.leftRoot : link.rightRoot;
  const rel = pathScheme(root).under(path, root);
  return rel === null ? null : rel.replace(/\\/g, "/");
}

/** 把 "/" 规范化的 rel 拼回 side 的锚点（转换回该协议的分隔符） */
export function mirrorPath(link: SyncLink, side: LinkSide, rel: string): string {
  const root = side === "left" ? link.leftRoot : link.rightRoot;
  const scheme = pathScheme(root);
  const nativeRel = scheme.separator === "\\" ? rel.replace(/\//g, "\\") : rel;
  return scheme.join(root, nativeRel);
}

export type LinkAlignment =
  | { state: "aligned"; rel: string; leftDir: string; rightDir: string }
  | {
      state: "diverged";
      /** 最近共同层（相对锚点，"/" 分隔；根为 ""） */
      layer: string;
      /** wanderer 比共同层更深的部分 */
      missing?: string;
      /** wanderer 在哪一侧 */
      missingSide?: LinkSide;
      /** 一侧离开了自己锚点的子树 */
      outsideRoot?: boolean;
      /** 面板回退共同层后的比对目录 */
      leftDir: string;
      rightDir: string;
    };

/** 逐段求最长公共目录前缀（rels 已 "/" 规范化） */
function commonLayer(
  relA: string,
  relB: string,
): { layer: string; missing?: string; deeper?: LinkSide } {
  if (relA === relB) return { layer: relA };
  const a = relA ? relA.split("/") : [];
  const b = relB ? relB.split("/") : [];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const layer = a.slice(0, i).join("/");
  if (i < a.length) return { layer, missing: a.slice(i).join("/"), deeper: "left" };
  if (i < b.length) return { layer, missing: b.slice(i).join("/"), deeper: "right" };
  return { layer };
}

/** 由两侧窗格当前路径推导对齐状态与面板比对目录 */
export function computeAlignment(
  link: SyncLink,
  leftPath: string,
  rightPath: string,
): LinkAlignment {
  const relL = relOf(link, "left", leftPath);
  const relR = relOf(link, "right", rightPath);
  if (relL === null || relR === null) {
    // 一侧离开锚点子树：回退到两侧根（共同层 ""），missingSide 指向越界一侧
    return {
      state: "diverged",
      layer: "",
      outsideRoot: true,
      missingSide: relL === null ? "left" : "right",
      leftDir: link.leftRoot,
      rightDir: link.rightRoot,
    };
  }
  if (relL === relR) {
    return { state: "aligned", rel: relL, leftDir: leftPath, rightDir: rightPath };
  }
  const c = commonLayer(relL, relR);
  return {
    state: "diverged",
    layer: c.layer,
    ...(c.missing !== undefined ? { missing: c.missing, missingSide: c.deeper } : {}),
    leftDir: mirrorPath(link, "left", c.layer),
    rightDir: mirrorPath(link, "right", c.layer),
  };
}

/** 行内标注单条 */
export interface DiffMark {
  status: Exclude<DiffStatus, "same">;
  reason?: string;
  leftSize: number | null;
  rightSize: number | null;
}

/** 行内标注表：条目名 → 判定。same 不产条目（无色条）；左右两窗格共用同一张表。 */
export type DiffMarkMap = Record<string, DiffMark>;

export function marksFromOutcome(entries: DiffEntry[]): DiffMarkMap {
  const out: DiffMarkMap = {};
  for (const e of entries) {
    if (e.status === "same") continue;
    out[e.name] = {
      status: e.status,
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      leftSize: e.left ? e.left.size : null,
      rightSize: e.right ? e.right.size : null,
    };
  }
  return out;
}
