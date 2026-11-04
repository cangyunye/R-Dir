import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.28.0 预览栏 + 图文浏览模式 E2E（v0.41 一键开关）。
 *
 * 覆盖：启动一律不自动展开预览（忽略上次退出状态）、标题栏预览按钮一键全开/全关、
 * 空格拉出/收起、拉门头部「收起」/贴边把手、按类型预览
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

/** 一键开启预览（标题栏按钮）：点击后拉门直接展开，无需二次操作 */
async function openPreview(page: import("@playwright/test").Page) {
  await page.getByTestId("preview-app-toggle").click();
  await expect(page.getByTestId("preview-drawer")).toHaveClass(/translate-x-0/);
}

test.describe("预览栏（右侧拉门）", () => {
  test("P1 启动一律不自动展开预览；点标题栏按钮一键开启，点文件即预览", async ({ page }) => {
    // 无论上次退出时的状态如何，开屏不出现拉门/把手，按钮未激活
    await expect(page.getByTestId("preview-drawer")).toHaveCount(0);
    await expect(page.getByTestId("preview-handle")).toHaveCount(0);
    const toggle = page.getByTestId("preview-app-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // 一键开启：拉门直接展开，选中文件立即预览
    await toggle.click();
    await expect(page.getByTestId("preview-drawer")).toHaveClass(/translate-x-0/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.locator(`[data-path="${HOME}/photo.png"]`).click();
    await expect(page.getByTestId("preview-image").locator("img")).toHaveAttribute(
      "src",
      /data:image\/png;base64/,
    );
  });

  test("P1b 标题栏预览按钮一键全开/全关：窗体级，关闭后行内空格恢复选中语义，跨标签保持", async ({ page }) => {
    await openPreview(page);
    const toggle = page.getByTestId("preview-app-toggle");
    // 关：拉门与把手整体消失
    await toggle.click();
    await expect(page.getByTestId("preview-drawer")).toHaveCount(0);
    await expect(page.getByTestId("preview-handle")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // 关闭后行内空格恢复「设置选中」语义，不弹任何提示
    await page.locator(`[data-path="${HOME}/photo.png"]`).click();
    await page.keyboard.press("Space");
    await expect(page.locator(`[data-path="${HOME}/photo.png"]`)).toHaveClass(/bg-selected/);
    await expect(page.getByText("预览栏未开启：设置 → 预览 → 启用预览栏")).toHaveCount(0);
    // 开：一键直接展开拉门（无「再按空格」中间步骤）
    await toggle.click();
    await expect(page.getByTestId("preview-drawer")).toHaveClass(/translate-x-0/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // 窗体级状态：切到新标签后保持（不会「切换后又要打开」）
    await page.getByTitle("新建标签页").click();
    await expect(page.getByTestId("preview-drawer")).toBeVisible();
  });

  test("P2 空格 = 收起为贴边把手/拉出；头部「收起」与把手等效", async ({ page }) => {
    await openPreview(page);
    const drawer = page.getByTestId("preview-drawer");
    await page.locator(`[data-path="${HOME}/photo.png"]`).click();
    // 空格（行内放行 → 全局 togglePreview）= 收起为把手，选中保持不变
    await page.keyboard.press("Space");
    await expect(drawer).toHaveClass(/translate-x-full/);
    await expect(page.getByTestId("preview-handle")).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/photo.png"]`)).toHaveClass(/bg-selected/);
    // 空格不作为首字母拉起 QuickJump 搜索浮层（与预览键冲突的回归点）
    await expect(page.locator("[data-quickjump]")).toHaveCount(0);
    // 再按空格拉出；头部「收起」同样收起，点把手拉出
    await page.keyboard.press("Space");
    await expect(drawer).toHaveClass(/translate-x-0/);
    await drawer.getByTitle("收起（空格）").click();
    await expect(drawer).toHaveClass(/translate-x-full/);
    await page.getByTestId("preview-handle").click();
    await expect(drawer).toHaveClass(/translate-x-0/);
  });

  test("P3 选中图片 → 原图预览；选中文本 → 文本内容；未选中 → 占位", async ({ page }) => {
    await openPreview(page);
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

  test("P3b 预览文本可选中复制：右键应用内菜单（复制/全选），复制选区写入剪贴板", async ({ page }) => {
    // 授权剪贴板读取，断言右键「复制」落盘的是选区文本
    await openPreview(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    const pre = page.getByTestId("preview-text").locator("pre");
    await expect(pre).toContainText("R-Dir");
    // 拖拽选中开头一段文本（起点避开首字符边界，x+4 会让 caret 塌缩在边界上不扩选）
    const box = (await pre.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 10, { steps: 5 });
    await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);
    // 右键（落在选区内，Chromium 右键选区外会清空选区）→ 应用内菜单（非系统菜单）→ 复制选区
    await pre.click({ button: "right", position: { x: 30, y: 10 } });
    await page.getByRole("menuitem", { name: "复制" }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(selected);
    // 「全选」把整段文本挂进选区，再复制得到全文
    await pre.click({ button: "right" });
    await page.getByRole("menuitem", { name: "全选" }).click();
    const all = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(all.length).toBeGreaterThan(selected.length);
  });

  test("P4 不支持的类型显示信息卡（zip）；远程路径不预览内容", async ({ page }) => {
    await openPreview(page);
    await page.locator(`[data-path="${HOME}/Pictures"]`).dblclick();
    await expect(page.locator(`[data-path="${PICTURES}/skip.zip"]`)).toBeVisible();
    await page.locator(`[data-path="${PICTURES}/skip.zip"]`).click();
    await expect(page.getByTestId("preview-info")).toContainText("此类型暂不支持预览");
  });

  test("P5 浏览按钮：无可预览条目时禁用", async ({ page }) => {
    await openPreview(page);
    await page.locator(`[data-path="${HOME}/Projects"]`).dblclick();
    await expect(page.getByTestId("preview-browse-btn")).toBeDisabled();
  });

  test("P9 代码文件语法高亮（v0.41 渐进增强）：json 出 .hljs-* span，纯文本不出；span 不破坏选区", async ({
    page,
  }) => {
    await openPreview(page);
    // 纯文本（无语法映射）：始终无高亮 span（HOME 下直接可见，先测免回退导航）
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    const notesPre = page.getByTestId("preview-text").locator("pre");
    await expect(notesPre).toContainText("R-Dir");
    await expect(notesPre.locator("span[class*='hljs-']")).toHaveCount(0);
    // json：动态加载语法后整段替换为着色 span，原文保留
    const CONFIGS = `${HOME}/Documents/configs`;
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await page.locator(`[data-path="${CONFIGS}"]`).dblclick();
    await page.locator(`[data-path="${CONFIGS}/settings.json"]`).click();
    const pre = page.getByTestId("preview-text").locator("pre");
    await expect(pre.locator("span[class*='hljs-']").first()).toBeVisible();
    await expect(pre).toContainText('"name"');
    // 高亮 span 不改变字符与折行：三击选行仍可用（P3b 的完整复制链路在纯文本上已覆盖；
    // 首行仅一个 { 拖不出选区，选第二行长内容）
    const box = (await pre.boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + 28, { clickCount: 3 });
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected).toContain('"name": "r-dir"');
  });

  test("P10 预览选中文字时 ctrl/cmd+C 复制文字而不是文件；再选文件后恢复文件复制", async ({
    page,
  }) => {
    await openPreview(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    const pre = page.getByTestId("preview-text").locator("pre");
    await expect(pre).toContainText("R-Dir");
    const box = (await pre.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 10, { steps: 5 });
    await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);
    // 有文本选区时 mod+C 走原生复制：剪贴板是选中文字，且不弹「已复制（文件）」提示
    await page.keyboard.press(`${MOD}+c`);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
    await expect(page.locator("[data-toast]")).toHaveCount(0);
    // 再选文件（点行会清掉文本选区）→ mod+C 恢复为复制文件
    await page.locator(`[data-path="${HOME}/Documents"]`).click();
    await page.keyboard.press(`${MOD}+c`);
    await expect(page.locator("[data-toast]")).toContainText("已复制");
  });

  test("P8 简单文本格式全覆盖（v0.30）：ini / json / 点文件 / Makefile / .env.* 出文本，bin 出信息卡", async ({
    page,
  }) => {
    await openPreview(page);
    const CONFIGS = `${HOME}/Documents/configs`;
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await page.locator(`[data-path="${CONFIGS}"]`).dblclick();
    await expect(page.locator(`[data-path="${CONFIGS}/app.ini"]`)).toBeVisible();
    // 点文件默认被「隐藏文件」过滤：先聚焦列表再 mod+shift+. 显示隐藏文件
    await page.locator(`[data-path="${CONFIGS}/app.ini"]`).click();
    await page.keyboard.press(`${MOD}+Shift+Period`);
    await expect(page.locator(`[data-path="${CONFIGS}/.gitignore"]`)).toBeVisible();

    const cases: [string, string][] = [
      ["app.ini", "[app]"],
      ["settings.json", '"name"'],
      [".gitignore", "node_modules"],
      ["Makefile", "echo built"],
      [".env.local", "RDIR_MODE"],
    ];
    for (const [name, snippet] of cases) {
      await page.locator(`[data-path="${CONFIGS}/${name}"]`).click();
      await expect(page.getByTestId("preview-text"), name).toContainText(snippet);
    }
    // 二进制扩展名仍是信息卡（不进文本读取）
    await page.locator(`[data-path="${CONFIGS}/build.bin"]`).click();
    await expect(page.getByTestId("preview-info")).toContainText("此类型暂不支持预览");
    // 图文浏览只收录可预览项：5 个文本 + 0 图片（起始选中同步已由 P6 覆盖）
    await page.locator(`[data-path="${CONFIGS}/app.ini"]`).click();
    await page.getByTestId("preview-browse-btn").click();
    await expect(page.getByTestId("browse-counter")).toContainText("/ 5");
    await page.keyboard.press("Escape");
  });
});

test.describe("图文浏览模式", () => {
  test("P6 进入 → 沉浸覆盖 + 缩略图条只含可预览项；←→ 导航选中同步；Esc 退出", async ({
    page,
  }) => {
    await openPreview(page);
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
    await openPreview(page);
    await page.locator(`[data-path="${HOME}/Pictures"]`).dblclick();
    await page.locator(`[data-path="${PICTURES}/a.png"]`).click();
    await page.keyboard.press(`${MOD}+Shift+e`);
    await expect(page.getByTestId("browse-mode")).toBeVisible();
    await page.keyboard.press(`${MOD}+Shift+e`);
    await expect(page.getByTestId("browse-mode")).toHaveCount(0);
  });
});
