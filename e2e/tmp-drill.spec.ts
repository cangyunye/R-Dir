import { test, expect } from "@playwright/test";
import { disablePreview, installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

for (const mode of ["details", "tree"] as const) {
  test(`快速连钻深层目录（${mode}，大列表+120ms）`, async ({ page }) => {
    test.slow();
    await disablePreview(page);
    await installTauriMock(page);
    await page.addInitScript(() => {
      (window as unknown as { __RDIR_IPC_DELAY__: unknown }).__RDIR_IPC_DELAY__ = { list_dir: 120 };
    });
    await page.goto("/");
    await page.locator("[data-pathbar-edit]").click();
    await page.locator("#rdir-addr-input").fill("/mock/deep");
    await page.locator("#rdir-addr-input").press("Enter");
    await page.locator(`[data-view-mode="${mode}"]`).click();

    const row = (p: string) => page.locator(`[data-path="${p}"]`);

    // 每层：等子行出现（= 加载完成、列表可交互）再双击下一层
    await expect(row("/mock/deep/L1")).toBeVisible({ timeout: 8000 });
    await row("/mock/deep/L1").dblclick();
    await expect(row("/mock/deep/L1/L2")).toBeVisible({ timeout: 8000 });
    await row("/mock/deep/L1/L2").dblclick();
    await expect(row("/mock/deep/L1/L2/L3")).toBeVisible({ timeout: 8000 });
    await row("/mock/deep/L1/L2/L3").dblclick();
    await expect(row("/mock/deep/L1/L2/L3/f3_001.txt")).toBeVisible({ timeout: 8000 });
    await expect(page.locator("#rdir-addr-input")).toHaveValue("/mock/deep/L1/L2/L3", { timeout: 5000 });
  });
}
