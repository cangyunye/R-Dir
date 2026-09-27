import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 无边框窗口（decorations:false）自绘标题栏回归。
 *
 * 浏览器 e2e 里 Tauri 桩在位 → 自绘控制按钮可见；点击仅记录窗口命令
 * （mock 的 __RDIR_E2E_MOCK__.winCmds），断言"按钮 → 窗口命令"的接线。
 * 真实窗口里拖动移动 / 双击最大化由 Tauri 注入脚本与 WindowControls 实现；
 * 双击接线的浏览器侧行为可通过桩观测，拖动手感需真机验收。
 *
 * 运行：pnpm test:e2e -- titlebar
 */

const HOME = "/mock/home";

async function setup(page: import("@playwright/test").Page) {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
}

function winCmds(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => (window as unknown as { __RDIR_E2E_MOCK__: { winCmds: string[] } }).__RDIR_E2E_MOCK__.winCmds,
  );
}

test("自绘窗口控制：最小化/最大化/关闭 接线正确", async ({ page }) => {
  await setup(page);
  // 标签栏兼任标题栏：根节点带拖拽区标记（真实窗口里按住拖动移动窗口）
  await expect(page.locator("[data-tauri-drag-region]").first()).toBeAttached();

  await page.locator('[title="最小化"]').click();
  await page.locator('[title="最大化"]').click();
  await page.locator('[title="关闭"]').click();

  expect(await winCmds(page)).toEqual(["minimize", "toggle_maximize", "close"]);
});

test("双击标签栏空白处 = 最大化/还原", async ({ page }) => {
  await setup(page);
  const bar = page.locator("[data-tauri-drag-region]").first();
  // 命中标签与右上角常驻区之间的空白带（target 必须是拖拽区本身）
  await bar.dblclick({ position: { x: 600, y: 10 } });
  expect(await winCmds(page)).toContain("toggle_maximize");
});
