import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * v0.52 树形列表预览回归：嵌套子目录内的选中项不在 pane.entries（children 由树
 * 组件本地持有）→ App 经 stat_entry 异步取真实元数据喂预览栏；目录不给预览。
 * 预览 enabled 只活在本次运行（App.tsx:695），用例以空格开启预览栏。
 */
test("树形列表：嵌套子目录文件点击可预览", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

  // 切树形 → 展开 Documents → 点嵌套文件 readme.md（不在 pane.entries）→ 空格开预览栏
  await page.locator('[data-view-mode="tree"]').click();
  await page.locator(`[role="row"][data-path="${HOME}/Documents"] [aria-label]`).click();
  const readme = page.locator(`[role="row"][data-path="${HOME}/Documents/readme.md"]`);
  await expect(readme).toBeVisible();
  await readme.click();
  // 空格开预览栏（预览 enabled 只活在本次运行，localStorage 不生效）
  await page.keyboard.press(" ");

  // 预览栏展示该文件（头部文件名），不再是「选择一个文件以预览」空态
  await expect(page.locator('[data-testid="preview-drawer"]')).toContainText("readme.md");
  await expect(page.getByText("选择一个文件以预览")).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/tree-preview.png" });
});
