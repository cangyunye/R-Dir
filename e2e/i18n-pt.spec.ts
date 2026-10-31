import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * i18n 葡萄牙语冒烟：rfm.language=pt 预置后加载应用，
 * 断言设置面板 / 应用菜单 / 状态栏等关键界面为葡萄牙语。
 */
test.describe("i18n 葡萄牙语冒烟", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("rfm.language", "pt");
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  });

  test("设置面板：语言项与分区导航为葡萄牙语", async ({ page }) => {
    await page.getByTitle("Configurações (gravação de atalhos)").click();
    await expect(page.getByRole("button", { name: "Aparência" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atalhos", exact: true })).toBeVisible();
    await expect(page.getByText("Modo de cor")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Idioma" })).toHaveValue("pt");
  });

  test("应用菜单：条目为葡萄牙语", async ({ page }) => {
    await page.getByTitle("Menu do app").click();
    await expect(page.getByRole("menuitem", { name: /Nova aba/ })).toBeVisible();
    await expect(page.getByText("Arquivo", { exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Mostrar arquivos ocultos/ })).toBeVisible();
  });

  test("状态栏：为葡萄牙语", async ({ page }) => {
    await expect(page.getByText("6 itens")).toBeVisible();
  });
});
