/**
 * v0.52 解压撞名覆盖确认回归：后端返回 EXTRACT_CONFLICT|<落点名>（不静默编号）→
 * 前端弹覆盖确认（覆盖=带 overwrite 重解原名合并；取消=放弃本次解压）。
 * __rdirExtract 脚本化模拟后端契约（前两次撞名、第三次成功）。
 */
import { test, expect } from "@playwright/test";
import { disablePreview, installTauriMock } from "./tauri-mock";

test("解压撞名弹覆盖确认：覆盖重试成功 / 取消放弃", async ({ page }) => {
  await disablePreview(page);
  await installTauriMock(page);
  await page.addInitScript(() => {
    let calls = 0;
    (window as unknown as { __rdirExtract?: unknown }).__rdirExtract = (c: {
      targetDir: string;
    }) => {
      // 每轮首次调用模拟后端撞名码；覆盖重试（第三次）走正常成功返回
      calls += 1;
      if (calls <= 2) {
        return "EXTRACT_CONFLICT|sample";
      }
      return { dest: `${c.targetDir}/sample`, files: 3, skipped: 0, bytes: 100 };
    };
  });
  await page.goto("/");
  await page.locator("[data-pathbar-edit]").click();
  await page.locator("#rdir-addr-input").fill("/mock/archives");
  await page.locator("#rdir-addr-input").press("Enter");
  const zip = page.locator('[data-path="/mock/archives/sample.zip"]');
  await expect(zip).toBeVisible();

  const menu = page.locator('[data-slot="context-menu-content"]').last();

  // 右键 → 展开「解压」组 → 解压到此处 → 撞名弹覆盖确认
  await zip.click({ button: "right" });
  await menu.getByText("解压", { exact: true }).click();
  await menu.getByText("解压到此处").click();
  await expect(page.getByText("解压目标已存在")).toBeVisible();
  await expect(page.getByRole("button", { name: "覆盖解压" })).toBeVisible();

  // 取消 → 放弃本次解压（无成功提示）
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("解压目标已存在")).toHaveCount(0);

  // 再解压 → 覆盖 → 成功提示
  await zip.click({ button: "right" });
  await menu.getByText("解压", { exact: true }).click();
  await menu.getByText("解压到此处").click();
  await expect(page.getByText("解压目标已存在")).toBeVisible();
  await page.getByRole("button", { name: "覆盖解压" }).click();
  await expect(page.getByText(/已解压到 sample（3 项）/)).toBeVisible({ timeout: 5000 });
});
