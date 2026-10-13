import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
});

// 侧边栏标签右键 → 重命名… 对话框 → 改名保存
test("T1 sidebar tag rename dialog works", async ({ page }) => {
  const sidebar = page.locator("text=标签").first();
  await sidebar.waitFor();
  // 红色标签行
  const tagRow = page.getByTitle(/查看「红色」标签的文件/);
  await tagRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: /重命名/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const input = dialog.locator("input");
  await expect(input).toBeFocused();
  await input.fill("紧急");
  await dialog.getByRole("button", { name: "保存" }).click();
  // 标签名更新（tagNames persist → 侧栏显示新名）
  await expect(page.getByTitle(/查看「紧急」标签的文件/)).toBeVisible();
});
