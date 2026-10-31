import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * i18n 西班牙语冒烟：rfm.language=es 预置后加载应用，
 * 断言设置面板 / 应用菜单 / 状态栏等关键界面为西班牙语。
 */
test.describe("i18n 西班牙语冒烟", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("rfm.language", "es");
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  });

  test("设置面板：语言项与分区导航为西班牙语", async ({ page }) => {
    await page.getByTitle("Configuración (grabación de atajos)").click();
    await expect(page.getByRole("button", { name: "Apariencia" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atajos", exact: true })).toBeVisible();
    await expect(page.getByText("Modo de color")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Idioma" })).toHaveValue("es");
  });

  test("应用菜单：条目为西班牙语", async ({ page }) => {
    await page.getByTitle("Menú de la app").click();
    await expect(page.getByRole("menuitem", { name: /Nueva pestaña/ })).toBeVisible();
    await expect(page.getByText("Archivo", { exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Mostrar archivos ocultos/ })).toBeVisible();
  });

  test("状态栏：为西班牙语", async ({ page }) => {
    await expect(page.getByText("6 elementos")).toBeVisible();
  });
});
