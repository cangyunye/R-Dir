import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 搜索结果拖拽（feat/search-drag）：搜索行左键拖动——拖到窗格/目录=复制、右下角
 * 垃圾箱=删除到回收站（可撤销）、Esc/右键/右上角取消区/空白=取消恢复面板；
 * 拖动期间搜索面板 invisible（不卸载），取消按键场景隔离（Esc 只取消拖拽不关面板）。
 *
 * addInitScript 预置 rdir.e2e.force-search-pointer-drag → 行 dragstart preventDefault
 * 走页内指针链（引擎 A 式窗口鼠标链，虚拟路径在真壳上的载体），真实鼠标序列覆盖全
 * 交互。注意：不能用 server-group-drag.spec 式的捕获层 killNativeDragstart——本会话
 * 以 dragstart 为唯一入口，过早 preventDefault 会让面板处理器 defaultPrevented 早退。
 * Windows 原生 OLE 路径（cancelOnRightButton）与 macOS HTML5 路径由真机冒烟 +
 * vitest 单测覆盖，浏览器 e2e 无法驱动原生 DoDragDrop。
 */

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  // 必须在应用脚本运行前预置：startSearchDrag 实时读 sessionStorage
  await page.addInitScript(() => {
    sessionStorage.setItem("rdir.e2e.force-search-pointer-drag", "1");
  });
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  // 等启动 splash（z-9999 fixed 覆盖层，1100ms 后卸载）消失——否则它吞掉 mousedown，
  // 拖拽链路整体不启动（回归用例不吃鼠标，早跑早过会假绿）
  await expect(page.locator('[class*="z-[9999]"]')).toHaveCount(0);
});

async function openSearch(page: Page, query: string) {
  await page.keyboard.press(`${MOD}+KeyF`);
  const input = page.getByPlaceholder("搜索当前层文件名…");
  await expect(input).toBeVisible();
  await input.fill(query);
  return input;
}

async function mockFs(page: Page): Promise<Record<string, { name: string }[]>> {
  return page.evaluate(
    () => (window as unknown as { __RDIR_E2E_MOCK__: { FS: Record<string, { name: string }[]> } }).__RDIR_E2E_MOCK__
      .FS,
  );
}

const row = (page: Page, path: string) => page.locator(`[data-search-path="${path}"]`);

test.describe("搜索结果拖拽（feat/search-drag）", () => {
  test("起拖：面板隐藏、取消区+垃圾箱出现、拖影跟随；悬停垃圾箱高亮", async ({ page }) => {
    await openSearch(page, "Notes");
    const src = row(page, `${HOME}/Notes.txt`);
    await expect(src).toBeVisible();
    const rb = (await src.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width / 2 - 60, rb.y + rb.height / 2 + 40, { steps: 6 });

    // 面板隐藏（invisible 不卸载）、会话 UI 出现
    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeHidden();
    await expect(page.locator('[data-search-drop="cancel"]')).toBeVisible();
    await expect(page.locator('[data-search-drop="trash"]')).toBeVisible();
    // 指针链跟手拖影
    await expect(page.locator("[data-search-drag-ghost]")).toContainText("Notes.txt");
    await expect
      .poll(() => page.locator("[data-search-drag-ghost]").evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");

    // 悬停垃圾箱：红色高亮 + 「松开删除」提示（指针链本地悬停通报）
    const tb = (await page.locator('[data-search-drop="trash"]').boundingBox())!;
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
    await expect(page.locator('[data-search-drop="trash"]')).toContainText("松开删除");
    await expect(page.locator('[data-search-drop="trash"]')).toHaveClass(/border-destructive/);

    await page.mouse.up();
    // 垃圾箱删除：虚拟 FS 移除 + 面板恢复 + 结果行乐观移除
    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeVisible();
    await expect(row(page, `${HOME}/Notes.txt`)).toHaveCount(0);
    await expect
      .poll(async () => ((await mockFs(page))[HOME] ?? []).some((f) => f.name === "Notes.txt"))
      .toBe(false);
  });

  test("拖到目录行 = 复制进该目录（transferPaths 管线），面板恢复", async ({ page }) => {
    await openSearch(page, "Notes");
    const src = row(page, `${HOME}/Notes.txt`);
    await expect(src).toBeVisible();
    // 面板背后的窗格 Documents 目录行（面板拖动中 invisible，elementFromPoint 可命中）
    const target = page.locator(`[data-drop-dir][data-path="${HOME}/Documents"]`);
    const sb = (await src.boundingBox())!;
    const tb = (await target.boundingBox())!;

    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
    await page.mouse.up();

    // 面板恢复 + 复制落地（copy_entries_plan 写入虚拟 FS）
    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeVisible();
    await expect
      .poll(async () => ((await mockFs(page))[`${HOME}/Documents`] ?? []).some((f) => f.name === "Notes.txt"))
      .toBe(true);
    // 源文件仍在（复制语义）
    expect(((await mockFs(page))[HOME] ?? []).some((f) => f.name === "Notes.txt")).toBe(true);
  });

  test("拖动中 Esc = 取消：面板恢复、FS 不变、Esc 不关搜索面板", async ({ page }) => {
    await openSearch(page, "Notes");
    const src = row(page, `${HOME}/Notes.txt`);
    const rb = (await src.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x - 120, rb.y + 80, { steps: 5 });
    await expect(page.locator('[data-search-drop="cancel"]')).toBeVisible();

    await page.keyboard.press("Escape");

    // 取消而非关面板：输入框（面板）仍在，会话 UI 消失，FS 无变化
    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeVisible();
    await expect(page.locator('[data-search-drop="cancel"]')).toHaveCount(0);
    await expect(page.locator('[data-search-drop="trash"]')).toHaveCount(0);
    await expect(row(page, `${HOME}/Notes.txt`)).toBeVisible();
    expect(((await mockFs(page))[HOME] ?? []).some((f) => f.name === "Notes.txt")).toBe(true);

    // 会话外 Esc 恢复关面板（取消按键的场景隔离：只作用于拖拽）
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeHidden();
  });

  test("拖动中右键 = 取消（preventDefault 不弹菜单），面板恢复", async ({ page }) => {
    await openSearch(page, "Notes");
    const src = row(page, `${HOME}/Notes.txt`);
    const rb = (await src.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x - 100, rb.y + 60, { steps: 5 });
    await expect(page.locator('[data-search-drop="cancel"]')).toBeVisible();

    // 左键按住期间按下并松开右键 → contextmenu 被捕获吞掉 → 取消拖拽
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.mouse.up({ button: "left" }); // 松开左键（已取消，无投放）

    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeVisible();
    await expect(page.locator('[data-search-drop="cancel"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(0);
    expect(((await mockFs(page))[HOME] ?? []).some((f) => f.name === "Notes.txt")).toBe(true);
  });

  test("拖到右上角取消区 = 取消恢复面板", async ({ page }) => {
    await openSearch(page, "Notes");
    const src = row(page, `${HOME}/Notes.txt`);
    const rb = (await src.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    // 先移一小段起拖（dragstart 触发后取消区才出现），再取取消区位置拖过去
    await page.mouse.move(rb.x + rb.width / 2 - 40, rb.y + rb.height / 2 - 30, { steps: 4 });
    const cb = (await page.locator('[data-search-drop="cancel"]').boundingBox())!;
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 8 });
    await expect(page.locator('[data-search-drop="cancel"]')).toContainText("松开取消");
    await page.mouse.up();

    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeVisible();
    await expect(page.locator('[data-search-drop="cancel"]')).toHaveCount(0);
    expect(((await mockFs(page))[HOME] ?? []).some((f) => f.name === "Notes.txt")).toBe(true);
  });

  test("拖到空白处松手 = 无目标取消，恢复面板", async ({ page }) => {
    await openSearch(page, "Notes");
    const src = row(page, `${HOME}/Notes.txt`);
    const rb = (await src.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    // 窗口左上空白区（标题栏下方、无窗格无 zone；面板 invisible 不挡命中）
    await page.mouse.move(60, 60, { steps: 8 });
    await page.mouse.up();

    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeVisible();
    await expect(page.locator('[data-search-drop="cancel"]')).toHaveCount(0);
    expect(((await mockFs(page))[HOME] ?? []).some((f) => f.name === "Notes.txt")).toBe(true);
  });

  test("回归：单击选中 / 双击打开 / 右键菜单不受拖拽改造影响", async ({ page }) => {
    await openSearch(page, "Notes");
    const src = row(page, `${HOME}/Notes.txt`);
    await expect(src).toBeVisible();

    // 单击选中（bg-selected）
    await src.click();
    await expect(src).toHaveClass(/bg-selected/);

    // 右键菜单照常
    await src.click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");

    // 双击打开（系统关联程序）
    await src.dblclick();
    const opened = await page.evaluate(
      () => (window as unknown as { __RDIR_E2E_MOCK__: { opened: string[] } }).__RDIR_E2E_MOCK__.opened,
    );
    expect(opened).toContain(`${HOME}/Notes.txt`);
  });
});
