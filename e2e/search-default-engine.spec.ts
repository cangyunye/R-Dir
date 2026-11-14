import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.48 Ctrl+F 默认检索引擎跟随全盘索引插件开关：
 * 插件启用 → 「文件名」tab 默认点亮「全盘」灯钮（状态行「全盘索引中 / 范围：全部索引卷」）；
 * 插件关闭（mock 默认态，与真实后端默认一致）→ 维持「当前层匹配」。
 * mock 注入：addInitScript 设 __RDIR_MOCK_PLUGINS__.{id}=bool（tauri-mock list_plugins 读取）。
 */

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const IDX_CHIP = 'button[title^="全盘索引检索"]';

async function boot(page: Page, plugins?: Record<string, boolean>) {
  await installTauriMock(page);
  if (plugins) {
    await page.addInitScript((kv) => {
      (window as unknown as { __RDIR_MOCK_PLUGINS__?: Record<string, boolean> }).__RDIR_MOCK_PLUGINS__ =
        kv;
    }, plugins);
  }
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
}

test.describe("Ctrl+F 默认检索引擎（v0.48）", () => {
  test("索引插件未启用：默认当前层匹配", async ({ page }) => {
    await boot(page);
    await page.keyboard.press(`${MOD}+KeyF`);
    await expect(page.locator(IDX_CHIP)).toBeVisible();
    await expect(page.locator(IDX_CHIP)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("当前层匹配")).toBeVisible();
  });

  test("索引插件启用：默认全盘索引引擎（含索引卷范围标注）", async ({ page }) => {
    await boot(page, { "index-search": true });
    await page.keyboard.press(`${MOD}+KeyF`);
    await expect(page.locator(IDX_CHIP)).toBeVisible();
    await expect(page.locator(IDX_CHIP)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("全盘索引中")).toBeVisible();
    await expect(page.getByText("范围：全部索引卷")).toBeVisible();
    // 状态行互斥标注：不应出现「当前层匹配」
    await expect(page.getByText("当前层匹配")).toHaveCount(0);
  });

  test("默认全盘引擎下输入关键词：走 index_search 引擎出结果", async ({ page }) => {
    await boot(page, { "index-search": true });
    await page.keyboard.press(`${MOD}+KeyF`);
    await expect(page.locator(IDX_CHIP)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.type("Notes");
    await expect(page.locator('[data-search-path="/mock/home/Notes.txt"]').first()).toBeVisible();
  });
});
