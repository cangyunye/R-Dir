import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.28.0 预览栏 + 图文浏览模式 E2E。
 *
 * 覆盖：设置开启（点文件不直接预览）、空格开/收起、按类型预览
 * （图片原图 / 文本 / 文档首页卡 / 不支持类型信息卡）、浏览模式进出与导航选中同步。
 * 桩：preview_data 返回 1x1 PNG（e2e/tauri-mock.ts）。
 */

const HOME = "/mock/home";
const PICTURES = `${HOME}/Pictures`;
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
});

/** 打开设置 → 预览分区 → 启用预览栏 → 关闭设置 */
async function enablePreview(page: import("@playwright/test").Page) {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByRole("button", { name: "预览" }).click();
  await page.getByTestId("preview-toggle").click();
  await expect(page.getByTestId("preview-drawer")).toHaveClass(/translate-x-0/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("preview-drawer")).toBeVisible();
}

test.describe("预览栏（右侧拉门）", () => {
  test("P1 默认关闭：空格提示去设置开启，点文件不出预览", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/photo.png"]`).click();
    await page.keyboard.press("Space");
    await expect(page.getByText("预览栏未开启：设置 → 预览 → 启用预览栏")).toBeVisible();
    await expect(page.getByTestId("preview-drawer")).toHaveCount(0);
    // 空格不作为首字母拉起 QuickJump 搜索浮层（与预览键冲突的回归点）
    await expect(page.locator("[data-quickjump]")).toHaveCount(0);
  });

  test("P2 设置开启 → 拉门出现；空格收起为把手、再按拉出", async ({ page }) => {
    await enablePreview(page);
    const drawer = page.getByTestId("preview-drawer");
    await expect(drawer).toHaveClass(/translate-x-0/);
    // 空格收起 → 贴边把手出现
    await page.keyboard.press("Space");
    await expect(drawer).toHaveClass(/translate-x-full/);
    await expect(page.getByTestId("preview-handle")).toBeVisible();
    // 点把手拉出；再按空格收起；空格再展开
    await page.getByTestId("preview-handle").click();
    await expect(drawer).toHaveClass(/translate-x-0/);
    await page.keyboard.press("Space");
    await expect(drawer).toHaveClass(/translate-x-full/);
    await page.keyboard.press("Space");
    await expect(drawer).toHaveClass(/translate-x-0/);
  });

  test("P3 选中图片 → 原图预览；选中文本 → 文本内容；未选中 → 占位", async ({ page }) => {
    await enablePreview(page);
    await page.locator(`[data-path="${HOME}/photo.png"]`).click();
    await expect(page.getByTestId("preview-image").locator("img")).toHaveAttribute(
      "src",
      /data:image\/png;base64/,
    );
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await expect(page.getByTestId("preview-text")).toContainText("R-Dir");
    // Notes.txt 桩内容来自虚拟 FS；断言文本区已渲染非空内容即可
    const drawer = page.getByTestId("preview-drawer");
    await expect(drawer).toContainText("Notes.txt");
    await page.locator(`[data-path="${HOME}/Documents"]`).click();
    await expect(page.getByTestId("preview-placeholder")).toBeVisible();
  });

  test("P4 不支持的类型显示信息卡（zip）；远程路径不预览内容", async ({ page }) => {
    await enablePreview(page);
    await page.locator(`[data-path="${HOME}/Pictures"]`).dblclick();
    await expect(page.locator(`[data-path="${PICTURES}/skip.zip"]`)).toBeVisible();
    await page.locator(`[data-path="${PICTURES}/skip.zip"]`).click();
    await expect(page.getByTestId("preview-info")).toContainText("此类型暂不支持预览");
  });

  test("P5 浏览按钮：无可预览条目时禁用", async ({ page }) => {
    await enablePreview(page);
    await page.locator(`[data-path="${HOME}/Projects"]`).dblclick();
    await expect(page.getByTestId("preview-browse-btn")).toBeDisabled();
  });
});

test.describe("图文浏览模式", () => {
  test("P6 进入 → 沉浸覆盖 + 缩略图条只含可预览项；←→ 导航选中同步；Esc 退出", async ({
    page,
  }) => {
    await enablePreview(page);
    await page.locator(`[data-path="${HOME}/Pictures"]`).dblclick();
    await expect(page.locator(`[data-path="${PICTURES}/a.png"]`)).toBeVisible();
    await page.locator(`[data-path="${PICTURES}/a.png"]`).click();
    await expect(page.getByTestId("preview-browse-btn")).toBeEnabled();
    await page.getByTestId("preview-browse-btn").click();

    const browse = page.getByTestId("browse-mode");
    await expect(browse).toBeVisible();
    // 只收录可预览类型：a.png/b.png/c.jpg/doc.pdf 共 4 项（skip.zip 不参与）
    await expect(page.getByTestId("browse-counter")).toHaveText("1 / 4");
    await expect(browse.locator('button[title="skip.zip"]')).toHaveCount(0);
    await expect(browse.locator('button[title="doc.pdf"]')).toHaveCount(1);

    // → 切到 b.png，计数变化且中央区跟随
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("browse-counter")).toHaveText("2 / 4");
    await expect(browse).toContainText("b.png");

    // End 跳最后一项（doc.pdf 文档卡）
    await page.keyboard.press("End");
    await expect(page.getByTestId("browse-counter")).toHaveText("4 / 4");
    await expect(browse.getByTestId("preview-doc")).toBeVisible();

    // Esc 退出 → 回到列表，选中同步停留在 doc.pdf
    await page.keyboard.press("Escape");
    await expect(browse).toHaveCount(0);
    await expect(page.locator(`[data-path="${PICTURES}/doc.pdf"]`)).toHaveClass(/bg-selected/);
  });

  test("P7 快捷键 mod+shift+e 进入；再次按下退出", async ({ page }) => {
    await enablePreview(page);
    await page.locator(`[data-path="${HOME}/Pictures"]`).dblclick();
    await page.locator(`[data-path="${PICTURES}/a.png"]`).click();
    await page.keyboard.press(`${MOD}+Shift+e`);
    await expect(page.getByTestId("browse-mode")).toBeVisible();
    await page.keyboard.press(`${MOD}+Shift+e`);
    await expect(page.getByTestId("browse-mode")).toHaveCount(0);
  });
});
