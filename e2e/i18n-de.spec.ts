import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * i18n 德语冒烟：rfm.language=de 预置后加载应用，
 * 断言设置面板 / 应用菜单 / 右键菜单 / 状态栏等关键界面为德语。
 * 语言持久化在 localStorage，预置于应用 JS 执行前（addInitScript）。
 */
test.describe("i18n 德语冒烟", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("rfm.language", "de");
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  });

  test("设置面板：语言项与分区导航为德语", async ({ page }) => {
    await page.getByTitle("Einstellungen (Tastenbelegung aufnehmen)").click();
    await expect(page.getByRole("button", { name: "Darstellung" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tastenkürzel" })).toBeVisible();
    await expect(page.getByText("Farbmodus")).toBeVisible();
    // 语言下拉当前选中 Deutsch
    await expect(page.getByRole("combobox", { name: "Sprache" })).toHaveValue("de");
  });

  test("应用菜单：条目为德语", async ({ page }) => {
    await page.getByTitle("App-Menü").click();
    await expect(page.getByRole("menuitem", { name: /Neuer Tab/ })).toBeVisible();
    await expect(page.getByText("Datei", { exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Versteckte Dateien anzeigen/ })).toBeVisible();
  });

  test("右键菜单：条目为德语", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Öffnen", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Umbenennen" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Löschen (Papierkorb)" })).toBeVisible();
  });

  test("状态栏与工具栏：为德语", async ({ page }) => {
    await expect(page.getByText("6 Einträge")).toBeVisible();
    await expect(page.getByTitle("Zurück", { exact: true })).toBeVisible();
    await expect(page.getByTitle("Übergeordneter Ordner", { exact: true })).toBeVisible();
  });

  test("语言持久化：重载后仍是德语", async ({ page }) => {
    await expect(page.getByTitle("App-Menü")).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`).first()).toBeVisible();
    await expect(page.getByTitle("App-Menü")).toBeVisible();
  });
});
