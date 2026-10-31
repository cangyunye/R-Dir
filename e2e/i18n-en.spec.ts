import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * i18n 英文冒烟（v0.38）：rfm.language=en 预置后加载应用，
 * 断言设置面板 / 应用菜单 / 右键菜单 / 状态栏等关键界面为英文。
 * 语言持久化在 localStorage，预置于应用 JS 执行前（addInitScript）。
 */
test.describe("i18n 英文冒烟", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("rfm.language", "en");
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  });

  test("设置面板：语言项与分区导航为英文", async ({ page }) => {
    await page.getByTitle("Settings (shortcut recording)").click();
    await expect(page.getByRole("button", { name: "Appearance" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Shortcuts" })).toBeVisible();
    await expect(page.getByText("Color mode")).toBeVisible();
    // 语言下拉当前选中 English
    await expect(page.getByRole("combobox", { name: "Language" })).toHaveValue("en");
  });

  test("应用菜单：条目为英文", async ({ page }) => {
    await page.getByTitle("App menu").click();
    await expect(page.getByRole("menuitem", { name: /New tab/ })).toBeVisible();
    await expect(page.getByText("File", { exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Show hidden files/ })).toBeVisible();
  });

  test("右键菜单：条目为英文", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete (trash)" })).toBeVisible();
  });

  test("状态栏与工具栏：为英文", async ({ page }) => {
    await expect(page.getByText("6 items")).toBeVisible();
    await expect(page.getByTitle("Back")).toBeVisible();
    await expect(page.getByTitle("Parent folder")).toBeVisible();
  });

  test("语言持久化：重载后仍是英文", async ({ page }) => {
    await expect(page.getByTitle("App menu")).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`).first()).toBeVisible();
    await expect(page.getByTitle("App menu")).toBeVisible();
  });
});
