import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  await expect(page.locator('[class*="z-[9999]"]')).toHaveCount(0);
});

test.describe("素/雅动画级别（v0.49）", () => {
  test("默认素：data-anim=plain，右键菜单弹层无入场动画", async ({ page }) => {
    const anim = await page.evaluate(() => document.documentElement.dataset.anim);
    expect(anim).toBe("plain");
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const content = page.locator('[data-slot="context-menu-content"]');
    await expect(content).toBeVisible();
    const animName = await content.evaluate((el) => getComputedStyle(el).animationName);
    expect(animName).toBe("none");
  });

  test("雅：种 rfm.anim-level=elegant → data-anim=elegant + 菜单弹层入场动画生效", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("rfm.anim-level", "elegant");
      } catch { /* ignore */ }
    });
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    const anim = await page.evaluate(() => document.documentElement.dataset.anim);
    expect(anim).toBe("elegant");
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const content = page.locator('[data-slot="context-menu-content"]');
    await expect(content).toBeVisible();
    const animName = await content.evaluate((el) => getComputedStyle(el).animationName);
    expect(animName).toBe("enter");
    const dur = await content.evaluate((el) => getComputedStyle(el).animationDuration);
    expect(dur).toBe("0.15s");
  });
});
