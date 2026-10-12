import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
});

test.describe("主列表重命名", () => {
  test("右键→重命名→回车提交：列表出现新名", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();

    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    await input.fill("Renamed.txt");
    await input.press("Enter");

    await expect(page.locator(`[data-path="${HOME}/Renamed.txt"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);
  });

  test("右键→重命名→点击其他行提交（失焦提交）", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();

    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await input.fill("Blurred.txt");
    // 点击其他行触发失焦提交
    await page.locator(`[data-path="${HOME}/photo.png"]`).click();
    await expect(page.locator(`[data-path="${HOME}/Blurred.txt"]`)).toBeVisible();
  });

  test("F2 重命名 → 回车提交", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press("F2");
    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    await input.fill("F2ed.txt");
    await input.press("Enter");
    await expect(page.locator(`[data-path="${HOME}/F2ed.txt"]`)).toBeVisible();
  });
});
