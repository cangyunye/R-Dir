import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

test.describe("主题颜色模式（浅色/深色/跟随系统）", () => {
  test("system 模式随系统深浅色实时切换 html.dark", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("rfm.theme", "system"));
    await installTauriMock(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);

    // 系统切到浅色 → 应用实时跟随（不重载）
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    // 再切回深色 → 跟随
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("显式 light 不随系统变化", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("rfm.theme", "light"));
    await installTauriMock(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("设置 → 外观：点「跟随系统」即写回 rfm.theme=system 并立即生效", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("rfm.theme", "light"));
    await installTauriMock(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    // 打开设置 → 外观分区（对话框无 role=dialog，按文本确认打开）
    await page.getByTitle("设置（快捷键录制）").click();
    await expect(page.getByText("更改会自动保存")).toBeVisible();
    await page.getByRole("button", { name: "外观", exact: true }).click();

    // 当前浅色高亮；点「跟随系统」→ 立即变暗 + localStorage 写回
    await expect(page.getByRole("button", { name: /浅色/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: /跟随系统/ }).click();
    await expect(page.getByRole("button", { name: /跟随系统/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem("rfm.theme"))).toBe("system");

    // 等按钮 transition-colors（150ms）播完再截图，避免拍在配色过渡中段
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e-shots/settings-theme-mode.png" });
  });
});
