import { test, expect } from "@playwright/test";
import { disablePreview, installTauriMock } from "./tauri-mock";

/**
 * v0.52 批量改名 e2e：多选→右键入口→规则预览→执行→撤销；
 * 目录匹配 + 翻页（/mock/bulk 25 条夹具）；Windows UA 的非法名校验。
 */

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function openBatchRename(page: import("@playwright/test").Page, firstPath: string) {
  await page.locator(`[data-path="${firstPath}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "批量改名…" }).click();
  const dlg = page.locator('[data-testid="batch-rename-dialog"]');
  await expect(dlg).toBeVisible();
  return dlg;
}

test.beforeEach(async ({ page }) => {
  await disablePreview(page);
  await installTauriMock(page);
});

test("多选→规则替换→执行→撤销", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

  // 多选两项
  await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
  await page.locator(`[data-path="${HOME}/photo.png"]`).click({ modifiers: [MOD] });

  const dlg = await openBatchRename(page, `${HOME}/Notes.txt`);
  await expect(dlg.locator('[data-testid="br-row"]')).toHaveCount(2);

  // 规则：Notes → 笔记（photo.png 不受影响 → 未修改）
  await dlg.locator('[data-testid="br-find"]').fill("Notes");
  await dlg.locator('[data-testid="br-replace"]').fill("笔记");
  await expect(dlg.locator('[data-testid="br-row"]').nth(0)).toHaveAttribute("data-br-status", "ready");
  await expect(dlg.locator('[data-testid="br-row"]').nth(1)).toHaveAttribute("data-br-status", "unchanged");
  await expect(dlg.locator('[data-testid="br-execute"]')).toHaveText(/直接改名·1/);

  // 执行：行状态成功，窗格刷新出新名
  await dlg.locator('[data-testid="br-execute"]').click();
  await expect(dlg.locator('[data-br-status="success"]').first()).toBeVisible();
  await expect(page.locator(`[data-path="${HOME}/笔记.txt"]`)).toBeVisible();
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);

  // 撤销：还原旧名，撤销按钮复位禁用
  await dlg.locator('[data-testid="br-undo"]').click();
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  await expect(dlg.locator('[data-testid="br-undo"]')).toBeDisabled();
});

test("当前目录匹配 + 翻页（25 条夹具）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

  // 地址栏直达 /mock/bulk（25 个文件）
  await page.locator("[data-pathbar-edit]").click();
  await page.locator("#rdir-addr-input").fill("/mock/bulk");
  await page.locator("#rdir-addr-input").press("Enter");
  await expect(page.locator(`[data-path="/mock/bulk/bulk01.txt"]`)).toBeVisible();

  // 先选两项凑出右键入口，对话框内切「当前目录匹配」圈定全部 25 条
  await page.locator(`[data-path="/mock/bulk/bulk01.txt"]`).click();
  await page.locator(`[data-path="/mock/bulk/bulk02.txt"]`).click({ modifiers: [MOD] });
  const dlg = await openBatchRename(page, `/mock/bulk/bulk01.txt`);
  await dlg.locator('[data-testid="br-source-dir"]').click();

  // 第一页 20 条，第二页 5 条
  await expect(dlg.locator('[data-testid="br-row"]')).toHaveCount(20);
  await dlg.locator('[data-testid="br-page-next"]').click();
  await expect(dlg.locator('[data-testid="br-row"]')).toHaveCount(5);
  await expect(dlg.locator('[data-testid="br-row"]').first()).toContainText("bulk21.txt");

  // 规则 bulk→文件：25 条全部就绪，执行后全成功
  await dlg.locator('[data-testid="br-find"]').fill("bulk");
  await dlg.locator('[data-testid="br-replace"]').fill("文件");
  await expect(dlg.locator('[data-testid="br-execute"]')).toHaveText(/直接改名·25/);
  await dlg.locator('[data-testid="br-execute"]').click();
  // 表格只渲染当前页（第二页 5 行）→ 全部成功；翻回第一页核对其余 20 行
  await expect(dlg.locator('[data-br-status="success"]')).toHaveCount(5);
  await expect(page.locator(`[data-path="/mock/bulk/文件01.txt"]`)).toBeVisible();
  await dlg.locator('[data-testid="br-page-prev"]').click();
  await expect(dlg.locator('[data-br-status="success"]')).toHaveCount(20);
});

test.use({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" });
test("Windows 规则：非法字符标非法且不可执行", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

  await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
  await page.locator(`[data-path="${HOME}/photo.png"]`).click({ modifiers: [MOD] });
  const dlg = await openBatchRename(page, `${HOME}/Notes.txt`);

  // 后缀带 Windows 非法字符 → 非法，执行按钮禁用
  await dlg.locator('[data-testid="br-suffix"]').fill("<");
  await expect(dlg.locator('[data-br-status="invalid"]').first()).toBeVisible();
  await expect(dlg.locator('[data-testid="br-execute"]')).toBeDisabled();
});
