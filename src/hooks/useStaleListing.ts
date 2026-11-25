import { useRef } from "react";

/**
 * 列表陈旧判定（v0.52 快速连钻修复）：currentDir 已前进而 entries 尚未跟随
 * （导航发起 → 新目录列表到达之间）。渲染期同步比较，无竞速窗口——
 * 导航的第一帧即判定陈旧。期间列表禁点+降透明（Windows 语义：导航中
 * 旧视图不响应），防止快速连钻时双击命中上一级目录的残留行。
 */
export function useStaleListing(currentDir: string, entries: unknown): boolean {
  const prev = useRef({ dir: currentDir, entries });
  // entries 换新（新目录列表到达）→ 基线同步，陈旧解除
  if (prev.current.entries !== entries) {
    prev.current.entries = entries;
    prev.current.dir = currentDir;
  }
  return prev.current.dir !== currentDir;
}
