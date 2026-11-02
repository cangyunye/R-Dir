import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/** 与 examples/themes 同格式的最小夹具（前端只消费 token，不走 Rust 安装） */
const AUTUMN = {
  id: "autumn-gold",
  name: "金秋",
  base: "light",
  tokens: { "--background": "oklch(0.975 0.018 85)", "--primary": "oklch(0.55 0.14 68)" },
};
const WINE = {
  id: "wine-red",
  name: "酒红",
  base: "dark",
  tokens: { "--background": "oklch(0.19 0.022 15)", "--primary": "oklch(0.66 0.17 10)" },
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
  }, [AUTUMN, WINE]);
}

test.describe("主题包（v0.39）", () => {
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
    await page.addInitScript(() => localStorage.setItem("rfm.themePack", "wine-red"));
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "wine-red");
    await page.waitForTimeout(1400);
    await page.screenshot({ path: "e2e-shots/theme-wine-red.png" });
  });

  test("设置面板：选包禁用颜色模式，回默认后恢复", async ({ page }) => {
    await mockPacks(page);
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    await page.getByTitle("设置（快捷键录制）").click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await expect(page.getByRole("button", { name: /金秋/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /酒红/ })).toBeVisible();

    await page.getByRole("button", { name: /金秋/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "autumn-gold");
    expect(await page.evaluate(() => localStorage.getItem("rfm.themePack"))).toBe("autumn-gold");
    await expect(page.getByRole("button", { name: "浅色", exact: true })).toBeDisabled();
    // 回归：卡片选中态不能再被分段钮的主色渐变整块涂满（v0.39.0 首次发布就是这个样子）
    await expect(page.locator(".theme-card").nth(1)).toHaveCSS("background-image", "none");
    await page.screenshot({ path: "e2e-shots/theme-settings-autumn.png" });

    await page.getByText("跟随颜色模式").click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(await page.evaluate(() => localStorage.getItem("rfm.themePack"))).toBeNull();
    await expect(page.getByRole("button", { name: "浅色", exact: true })).toBeEnabled();
  });
});

test.describe("示例包（examples/themes）", () => {
  const dir = "examples/themes";
  const packs = readdirSync(dir)
    .filter((f) => f.endsWith(".rdtheme.json"))
    .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));

  test("全部示例包都能应用：token 生效且 .dark 跟随 base", async ({ page }) => {
    expect(packs.length).toBeGreaterThanOrEqual(8);
    await installTauriMock(page);
    await page.addInitScript((all) => {
      const internals = (window as any).__TAURI_INTERNALS__;
      const orig = internals.invoke.bind(internals);
      internals.invoke = (cmd: string, args?: any) =>
        cmd === "themes_list" ? Promise.resolve({ packs: all, errors: [] }) : orig(cmd, args);
    }, packs);

    for (const pack of packs) {
      await page.addInitScript((id) => localStorage.setItem("rfm.themePack", id), pack.id);
      await page.goto("/");
      await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-theme", pack.id);
      // 包里的每个 token 都必须原样落到内联样式（未被 CSS.supports 丢弃）
      const applied = await html.evaluate((n, tokens) =>
        Object.keys(tokens).every(
          (k) => (n as HTMLElement).style.getPropertyValue(k).trim() !== "",
        ), pack.tokens);
      expect(applied, `${pack.id} 有 token 未生效`).toBe(true);
      if (pack.base === "dark") await expect(html).toHaveClass(/dark/);
      else await expect(html).not.toHaveClass(/dark/);
    }
  });
});
