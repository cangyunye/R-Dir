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
    // mock 预置了 v2=plain（行为门禁默认素）——置豁免旗标让种子跳过，reload 后
    // 走「无持久化=默认雅」的真实默认路径
    await page.evaluate(() => {
      sessionStorage.setItem("rdir-e2e-anim-unseeded", "1"); // 种子跳过
      localStorage.removeItem("rfm.anim-level-v2"); // 清掉首次加载时 mock 写入的值
    });
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    const seeded = await page.evaluate(() => localStorage.getItem("rfm.anim-level-v2"));
    expect(seeded).toBeNull(); // 种子确实被豁免，走真实默认
    const anim = await page.evaluate(() => document.documentElement.dataset.anim);
    expect(anim).toBe("elegant");
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const content = page.locator('[data-slot="context-menu-content"]');
    await expect(content).toBeVisible();
    const animName = await content.evaluate((el) => getComputedStyle(el).animationName);
    expect(animName).toBe("enter");
  });

  test("素（紧急退路）：种 rfm.anim-level-v2=plain → data-anim=plain + 弹层无动画", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem("rfm.anim-level-v2", "plain"));
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
