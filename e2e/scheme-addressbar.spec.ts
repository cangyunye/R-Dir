import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.39 地址栏 scheme 输入回归：smb://、nfs:// 此前未进 Toolbar 提交的 scheme
 * 白名单（只有 sftp/http/tags），输入被 resolvePath 当相对路径拼进当前目录
 * 且 // 被归一成 \（用户实测截图：`F:\…\smb:\172.20.214.44`）。
 * 修复后 scheme 输入直通导航；mock 后端对未知虚拟路径抛 `ENOENT: <原始路径>`，
 * 状态栏错误文本保留 scheme 原样即证明未被拼接。
 */
test.describe("地址栏 scheme 输入（v0.39 回归）", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.goto("/");
    await expect(page.locator("[data-path]").first()).toBeVisible();
  });

  async function typeAddress(page: import("@playwright/test").Page, text: string) {
    await page.locator("[data-pathbar-edit]").first().click();
    const addr = page.locator("#rdir-addr-input");
    await addr.fill(text);
    await addr.press("Enter");
  }

  test("smb:// 输入不被拼进当前目录", async ({ page }) => {
    await typeAddress(page, "smb://172.20.214.44");
    const bar = page.locator("[data-statusbar]");
    await expect(bar.getByText(/smb:\/\/172\.20\.214\.44/)).toBeVisible();
    // 反向断言：拼接后的坏路径形态（smb:\）绝不可见
    await expect(page.getByText(/smb:\\/)).toHaveCount(0);
  });

  test("nfs:// 输入不被拼进当前目录", async ({ page }) => {
    await typeAddress(page, "nfs://192.0.2.1/srv/nfs");
    const bar = page.locator("[data-statusbar]");
    await expect(bar.getByText(/nfs:\/\/192\.0\.2\.1\/srv\/nfs/)).toBeVisible();
    await expect(page.getByText(/nfs:\\/)).toHaveCount(0);
  });
});
