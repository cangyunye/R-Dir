import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/** 与 examples/themes 同格式的最小夹具（前端只消费 token，不走 Rust 安装） */
const AUTUMN = {
  id: "autumn-gold",
  name: "金秋",
  base: "light",
  tokens: { "--background": "oklch(0.975 0.018 85)", "--primary": "oklch(0.55 0.14 68)" },
};
const MAPLE = {
  id: "maple-red",
  name: "红枫",
  base: "dark",
  tokens: { "--background": "oklch(0.19 0.025 25)", "--primary": "oklch(0.68 0.17 30)" },
};

/** 在 tauri-mock 之上覆写 themes_list（mock 默认返回空列表） */
async function mockPacks(page: import("@playwright/test").Page) {
  await installTauriMock(page);
  await page.addInitScript((packs) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } })
      .__TAURI_INTERNALS__;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: Record<string, unknown>) =>
      cmd === "themes_list" ? Promise.resolve({ packs, errors: [] }) : orig(cmd, args);
  }, [AUTUMN, MAPLE]);
}

test.describe("主题包（v0.40）", () => {
  test("选中浅色包：写入内联 token + data-theme，不加 .dark", async ({ page }) => {
    await mockPacks(page);
    await page.addInitScript(() => localStorage.setItem("rfm.themePack", "autumn-gold"));
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "autumn-gold");
    await expect(html).not.toHaveClass(/dark/);
    const bg = await html.evaluate((n) =>
      (n as HTMLElement).style.getPropertyValue("--background"),
    );
    expect(bg).toBe("oklch(0.975 0.018 85)");
    await page.waitForTimeout(1400); // 等启动 splash 淡出，别把 loading 画面拍进去
    await page.screenshot({ path: "e2e-shots/theme-autumn-gold.png" });
  });

  test("深色底包：base=dark 自动加 .dark", async ({ page }) => {
    await mockPacks(page);
    await page.addInitScript(() => localStorage.setItem("rfm.themePack", "maple-red"));
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "maple-red");
    await page.waitForTimeout(1400);
    await page.screenshot({ path: "e2e-shots/theme-maple-red.png" });
  });

  test("设置面板：选包禁用颜色模式，回默认后恢复", async ({ page }) => {
    await mockPacks(page);
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    await page.getByTitle("设置（快捷键录制）").click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await expect(page.getByRole("button", { name: /金秋/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /红枫/ })).toBeVisible();

    await page.getByRole("button", { name: /金秋/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "autumn-gold");
    expect(await page.evaluate(() => localStorage.getItem("rfm.themePack"))).toBe("autumn-gold");
    await expect(page.getByRole("button", { name: "浅色", exact: true })).toBeDisabled();
    // 回归：卡片选中态不能再被分段钮的主色渐变整块涂满（v0.40.0 首次发布就是这个样子）
    await expect(page.locator(".theme-card").nth(1)).toHaveCSS("background-image", "none");
    await page.screenshot({ path: "e2e-shots/theme-settings-autumn.png" });

    await page.getByText("跟随颜色模式").click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(await page.evaluate(() => localStorage.getItem("rfm.themePack"))).toBeNull();
    await expect(page.getByRole("button", { name: "浅色", exact: true })).toBeEnabled();
  });
});
