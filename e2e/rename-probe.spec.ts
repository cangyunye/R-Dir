import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
});

// F2 → 真实逐键输入 → Enter
test("P1 F2 rename with real typing", async ({ page }) => {
  const row = page.locator(`[data-path="${HOME}/Notes.txt"]`);
  await row.click();
  await page.keyboard.press("F2");
  const input = row.locator("input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(400);
  await expect(input).toBeFocused();
  // 全选后逐键输入新名
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyA`);
  await page.keyboard.type("Typed.txt", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-path="${HOME}/Typed.txt"]`)).toBeVisible();
});

// 慢速双击 → 逐键输入 → Enter
test("P2 slow double click rename", async ({ page }) => {
  const row = page.locator(`[data-path="${HOME}/photo.png"]`);
  await row.click();
  await page.waitForTimeout(700);
  await row.click();
  const input = row.locator("input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(400);
  await expect(input).toBeFocused();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyA`);
  await page.keyboard.type("pic.png", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-path="${HOME}/pic.png"]`)).toBeVisible();
});

// 右键重命名 → 逐键输入 → 点另一行（全局 mousedown 收口提交）
test("P3 rename commit via outside mousedown", async ({ page }) => {
  const row = page.locator(`[data-path="${HOME}/Notes.txt"]`);
  await row.click({ button: "right" });
  await page.getByRole("menu").getByText("重命名").click();
  const input = row.locator("input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(400);
  await expect(input).toBeFocused();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyA`);
  await page.keyboard.type("Clicked.txt", { delay: 30 });
  await page.locator(`[data-path="${HOME}/photo.png"]`).click();
  await expect(page.locator(`[data-path="${HOME}/Clicked.txt"]`)).toBeVisible();
});

// 重命名期间 ESC 取消：名字不变
test("P4 rename escape cancels", async ({ page }) => {
  const row = page.locator(`[data-path="${HOME}/Notes.txt"]`);
  await row.click();
  await page.keyboard.press("F2");
  const input = row.locator("input");
  await expect(input).toBeVisible();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyA`);
  await page.keyboard.type("ShouldNotExist.txt", { delay: 30 });
  await page.keyboard.press("Escape");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  await expect(page.locator(`[data-path="${HOME}/ShouldNotExist.txt"]`)).toHaveCount(0);
});

// 大图标网格内：右键重命名 → 逐键输入 → Enter
test("P5 icon grid rename", async ({ page }) => {
  await page.keyboard.press("Alt+2");
  const item = page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`);
  await expect(item).toBeVisible();
  await item.click({ button: "right" });
  await page.getByRole("menu").getByText("重命名").click();
  const input = item.locator("input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(400);
  await expect(input).toBeFocused();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyA`);
  await page.keyboard.type("Grid.txt", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-grid-item][data-path="${HOME}/Grid.txt"]`)).toBeVisible();
});

// 双击右键菜单「重命名」项：第二次 mousedown 落在已挂载输入框外，不应把会话吞掉
test("P6 double click rename menu item keeps session", async ({ page }) => {
  const row = page.locator(`[data-path="${HOME}/Notes.txt"]`);
  await row.click({ button: "right" });
  const item = page.getByRole("menuitem", { name: /重命名/ });
  await item.dblclick();
  const input = row.locator("input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(400);
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyA`);
  await page.keyboard.type("Dbl.txt", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-path="${HOME}/Dbl.txt"]`)).toBeVisible();
});
