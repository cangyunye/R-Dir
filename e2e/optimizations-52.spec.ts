import { test, expect } from "@playwright/test";
import { disablePreview, installTauriMock } from "./tauri-mock";

/**
 * v0.52 批次回归（前端 dev server + Tauri IPC 桩）：
 * - S1 symlink 直接路径跳转：linux/mac 指向目录的符号链接 is_dir=false，
 *   双击经 statPath 探测分流应用内导航（此前落入「系统打开」无跳转）
 * - S2 无效路径回滚+报错：list_dir 统一导航接口对不存在路径按码产出
 *   NO_SUCH_PATH|详情（本地/SFTP/NFS 同契约），前端回滚路径栏并弹报错，
 *   不再「只变更路径栏、列表空白无提示」
 * - S3 sftp 无效路径回滚（scheme 输入无地址栏预检，直达 list 失败分支）
 * - S4 剪切粘贴后源目录窗格补刷（此前只刷目标窗格，源目录列表保持陈旧）
 */

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  await disablePreview(page);
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
});

test.describe("S1 symlink 直接路径跳转", () => {
  test("双击指向目录的符号链接 → 应用内进入目标目录（非系统打开）", async ({ page }) => {
    // 夹具镜像真实后端：link-to-docs is_dir=false + is_symlink=true（斜体）
    const link = page.locator(`[data-path="${HOME}/link-to-docs"]`);
    await expect(link).toBeVisible();
    await link.dblclick();
    // 应用内导航：列出的是链接目标（Documents）的内容
    await expect(page.locator(`[data-path="${HOME}/link-to-docs/readme.md"]`)).toBeVisible();
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${HOME}/link-to-docs`);
  });

  test("符号链接行保持斜体标记且排序不视作目录（夹具镜像真实后端）", async ({ page }) => {
    const link = page.locator(`[data-path="${HOME}/link-to-docs"] span`).first();
    await expect(link).toHaveClass(/italic/);
    // 目录（Documents）排在链接行之前
    const names = await page.locator("[data-path]").allInnerTexts();
    expect(names.findIndex((t) => t.includes("Documents"))).toBeLessThan(
      names.findIndex((t) => t.includes("link-to-docs")),
    );
  });
});

test.describe("S2 无效路径回滚 + 报错", () => {
  test("双击进入已被删除的目录 → 回滚到原目录 + 报错提示，列表不空白", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();
    // 目录在列出的瞬间被删（真实场景：外部删除/权限回收）；同步浏览夹具里
    // 保留父目录条目使其仍可通过双击发起导航
    await page.evaluate(() => {
      const mock = (window as unknown as { __RDIR_E2E_MOCK__: { FS: Record<string, unknown> } })
        .__RDIR_E2E_MOCK__;
      delete mock.FS["/mock/home/Documents/syncA"];
    });
    await page.locator(`[data-path="${HOME}/Documents/syncA"]`).dblclick();
    // 后端按码报错 → 前端回滚路径栏到上一有效目录
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${HOME}/Documents`);
    // 报错可见（状态栏通知，terr 剥码留详情）
    await expect(page.locator("[data-statusbar]")).toContainText("路径不存在");
    // 原目录列表保持可见（不是空白）
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();
    // 被删目录的行不残留 error 态（回滚后 error 清空，状态栏无红色错误行）
    await expect(page.locator("[data-statusbar]")).not.toContainText("NO_SUCH_PATH");
  });

  test("同路径刷新失败（目录消失后 F5）→ 原位报错，不误回滚", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();
    await page.evaluate(() => {
      const mock = (window as unknown as { __RDIR_E2E_MOCK__: { FS: Record<string, unknown> } })
        .__RDIR_E2E_MOCK__;
      delete mock.FS["/mock/home/Documents"];
    });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+r" : "F5");
    await expect(page.locator("[data-statusbar]")).toContainText("路径不存在");
    // 无回滚点差异（prev.path === 当前 path）：停留在原路径
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${HOME}/Documents`);
  });
});

test.describe("S3 sftp 无效路径回滚（scheme 输入无地址栏预检）", () => {
  test("连接后输入不存在的远程路径 → 回滚到原远程目录 + 报错", async ({ page }) => {
    test.slow();
    await page.keyboard.press(`${MOD}+Backslash`); // 左右分屏
    // 活动窗格一键重连生产机（mock 已存密码）
    await page.getByRole("button", { name: "生产机" }).click();
    const remote = "sftp://u@127.0.0.1:22/remote";
    await expect(page.locator(`[data-path="${remote}/deploy.sh"]`)).toBeVisible();
    // 输入不存在的远程路径（scheme 输入跳过地址栏 stat 预检 → 直达 list 失败）
    await page.locator("[data-pathbar-edit]").click();
    await page.locator("#rdir-addr-input").fill(`${remote}/ghost`);
    await page.locator("#rdir-addr-input").press("Enter");
    // 回滚到原远程目录 + 报错 + 列表不空白
    await expect(page.locator("#rdir-addr-input")).toHaveValue(remote);
    await expect(page.locator("[data-statusbar]")).toContainText("路径不存在");
    await expect(page.locator(`[data-path="${remote}/deploy.sh"]`)).toBeVisible();
  });
});

test.describe("S4 剪切粘贴后源目录窗格补刷", () => {
  test("左窗格剪切 → 右窗格粘贴：源目录（左）与目标（右）同步更新", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Backslash`); // 左右分屏
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(2);

    // 右窗格：条目点击激活窗格 → 地址栏导航到 Documents（粘贴目标）
    await page.locator(`[data-pane-id="2"] [data-path="${HOME}/Documents"]`).click();
    await page.locator("[data-pathbar-edit]").click();
    await page.locator("#rdir-addr-input").fill(`${HOME}/Documents`);
    await page.locator("#rdir-addr-input").press("Enter");
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();

    // 左窗格：点击 Notes.txt（激活 + 选中）后剪切
    await page.locator(`[data-pane-id="1"] [data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press(`${MOD}+x`);
    await expect(page.locator("[data-toast]")).toContainText("已剪切");

    // 右窗格激活后粘贴
    await page.locator(`[data-pane-id="2"] [data-path="${HOME}/Documents/readme.md"]`).click();
    await page.keyboard.press(`${MOD}+v`);
    await expect(
      page.locator(`[data-pane-id="2"] [data-path="${HOME}/Documents/Notes.txt"]`),
    ).toBeVisible();
    // 源目录窗格（左）立即不再显示已剪切的文件（修复点：此前保持陈旧列表）
    await expect(
      page.locator(`[data-pane-id="1"] [data-path="${HOME}/Notes.txt"]`),
    ).toHaveCount(0);
    // 左窗格其余条目正常
    await expect(page.locator(`[data-pane-id="1"] [data-path="${HOME}/photo.png"]`)).toBeVisible();
  });
});
