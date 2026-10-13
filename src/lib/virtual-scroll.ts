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

// ==================== 网格虚拟滚动（v0.27 大图标/画廊模式） ====================

/** 单元格内边距 + 单元格间隙（px） */
export const GRID_PAD = 12;
export const GRID_GAP = 8;
/** 图标下方两行文件名的预留高度（px） */
export const GRID_LABEL_H = 30;

/** 网格尺寸：单元宽/高由图标档位推出（调用方保证 iconSize 合法）。 */
export function gridCell(iconSize: number): { w: number; h: number } {
  const size = Math.max(32, Math.min(256, Math.round(iconSize)));
  return { w: size + GRID_PAD * 2, h: size + GRID_LABEL_H + GRID_PAD };
}

/** 可用宽度能放几列（至少 1 列）。 */
export function gridCols(viewportW: number, cellW: number): number {
  const usable = Math.max(0, viewportW - GRID_PAD * 2 + GRID_GAP);
  return Math.max(1, Math.floor(usable / (cellW + GRID_GAP)));
}

export interface GridRowRange {
  startRow: number;
  endRow: number;
  /** 内容总高度（px，撑开滚动区） */
  totalH: number;
}

/** 可视行范围（行高 = cellH + GRID_GAP），± buffer 行。 */
export function visibleGridRange(
  totalRows: number,
  cellH: number,
  scrollTop: number,
  viewportH: number,
  buffer = 4,
): GridRowRange {
  const rowH = cellH + GRID_GAP;
  const startRow = Math.max(0, Math.floor(scrollTop / rowH) - buffer);
  const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / rowH) + buffer);
  return { startRow, endRow, totalH: Math.max(0, totalRows) * rowH };
}
