import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * i18n 日语冒烟：rfm.language=ja 预置后加载应用，
 * 断言设置面板 / 应用菜单 / 右键菜单 / 状态栏等关键界面为日语。
 * 语言持久化在 localStorage，预置于应用 JS 执行前（addInitScript）。
 */
test.describe("i18n 日语冒烟", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("rfm.language", "ja");
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  });

  test("设置面板：语言项与分区导航为日语", async ({ page }) => {
    await page.getByTitle("設定（ショートカット記録）").click();
    await expect(page.getByRole("button", { name: "外観", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "ショートカット", exact: true })).toBeVisible();
    await expect(page.getByText("カラーモード")).toBeVisible();
    // 语言下拉当前选中 日本語
    await expect(page.getByRole("combobox", { name: "表示言語" })).toHaveValue("ja");
  });

  test("应用菜单：条目为日语", async ({ page }) => {
    await page.getByTitle("アプリメニュー").click();
    await expect(page.getByRole("menuitem", { name: /新しいタブ/ })).toBeVisible();
    await expect(page.getByText("ファイル", { exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /隠しファイルを表示/ })).toBeVisible();
  });

  test("右键菜单：条目为日语", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "開く", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "名前変更" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "削除（ゴミ箱）" })).toBeVisible();
  });

  test("状态栏与工具栏：为日语", async ({ page }) => {
    await expect(page.getByText("6 件")).toBeVisible();
    await expect(page.getByTitle("戻る", { exact: true })).toBeVisible();
    await expect(page.getByTitle("親フォルダー", { exact: true })).toBeVisible();
  });

  test("语言持久化：重载后仍是日语", async ({ page }) => {
    await expect(page.getByTitle("アプリメニュー")).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`).first()).toBeVisible();
    await expect(page.getByTitle("アプリメニュー")).toBeVisible();
  });
});
