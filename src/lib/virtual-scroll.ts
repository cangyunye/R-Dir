/** 虚拟滚动可视行范围计算。抽成纯函数以便单测。
 * 回归点：viewportH 必须有合理初始值（不能是 0），否则不滚动时只渲染前几行。 */

export const ROW_HEIGHT = 26;
export const BUFFER = 6;
export const DEFAULT_VIEWPORT_H = 400;

export interface VirtualRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

export function visibleRange(
  total: number,
  scrollTop: number,
  viewportH: number,
): VirtualRange {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
  const end = Math.min(
    total,
    Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + BUFFER,
  );
  return {
    start,
    end,
    padTop: start * ROW_HEIGHT,
    padBottom: Math.max(0, total - end) * ROW_HEIGHT,
  };
}
