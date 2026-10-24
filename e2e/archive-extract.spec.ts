import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.32.0 解压回归（右键压缩包直接解压）：
 * 1) 「解压」折叠组仅对可解压的压缩包出现（裸 .xz 例外——后端暂不支持）；
 * 2) 三个落点项触发 extract_archive 的 mode 参数正确（smart / folder / choose）；
 * 3) 加密包：未提供密码 → 后端「需要密码」→ 弹密码框 → 提交后就地重试成功；
 * 4) 解压失败 → 状态栏可见错误。
 * 后端 extract_archive 由 tauri-mock 桩化（记录调用 + __rdirExtract 注入行为），
 * 真实解压链路由 Rust 单测覆盖（zip_encrypted_password_flow 等）。
 * 夹具目录 /mock/archives 独立于家目录（smoke 固定断言家目录 6 项）。
 */

const HOME = "/mock/home";
const ARCHIVES = "/mock/archives";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
});

/** 地址栏导航到解压夹具目录（路径栏默认按钮态，先点编辑进入输入态） */
async function gotoArchives(page: Page) {
  await page.locator("[data-pathbar-edit]").first().click();
  const addr = page.locator("#rdir-addr-input");
  await addr.fill(ARCHIVES);
  await addr.press("Enter");
  await expect(page.locator(`[data-path="${ARCHIVES}/sample.zip"]`)).toBeVisible();
}

/** 右键条目并返回「当前打开」的菜单容器（连续开关时旧内容仍在退出动画，取最新） */
async function openEntryMenu(page: Page, path: string) {
  await page.locator(`[data-path="${path}"]`).click({ button: "right" });
  return page.locator('[data-slot="context-menu-content"]').last();
}

/** 展开压缩包条目的「解压」组 */
async function expandExtractGroup(page: Page, path: string) {
  const menu = await openEntryMenu(page, path);
  await menu.getByText("解压", { exact: true }).click();
  return menu;
}

async function extractCalls(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __RDIR_E2E_MOCK__: { extractCalls: Record<string, string>[] } })
        .__RDIR_E2E_MOCK__.extractCalls,
  );
}

test.describe("32A. 解压菜单资格", () => {
  test("压缩包行显示解压组（zip / tar.gz / 7z），裸 xz 不显示", async ({ page }) => {
    await gotoArchives(page);
    for (const name of ["sample.zip", "backup.tar.gz", "legacy.7z"]) {
      const menu = await openEntryMenu(page, `${ARCHIVES}/${name}`);
      await expect(menu.getByText("解压", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
    // 裸 xz 例外：归档图标但不可解压（后端暂不支持）
    const menu = await openEntryMenu(page, `${ARCHIVES}/bare.xz`);
    await expect(menu.getByText("解压", { exact: true })).toHaveCount(0);
  });

  test("非压缩包（家目录默认页）不显示解压组", async ({ page }) => {
    for (const name of ["Notes.txt", "photo.png"]) {
      const menu = await openEntryMenu(page, `${HOME}/${name}`);
      await expect(menu.getByText("解压", { exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
  });

  test("展开后含三个落点项，归档名取自文件名（去末段扩展）", async ({ page }) => {
    await gotoArchives(page);
    const menu = await expandExtractGroup(page, `${ARCHIVES}/backup.tar.gz`);
    await expect(menu.getByText("解压到此处")).toBeVisible();
    await expect(menu.getByText("解压到 backup.tar/")).toBeVisible();
    await expect(menu.getByText("解压到…")).toBeVisible();
  });
});

test.describe("32B. 三种落点", () => {
  test("解压到此处 → mode=smart，targetDir=当前目录", async ({ page }) => {
    await gotoArchives(page);
    await gotoArchives(page);
    const menu = await expandExtractGroup(page, `${ARCHIVES}/sample.zip`);
    await menu.getByText("解压到此处").click();
    await expect(page.getByText("已解压到 sample（3 项）")).toBeVisible();
    expect(await extractCalls(page)).toHaveLength(1);
    const last = (await extractCalls(page)).at(-1)!;
    expect(last).toMatchObject({
      path: `${ARCHIVES}/sample.zip`,
      targetDir: ARCHIVES,
      mode: "smart",
      password: null,
    });
  });

  test("解压到 归档名/ → mode=folder", async ({ page }) => {
    await gotoArchives(page);
    await gotoArchives(page);
    const menu = await expandExtractGroup(page, `${ARCHIVES}/sample.zip`);
    await menu.getByText("解压到 sample/").click();
    const last = (await extractCalls(page)).at(-1)!;
    expect(last).toMatchObject({
      path: `${ARCHIVES}/sample.zip`,
      targetDir: ARCHIVES,
      mode: "folder",
    });
  });

  test("解压到… → 目录选择后 mode=smart、targetDir=所选目录", async ({ page }) => {
    await page.evaluate(() => {
      (
        window as unknown as { __rdirDialogOpen?: string | null }
      ).__rdirDialogOpen = "/mock/home/Documents";
    });
    await gotoArchives(page);
    const menu = await expandExtractGroup(page, `${ARCHIVES}/sample.zip`);
    await menu.getByText("解压到…").click();
    // 提示的落点 = 新建的文件夹名（<所选目录>/sample/），不是所选目录本身
    await expect(page.getByText("已解压到 sample（3 项）")).toBeVisible();
    const last = (await extractCalls(page)).at(-1)!;
    expect(last).toMatchObject({
      path: `${ARCHIVES}/sample.zip`,
      targetDir: "/mock/home/Documents",
      mode: "smart",
    });
  });
});

test.describe("32C. 加密包与失败", () => {
  test("需要密码 → 弹密码框 → 提交后就地重试成功", async ({ page }) => {
    await page.evaluate(() => {
      let n = 0;
      (
        window as unknown as { __rdirExtract?: () => string | undefined }
      ).__rdirExtract = () => (n++ === 0 ? "需要密码" : undefined);
    });
    await gotoArchives(page);
    const menu = await expandExtractGroup(page, `${ARCHIVES}/sample.zip`);
    await menu.getByText("解压到此处").click();
    // 密码框出现（后端返回「需要密码」）
    const dialog = page.locator("[data-password-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator("input[type=password]").fill("pw123");
    await dialog.getByRole("button", { name: "解压", exact: true }).click();
    // 第二次调用带密码且成功 → 框关闭 + 成功提示
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("已解压到 sample（3 项）")).toBeVisible();
    const calls = await extractCalls(page);
    expect(calls).toHaveLength(2);
    expect(calls[0].password).toBeNull();
    expect(calls[1].password).toBe("pw123");
  });

  test("密码错误 → 框内提示可重试，取消则中止", async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { __rdirExtract?: () => string | undefined }).__rdirExtract =
        () => "密码错误";
    });
    await gotoArchives(page);
    const menu = await expandExtractGroup(page, `${ARCHIVES}/sample.zip`);
    await menu.getByText("解压到此处").click();
    const dialog = page.locator("[data-password-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator("input[type=password]").fill("wrong");
    await dialog.getByRole("button", { name: "解压", exact: true }).click();
    // 错误显示在框内，框保持打开
    await expect(dialog.getByText("密码不正确，请重试")).toBeVisible();
    await expect(dialog).toBeVisible();
    // 取消 → 框关闭，不再调用
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await extractCalls(page)).toHaveLength(2);
  });

  test("解压失败 → 错误可见（状态栏留底）", async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { __rdirExtract?: () => string | undefined }).__rdirExtract =
        () => "boom: archive corrupted";
    });
    await gotoArchives(page);
    const menu = await expandExtractGroup(page, `${ARCHIVES}/sample.zip`);
    await menu.getByText("解压到此处").click();
    await expect(page.getByText(/boom: archive corrupted/).first()).toBeVisible();
  });
});
