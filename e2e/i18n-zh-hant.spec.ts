import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * i18n 繁体中文冒烟：rfm.language=zh-Hant 预置后加载应用，
 * 断言设置面板 / 应用菜单 / 状态栏等关键界面为繁体中文。
 */
test.describe("i18n 繁体中文冒烟", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("rfm.language", "zh-Hant");
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  });

  test("设置面板：语言项与分区导航为繁体中文", async ({ page }) => {
    await page.getByTitle("設定（快速鍵錄製）").click();
    await expect(page.getByRole("button", { name: "外觀" })).toBeVisible();
    await expect(page.getByRole("button", { name: "快速鍵", exact: true })).toBeVisible();
    await expect(page.getByText("色彩模式")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "介面語言" })).toHaveValue("zh-Hant");
  });

  test("应用菜单：条目为繁体中文", async ({ page }) => {
    await page.getByTitle("應用程式選單").click();
    await expect(page.getByRole("menuitem", { name: /新增標籤頁/ })).toBeVisible();
    await expect(page.getByText("檔案", { exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /顯示隱藏檔案/ })).toBeVisible();
  });

  test("状态栏：为繁体中文", async ({ page }) => {
    await expect(page.getByText("6 項")).toBeVisible();
  });
});
