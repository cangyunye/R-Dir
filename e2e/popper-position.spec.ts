import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 锚定弹层定位回归（根 zoom 统一补偿）。
 *
 * 背景：根元素 CSS zoom（界面字体，13px=100%）会让 Radix/Floating UI 的
 * portal 定位整体按 zoom 倍率偏移——弹层被推到触发点右下方 坐标×(zoom−1) 处。
 * ≥2000px 宽屏首次启动自动推荐 16px（zoom≈1.23）即触发；⋮ 应用菜单在右上角
 * 离原点最远，最大化时弹层整体出视口 → 表现为"点击无反应"，小窗口则边缘被裁。
 * index.css 现按 [data-radix-popper-content-wrapper] 统一补偿全部锚定弹层
 * （dropdown / context menu，及日后新增的 Select/Popover/Tooltip 等）。
 *
 * 运行：pnpm test:e2e -- popper-position
 */

const HOME = "/mock/home";
const EPS = 1; // zoom 折算管线的亚像素舍入容差（实测 ~0.09px）

type Box = { x: number; y: number; width: number; height: number };

function expectInsideViewport(box: Box, w: number, h: number) {
  expect(box.x).toBeGreaterThanOrEqual(-EPS);
  expect(box.y).toBeGreaterThanOrEqual(-EPS);
  expect(box.x + box.width).toBeLessThanOrEqual(w + EPS);
  // 弹层有内滚（maxHeight 按可用高度折算），底边允许贴视口但不许超出
  expect(box.y + box.height).toBeLessThanOrEqual(h + EPS);
}

async function setup(page: import("@playwright/test").Page, width: number, height: number, font: string) {
  await installTauriMock(page);
  // 同时写迁移标记，避免"存了 ≤13px 且未迁移 → 强制升级为自动推荐"的逻辑污染对照组
  await page.addInitScript(
    (f) => {
      localStorage.setItem("rfm.ui-font", f);
      localStorage.setItem("rfm.ui-font-migrated-v080", "1");
    },
    font,
  );
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
}

test.describe("⋮ 应用菜单（dropdown popper）", () => {
  const TRIGGER = '[title="应用菜单"]';
  const CONTENT = '[data-slot="dropdown-menu-content"]';

  test("最大化尺寸窗口 + 大屏自动字号16 → 弹层完整在视口内", async ({ page }) => {
    await setup(page, 1920, 1040, "16");
    await page.locator(TRIGGER).click();
    const content = page.locator(CONTENT).first();
    await expect(content).toBeVisible();
    expectInsideViewport((await content.boundingBox())!, 1920, 1040);
  });

  test("小窗口 + 字号16 → 弹层完整在视口内（右侧不再被裁）", async ({ page }) => {
    await setup(page, 900, 600, "16");
    await page.locator(TRIGGER).click();
    const content = page.locator(CONTENT).first();
    await expect(content).toBeVisible();
    expectInsideViewport((await content.boundingBox())!, 900, 600);
  });

  test("对照：字号13（zoom=1）两种窗口尺寸均正常", async ({ page }) => {
    await setup(page, 1920, 1040, "13");
    await page.locator(TRIGGER).click();
    await expect(page.locator(CONTENT).first()).toBeVisible();
    expectInsideViewport((await page.locator(CONTENT).first().boundingBox())!, 1920, 1040);
    await page.keyboard.press("Escape");
    await setup(page, 900, 600, "13");
    await page.locator(TRIGGER).click();
    await expect(page.locator(CONTENT).first()).toBeVisible();
    expectInsideViewport((await page.locator(CONTENT).first().boundingBox())!, 900, 600);
  });
});

test.describe("右键菜单（context-menu popper）", () => {
  const CONTENT = '[data-slot="context-menu-content"]';

  async function openAndMeasure(page: import("@playwright/test").Page, w: number, h: number) {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const content = page.locator(CONTENT).first();
    await expect(content).toBeVisible();
    expectInsideViewport((await content.boundingBox())!, w, h);
  }

  test("字号16（zoom≈1.23）→ 弹层完整在视口内", async ({ page }) => {
    await setup(page, 1920, 1040, "16");
    await openAndMeasure(page, 1920, 1040);
  });

  test("对照：字号13（zoom=1）→ 弹层完整在视口内", async ({ page }) => {
    await setup(page, 900, 600, "13");
    await openAndMeasure(page, 900, 600);
  });
});
