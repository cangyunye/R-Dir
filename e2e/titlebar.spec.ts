import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 无边框窗口（decorations:false）自绘标题栏回归。
 *
 * 浏览器 e2e 里 Tauri 桩在位 → 自绘控制按钮可见；点击仅记录窗口命令
 * （mock 的 __RDIR_E2E_MOCK__.winCmds），断言"按钮 → 窗口命令"的接线。
 *
 * 双击最大化/还原的分工（v0.31.2 起）：Windows/Linux 归 Tauri 注入的 drag-region
 * 脚本（mousedown → internal_toggle_maximize，两边 is_maximizable 读窗口样式位，
 * 双向都好使）；macOS 上原生的放大分支被 is_maximizable() 挡死——无边框窗口没有
 * 标准标题栏按钮，该检查恒为 false，原生双击只能还原不能放大（tauri 2.x 未修）——
 * 因此 macOS 由 TabBar 在 mouseup 捕获阶段接管，改调无门槛的公开 toggle_maximize。
 * e2e 跑在 macOS（isMac=true）上，覆盖接管路径；拖动手感与真机缩放行为需真机验收。
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

test("双击标签栏空白处 → 前端恰好发起一次 toggle_maximize（macOS 接管原生坏掉的放大方向）", async ({
  page,
}) => {
  await setup(page);
  const bar = page.locator("[data-tauri-drag-region]").first();
  // 命中标签与右上角常驻区之间的空白带（target 是拖拽区本身）
  await bar.dblclick({ position: { x: 600, y: 10 } });
  // 必须恰好一次公开 toggle_maximize（两个方向都无门槛）；
  // 出现两次（接管 + 原生各一次）或 internal_toggle_maximize 都是回归
  expect(await winCmds(page)).toEqual(["toggle_maximize"]);
});

test("双击标签本体不切换窗口（标签双击 = 重命名，可点元素阻断 drag-region）", async ({
  page,
}) => {
  await setup(page);
  const tab = page.locator("[data-tab-idx]").first();
  await expect(tab).toBeVisible();
  await tab.dblclick();
  // 标签进入行内重命名，而不是发起窗口命令
  expect(await winCmds(page)).toEqual([]);
  await expect(page.locator('[placeholder="标签名"]')).toBeVisible();
});
