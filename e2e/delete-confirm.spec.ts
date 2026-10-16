import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/** 删除确认框回车回归：确认删除的同时，不得把（刚删除的）选中文件打开 */
test.describe("删除确认回车（不打开已删除文件）", () => {
  test("Delete 呼出确认框 → 回车确认：文件删除、打开器未触发", async ({ page }) => {
    await installTauriMock(page);
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    // 选中文件 → Delete 呼出确认框
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press("Delete");
    const dialog = page.locator("[data-delete-confirm]");
    await expect(dialog).toBeVisible();

    // 回车确认删除
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);
    await expect(dialog).not.toBeVisible();

    // 同一回车不得落入全局键位「打开」：系统打开器必须一次都没触发
    const opened = await page.evaluate(
      () =>
        (window as unknown as { __RDIR_E2E_MOCK__: { opened: string[] } }).__RDIR_E2E_MOCK__
          .opened,
    );
    expect(opened, "回车确认删除不应打开选中文件").toEqual([]);
  });

  test("Esc 取消删除：文件保留、打开器未触发", async ({ page }) => {
    await installTauriMock(page);
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press("Delete");
    const dialog = page.locator("[data-delete-confirm]");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    const opened = await page.evaluate(
      () =>
        (window as unknown as { __RDIR_E2E_MOCK__: { opened: string[] } }).__RDIR_E2E_MOCK__
          .opened,
    );
    expect(opened).toEqual([]);
  });
});
