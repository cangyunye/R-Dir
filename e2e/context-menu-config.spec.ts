import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/**
 * v0.46 右键配置模块 + 快捷链接组：
 * - 「快捷链接」（创建快捷方式 / 发送到桌面）默认隐藏；
 * - 设置 → 右键菜单 打开后出现在文件右键，点「创建快捷方式」调用 create_shortcuts；
 * - 设置分区导航含「右键菜单」「系统集成」，系统集成开关可注册（mock 状态翻转）。
 */
test.describe("右键配置与快捷链接", () => {
  test("默认不显示快捷链接组；开关打开后可见并可创建快捷方式", async ({ page }) => {
    await installTauriMock(page);
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    // 默认：文件右键无「快捷链接」组
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText("快捷链接");
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();

    // 设置 → 右键菜单：打开「快捷链接」
    await page.getByTitle("设置（快捷键录制）").click();
    await page.getByRole("button", { name: "右键菜单" }).click();
    const quickLinksSwitch = page.getByRole("switch", { name: "快捷链接（创建快捷方式 / 发送到桌面）" });
    await expect(quickLinksSwitch).toBeVisible();
    await quickLinksSwitch.click();
    // 系统集成分区导航存在（点开看平台提示 + 开关 mock）
    await page.getByRole("button", { name: "系统集成" }).click();
    const shellSwitch = page.getByRole("switch", { name: "资源管理器右键「用 R-Dir 打开」" });
    await expect(shellSwitch).toBeVisible();
    await shellSwitch.click();
    // mock 注册后三处状态全 ✓
    await expect(page.getByText("✓ 目录 · ✓ 目录空白处 · ✓ 任意文件")).toBeVisible();
    await page.keyboard.press("Escape");

    // 右键出现「快捷链接」组；展开后点「创建快捷方式」
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await expect(menu).toBeVisible();
    await menu.getByText("快捷链接", { exact: true }).click();
    await menu.getByText("创建快捷方式").click();

    const calls = await page.evaluate(
      () =>
        (window as unknown as { __RDIR_E2E_MOCK__: { shortcutCalls: { paths: string[]; toDesktop: boolean }[] } })
          .__RDIR_E2E_MOCK__.shortcutCalls,
    );
    expect(calls).toEqual([{ paths: [`${HOME}/Notes.txt`], toDesktop: false }]);
    // 同级落盘（虚拟 FS）出现「Notes.txt 链接」
    await expect(page.locator(`[data-path="${HOME}/Notes.txt 链接"]`)).toBeVisible();
  });

  test("发送到桌面落 HOME/Desktop", async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      const cfg = JSON.stringify({ quickLinks: true });
      localStorage.setItem("rfm.menu-config", cfg);
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await menu.getByText("快捷链接", { exact: true }).click();
    await menu.getByText("发送到桌面").click();

    const calls = await page.evaluate(
      () =>
        (window as unknown as { __RDIR_E2E_MOCK__: { shortcutCalls: { paths: string[]; toDesktop: boolean }[] } })
          .__RDIR_E2E_MOCK__.shortcutCalls,
    );
    expect(calls).toEqual([{ paths: [`${HOME}/Notes.txt`], toDesktop: true }]);
    // 落盘到虚拟 FS 的 HOME/Desktop（当前视图在 HOME，不导航断言可见性）
    const desktop = await page.evaluate(
      (dir) =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { FS: Record<string, { name: string }[]> };
          }
        ).__RDIR_E2E_MOCK__.FS[dir],
      `${HOME}/Desktop`,
    );
    expect(desktop?.map((f) => f.name)).toContain("Notes.lnk");
  });

  test("菜单组可关：关闭「压缩为」后文件右键不再出现", async ({ page }) => {
    await installTauriMock(page);
    await page.addInitScript(() => {
      localStorage.setItem("rfm.menu-config", JSON.stringify({ compress: false }));
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText("压缩为");
    await expect(menu).toContainText("复制"); // 其他组不受影响
  });
});
