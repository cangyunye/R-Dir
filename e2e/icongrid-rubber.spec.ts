import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  // 启动闪屏（fixed inset-0 z-[9999]，fade 500ms）：裸 page.mouse 坐标不等可点性，
  // 必须等闪屏卸载再进行框选手势，否则按压落在闪屏上
  await expect(page.locator('[class*="z-[9999]"]')).toHaveCount(0);
});

test.describe("大图标框选（v0.49：缝隙起框 + zoom 下框贴鼠标）", () => {
  const RUBBER = '[data-icongrid-body] [class*="border-primary/70"]';

  test("根 zoom≠1 下框边贴鼠标 ±2px、缝隙（贴近文件 8px）可起框、mouseup 命中选择", async ({
    page,
  }) => {
    await page.locator('[data-view-switch] button[data-view-mode="icons"]').click();
    await expect(page.locator("[data-grid-item]").first()).toBeVisible();

    // App 根 zoom = 字号/13（e2e 环境迁移后取 14 → ≈1.0769，真实用户 15 → ≈1.1538）：
    // 修复前画的框被放大 7.7%，起点越远偏得越多
    const rootZoom = await page.evaluate(() =>
      Number.parseFloat(document.documentElement.style.zoom || "1"),
    );
    expect(rootZoom).toBeGreaterThan(1.05);

    const body = await page.locator("[data-icongrid-body]").boundingBox();
    expect(body).toBeTruthy();
    // 起点 = 网格内容左上角 (4,4)：在 GRID_PAD=12 的缝隙里、距首个图标 8px——
    // 修复前该按压 target=全尺寸内层 div 被严格门早退，框根本起不来
    const sx = body!.x + 4;
    const sy = body!.y + 4;
    const ex = body!.x + 200;
    const ey = body!.y + 200;

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 8 });
    await expect(page.locator(RUBBER)).toBeVisible();

    // 框矩形与鼠标轨迹对齐（视觉像素）：修复前 (200,200) 终点画在 ~230px 处
    const rb = (await page.locator(RUBBER).boundingBox())!;
    expect(Math.abs(rb.x - Math.min(sx, ex))).toBeLessThanOrEqual(2);
    expect(Math.abs(rb.y - Math.min(sy, ey))).toBeLessThanOrEqual(2);
    expect(Math.abs(rb.width - Math.abs(ex - sx))).toBeLessThanOrEqual(2);
    expect(Math.abs(rb.height - Math.abs(ey - sy))).toBeLessThanOrEqual(2);

    await page.mouse.up();
    // 框带覆盖首格图标 → Documents 入选；至少一个条目被框中
    const selected = await page
      .locator('[data-grid-item][aria-selected="true"]')
      .count();
    expect(selected).toBeGreaterThanOrEqual(1);
    await expect(
      page.locator(`[data-grid-item][data-path="${HOME}/Documents"]`),
    ).toHaveAttribute("aria-selected", "true");
    // 框选后橡皮筋收起
    await expect(page.locator(RUBBER)).toHaveCount(0);
  });

  test("按在图标上不起框：仍走选中 + 拖拽候选（访达语义不变）", async ({ page }) => {
    await page.locator('[data-view-switch] button[data-view-mode="icons"]').click();
    await expect(page.locator("[data-grid-item]").first()).toBeVisible();
    const item = page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`);
    const box = (await item.boundingBox())!;
    // 按下不拖：立即选中（startItemPress）
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(item).toHaveAttribute("aria-selected", "true");
    // 框从未出现（拖拽候选路径，不是框选）
    await expect(page.locator(RUBBER)).toHaveCount(0);
  });
});

test.describe("详情列表框选回归（v0.49 isBlankPress 未注入侧行为不变 + zoom 对齐）", () => {
  test("空白按下拖出矩形贴鼠标并选中行", async ({ page }) => {
    const RUBBER = '[data-filelist-body] [class*="border-primary/70"]';
    const body = await page.locator("[data-filelist-body]").boundingBox();
    expect(body).toBeTruthy();
    // 列表底部空白（行之外、横向滚动条之上——滚动条区域 Chromium 不派发鼠标事件）：
    // target=scroller 本体，走原严格门
    const sx = body!.x + 60;
    const sy = body!.y + body!.height - 30;
    const ex = sx + 180;
    // 终点拖到列表顶部行区：起点在行下空白（padBottom 垫高 div），向上罩住行才能命中
    const ey = body!.y + 40;

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 8 });
    await expect(page.locator(RUBBER)).toBeVisible();
    const rb = (await page.locator(RUBBER).boundingBox())!;
    expect(Math.abs(rb.x - Math.min(sx, ex))).toBeLessThanOrEqual(2);
    expect(Math.abs(rb.y - Math.min(sy, ey))).toBeLessThanOrEqual(2);
    expect(Math.abs(rb.width - Math.abs(ex - sx))).toBeLessThanOrEqual(2);
    await page.mouse.up();
    // 详情行的选中态是 bg-selected 类（无 aria-selected）
    const selected = await page.locator('[role="row"][class*="bg-selected"]').count();
    expect(selected).toBeGreaterThanOrEqual(1);
  });
});
