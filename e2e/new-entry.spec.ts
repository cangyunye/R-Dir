import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 新建文件/文件夹三项回归（v0.42）：
 * 1) 行右键菜单同样提供「新建文件夹 / 新建文本文件」——长列表铺满视口后右键不到空白；
 * 2) 连续新建自动编号：第二个文件夹默认名「新建文件夹 (2)」而不是报「已存在」；
 * 3) 长列表（list_dir 有真实 IPC 延迟）下新建后立即进入行内重命名——
 *    乐观插入不等刷新完成，重命名会话不被延迟到达的刷新/焦点竞争杀掉。
 */

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
});

/** 右键列表空白处（底部区域，避开条目行） */
async function rightClickBlank(page: Page) {
  const body = page.locator("[data-filelist-body]");
  const box = (await body.boundingBox())!;
  await body.click({ button: "right", position: { x: 120, y: box.height - 14 } });
}

test("行右键菜单提供「新建文件夹」，创建后直接进入重命名并可改名", async ({ page }) => {
  // 右键一条已有条目（长列表体感：任何右键都落在行上）
  await page.locator(`[data-path="${HOME}/Documents"]`).click({ button: "right" });
  const menu = page.locator('[data-slot="context-menu-content"]');
  await menu.getByText("新建文件夹").click();

  const created = page.locator(`[data-path="${HOME}/新建文件夹"]`);
  await expect(created).toBeVisible();
  const input = created.locator("input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(400);
  await expect(input).toBeFocused();
  await page.keyboard.type("ProjectB");
  await input.press("Enter");
  await expect(page.locator(`[data-path="${HOME}/ProjectB"]`)).toBeVisible();
  await expect(created).toHaveCount(0);
});

test("连续新建两个文件夹：第二个默认名自动顺延「新建文件夹 (2)」", async ({ page }) => {
  await rightClickBlank(page);
  let menu = page.locator('[data-slot="context-menu-content"]');
  await menu.getByText("新建文件夹").click();
  const first = page.locator(`[data-path="${HOME}/新建文件夹"]`);
  await expect(first).toBeVisible();
  // Esc 保留默认名（未改名）
  await page.keyboard.press("Escape");
  await expect(first.locator("input")).toHaveCount(0);

  await rightClickBlank(page);
  menu = page.locator('[data-slot="context-menu-content"]');
  await menu.getByText("新建文件夹").click();
  // 第二个不报「已存在」，默认名顺延 (2) 并直接进入重命名
  const second = page.locator(`[data-path="${HOME}/新建文件夹 (2)"]`);
  await expect(second).toBeVisible();
  await expect(second.locator("input")).toBeVisible();
  await page.keyboard.type("两点十八");
  await page.locator(`[data-path="${HOME}/新建文件夹 (2)"] input`).press("Enter");
  await expect(page.locator(`[data-path="${HOME}/两点十八"]`)).toBeVisible();
  await expect(first).toBeVisible();
});

test("长列表 list_dir 延迟下新建文件夹立即进入重命名（乐观插入，不等刷新）", async ({ page }) => {
  // beforeEach 已装 IPC 桩；补一条 init 脚本注入延迟（下次导航生效），再重新加载
  await page.addInitScript((d) => {
    (window as unknown as Record<string, unknown>).__RDIR_IPC_DELAY__ = d;
  }, { list_dir: 500 });
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();

  await rightClickBlank(page);
  await page
    .locator('[data-slot="context-menu-content"]')
    .getByText("新建文件夹")
    .click();

  // list_dir 延迟 500ms：输入框必须先于刷新结果出现（乐观插入）
  const created = page.locator(`[data-path="${HOME}/新建文件夹"]`);
  await expect(created).toBeVisible({ timeout: 300 });
  const input = created.locator("input");
  await expect(input).toBeVisible({ timeout: 300 });
  // 刷新仍在飞行中：已填充的本地窗格快速重读不点亮「正在加载…」横条（闪一次的来源）
  await page.waitForTimeout(300);
  await expect(page.getByText("正在加载")).toHaveCount(0);
  // 刷新落地的整表替换不杀会话：直接键入新名（此时刷新尚未完成也成立）
  await page.keyboard.type("慢列表也能改");
  // 等延迟刷新落地后提交（焦点仍在输入框上）
  await page.waitForTimeout(700);
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(page.locator(`[data-path="${HOME}/慢列表也能改"]`)).toBeVisible();
  await expect(created).toHaveCount(0);
});
