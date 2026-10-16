import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

/** 空白处右键菜单回归：顶部常用工具条（与条目右键同款）+ 终端组 Git Bash */
test("空白处菜单顶部为常用工具条：点工具即作用于当前目录", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

  // 右键详情列表空白处
  const body = page.locator("[data-filelist-body]");
  const box = (await body.boundingBox())!;
  await body.click({ button: "right", position: { x: 120, y: box.height - 14 } });

  const menu = page.locator('[data-slot="context-menu-content"]');
  await expect(menu).toBeVisible();

  // 常用工具条（条目右键同款）：VSCode / Zed 磁贴 + ＋ 配置入口
  const vsTile = menu.locator('[title="用 Visual Studio Code 打开"]');
  await expect(vsTile).toBeVisible();
  await expect(menu.locator('[title="用 Zed 打开"]')).toBeVisible();
  await expect(menu.locator('[title="配置常用工具…"]')).toBeVisible();

  await page.screenshot({ path: "e2e-shots/blank-menu-quicktools.png" });

  // 点 VSCode 磁贴 → 以当前目录为路径调用 open_quick_tool
  await vsTile.click();
  const opened = await page.evaluate(
    () => (window as unknown as { __RDIR_E2E_MOCK__: { opened: string[] } }).__RDIR_E2E_MOCK__.opened,
  );
  expect(opened).toContain(HOME);

  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
});

test.describe("空白处终端组 Git Bash", () => {
  test("终端折叠组展开后含 Git Bash，点击调用 open_git_tool（当前目录）", async ({ page }) => {
    await page.addInitScript(() => {
      (
        window as unknown as { __rdirGitTools?: () => unknown[] }
      ).__rdirGitTools = () => [
        { id: "gitbash", name: "Git Bash", detected: true, path: "C:\\Program Files\\Git\\git-bash.exe" },
      ];
    });
    await installTauriMock(page);
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    const body = page.locator("[data-filelist-body]");
    const box = (await body.boundingBox())!;
    await body.click({ button: "right", position: { x: 120, y: box.height - 14 } });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();

    // 展开「在此处打开终端」折叠组
    await menu.getByText("在此处打开终端").click();
    await expect(menu).toContainText("Git Bash");

    await page.screenshot({ path: "e2e-shots/blank-menu-gitbash.png" });
  });
});
