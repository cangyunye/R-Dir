import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 无边框窗口（decorations:false）自绘标题栏回归。
 *
 * 浏览器 e2e 里 Tauri 桩在位 → 自绘控制按钮可见；点击仅记录窗口命令
 * （mock 的 __RDIR_E2E_MOCK__.winCmds），断言"按钮 → 窗口命令"的接线。
 * 真实窗口里拖动移动 / 双击最大化由 Tauri 注入的 drag-region 脚本实现
 * （macOS mouseup / Win-Linux mousedown → internal_toggle_maximize，浏览器 e2e
 * 无此脚本）；因此双击空白处在前端侧必须**零**窗口命令——一旦 React 侧再挂
 * onDoubleClick 就会与原生各切换一次（放大后立刻还原），这里守住这条线。
 * 拖动手感与双击切换本身需真机验收。
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

test("双击标签栏空白处不产生前端窗口命令（最大化/还原归 Tauri 原生 drag region）", async ({
  page,
}) => {
  await setup(page);
  const bar = page.locator("[data-tauri-drag-region]").first();
  // 命中标签与右上角常驻区之间的空白带（target 是拖拽区本身）
  await bar.dblclick({ position: { x: 600, y: 10 } });
  // 回归守卫：前端侧再手动 toggle（如 React onDoubleClick）会与原生各切换一次，
  // 表现为放大后立刻还原——这里断言双击在前端侧零命令
  expect(await winCmds(page)).toEqual([]);
});
