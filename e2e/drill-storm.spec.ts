import { test, expect } from "@playwright/test";
import { disablePreview, installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** v0.52 快速连钻卡死修复回归：list_dir 600ms + 刷新风暴（模拟 watcher 事件），
 *  同路径在途加载合并——风暴不重启加载，单次在途完成即落账。
 */
test("刷新风暴中的快速连钻（同路在途合并）", async ({ page }) => {
  test.slow();
  await disablePreview(page);
  await installTauriMock(page);
  await page.addInitScript(() => {
    (window as unknown as { __RDIR_IPC_DELAY__: unknown }).__RDIR_IPC_DELAY__ = { list_dir: 600 };
  });
  await page.goto("/");
  await page.locator("[data-pathbar-edit]").click();
  await page.locator("#rdir-addr-input").fill("/mock/deep");
  await page.locator("#rdir-addr-input").press("Enter");
  await page.locator(`[data-view-mode="details"]`).click();
  await expect(page.locator(`[data-path="/mock/deep/L1"]`)).toBeVisible({ timeout: 8000 });

  const row = (p: string) => page.locator(`[data-path="${p}"]`);
  await row("/mock/deep/L1").dblclick();
  await expect(row("/mock/deep/L1/L2")).toBeVisible({ timeout: 8000 });
  // 双击 L2 进入 L3（list_dir 600ms），期间每 100ms 一次刷新（模拟 watcher 事件风暴）
  await row("/mock/deep/L1/L2").dblclick();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press(`${MOD}+r`);
    await page.waitForTimeout(100);
  }
  // 合并语义：单次在途加载完成即出现（~600ms），风暴不重启加载；地址落在 L2
  await expect(row("/mock/deep/L1/L2/L3")).toBeVisible({ timeout: 1200 });
  await expect(page.locator("#rdir-addr-input")).toHaveValue("/mock/deep/L1/L2", { timeout: 3000 });
});
