import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  await expect(page.locator('[class*="z-[9999]"]')).toHaveCount(0);
});

test.describe("素/雅动画级别（v0.49 默认雅,隐藏开关仅 localStorage）", () => {
  // 套件断言真实动画帧（enter）,显式退出 playwright.config 的全局 reduced-motion 模拟
  test.use({ reducedMotion: "no-preference" });

  test("默认雅：data-anim=elegant，右键菜单弹层入场动画生效", async ({ page }) => {
    const anim = await page.evaluate(() => document.documentElement.dataset.anim);
    expect(anim).toBe("elegant");
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const content = page.locator('[data-slot="context-menu-content"]');
    await expect(content).toBeVisible();
    const animName = await content.evaluate((el) => getComputedStyle(el).animationName);
    expect(animName).toBe("enter");
  });

  test("素（紧急退路）：种 rfm.anim-level=plain → data-anim=plain + 弹层无动画", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("rfm.anim-level", "plain");
      } catch { /* ignore */ }
    });
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    const anim = await page.evaluate(() => document.documentElement.dataset.anim);
    expect(anim).toBe("plain");
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const content = page.locator('[data-slot="context-menu-content"]');
    await expect(content).toBeVisible();
    const animName = await content.evaluate((el) => getComputedStyle(el).animationName);
    expect(animName).toBe("none");
  });
});
