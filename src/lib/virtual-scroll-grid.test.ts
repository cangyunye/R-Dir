import { describe, it, expect } from "vitest";
import {
  gridCell,
  gridCols,
  visibleGridRange,
  GRID_GAP,
  GRID_PAD,
  GRID_LABEL_H,
} from "./virtual-scroll";

describe("网格虚拟滚动（v0.27 大图标/画廊）", () => {
  it("gridCell：图标档位推出单元尺寸，越界钳制", () => {
    expect(gridCell(64)).toEqual({ w: 64 + GRID_PAD * 2, h: 64 + GRID_LABEL_H + GRID_PAD });
    expect(gridCell(0).w).toBe(32 + GRID_PAD * 2);
    expect(gridCell(9999).w).toBe(256 + GRID_PAD * 2);
  });

  it("gridCols：容器宽决定列数，至少 1 列", () => {
    const cellW = gridCell(64).w; // 92
    const unit = cellW + GRID_GAP; // 100
    expect(gridCols(1000, cellW)).toBe(Math.floor((1000 - 24 + 8) / unit));
    expect(gridCols(10, cellW)).toBe(1);
    expect(gridCols(0, cellW)).toBe(1);
  });

  it("visibleGridRange：首屏与滚动后范围，totalH 覆盖全部行", () => {
    const cellH = gridCell(64).h;
    const rowH = cellH + GRID_GAP;
    const r0 = visibleGridRange(100, cellH, 0, 400);
    expect(r0.startRow).toBe(0);
    expect(r0.endRow).toBeGreaterThan(4);
    expect(r0.totalH).toBe(100 * rowH);

    const r1 = visibleGridRange(100, cellH, rowH * 50, 400);
    expect(r1.startRow).toBeGreaterThanOrEqual(46); // 50 - buffer 4
    expect(r1.endRow).toBeLessThanOrEqual(100);

    const r2 = visibleGridRange(0, cellH, 0, 400);
    expect(r2.totalH).toBe(0);
    expect(r2.endRow).toBe(0);
  });
});
