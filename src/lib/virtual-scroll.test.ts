import { describe, it, expect } from "vitest";
import { visibleRange, ROW_HEIGHT, BUFFER, DEFAULT_VIEWPORT_H } from "./virtual-scroll";

describe("虚拟滚动可视范围（回归：SFTP 目录显示不全）", () => {
  it("viewportH=0 时只渲染前几行——这就是旧 bug", () => {
    // 旧代码 viewportH 初始 0，不滚动时 end = ceil(0/26)+6 = 6
    const r = visibleRange(100, 0, 0);
    expect(r.end).toBe(BUFFER); // 6 行，94 行被裁掉
  });

  it("使用默认 viewportH=400 时，首屏应渲染约 21 行", () => {
    const r = visibleRange(100, 0, DEFAULT_VIEWPORT_H);
    // ceil(400/26)+6 ≈ 16+6 = 22
    expect(r.end).toBeGreaterThanOrEqual(20);
    expect(r.end).toBeLessThanOrEqual(26);
  });

  it("100 行目录首屏不能只显示前 6 行", () => {
    const r = visibleRange(100, 0, DEFAULT_VIEWPORT_H);
    expect(r.end).toBeGreaterThan(10);
  });

  it("滚动到底部时 end 等于 total", () => {
    const r = visibleRange(100, 2500, DEFAULT_VIEWPORT_H);
    expect(r.end).toBe(100);
  });

  it("padTop/padBottom 合计撑满 total", () => {
    const r = visibleRange(100, 0, DEFAULT_VIEWPORT_H);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe((100 - r.end) * ROW_HEIGHT);
  });
});
