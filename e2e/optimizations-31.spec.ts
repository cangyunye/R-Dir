import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.31.0 优化项回归：
 * 1) 标签视图条目（文件夹/文件）右键重命名本体，改名后标签跟随；
 * 2) 服务器清单导出/导入（导入含密文时必须输入导出方主密码）；
 * 3) 远程文件双击打开（下载到确定性临时目录）+ 清理远程临时文件；
 * 4) 新建文件/文件夹后直接进入行内重命名。
 */

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
});

/** 中央轻提示（导出/导入/清理成功反馈） */
function toast(page: Page) {
  return page.locator("[data-toast]");
}

/** 右键列表空白处（底部区域，避开条目行） */
async function rightClickBlank(page: Page) {
  const body = page.locator("[data-filelist-body]");
  const box = (await body.boundingBox())!;
  await body.click({ button: "right", position: { x: 120, y: box.height - 14 } });
}

test.describe("31A. 新建文件/文件夹触发行内重命名", () => {
  test("右键空白 → 新建文件夹 → 输入框直接键入新名回车生效", async ({ page }) => {
    await rightClickBlank(page);
    const menu = page.locator('[data-slot="context-menu-content"]');
    await menu.getByText("新建文件夹").click();

    // 新条目出现且立即进入重命名（输入框自动聚焦全选默认名）
    const created = page.locator(`[data-path="${HOME}/新建文件夹"]`);
    await expect(created).toBeVisible();
    const input = created.locator("input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    // 直接键入覆盖选中的默认名 → 回车提交
    await page.keyboard.type("ProjectA");
    await input.press("Enter");

    await expect(page.locator(`[data-path="${HOME}/ProjectA"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/新建文件夹"]`)).toHaveCount(0);
  });

  test("⋮ 菜单 → 新建文件 → 不改名回车保留默认名", async ({ page }) => {
    await page.getByTitle("应用菜单").click();
    // 「新建文件」是「新建文件夹」的前缀（可访问名还带快捷键提示）：排除掉文件夹项
    await page
      .locator('[data-slot="dropdown-menu-item"]')
      .filter({ hasText: "新建文件" })
      .filter({ hasNotText: "新建文件夹" })
      .click();

    const created = page.locator(`[data-path="${HOME}/新建文件.txt"]`);
    await expect(created).toBeVisible();
    const input = created.locator("input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    await input.press("Enter");

    await expect(page.locator(`[data-path="${HOME}/新建文件.txt"]`)).toBeVisible();
    // 编辑态已结束（输入框收起）
    await expect(created.locator("input")).toHaveCount(0);
  });

  test("标签视图（虚拟目录）新建 → 提示不支持，不在真实目录落盘", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __RDIR_PREFS__?: unknown }).__RDIR_PREFS__ = {
        tagNames: {},
        fileTags: { "/mock/home/Notes.txt": ["red"] },
        customQuick: [],
      };
    });
    await page.reload();
    await page.getByTitle(/查看「红色」标签的文件/).click();
    await expect(page.locator('[data-tag-path="/mock/home/Notes.txt"]')).toBeVisible();

    await page.getByTitle("应用菜单").click();
    await page.getByRole("menuitem", { name: "新建文件夹" }).click();
    // 状态栏提示不支持新建；标签视图与真实 HOME 都不产生新条目
    await expect(page.locator("[data-statusbar]")).toContainText("不支持新建");
    await expect(page.locator('[data-tag-path="tags://red/新建文件夹"]')).toHaveCount(0);
    await expect(page.locator(`[data-path="${HOME}/新建文件夹"]`)).toHaveCount(0);
  });
});

test.describe("31B. 标签视图重命名文件夹本体", () => {
  test("右键标签条目 → 重命名 → 新名出现且标签跟随", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __RDIR_PREFS__?: unknown }).__RDIR_PREFS__ = {
        tagNames: {},
        // Documents 是目录：标签作用于文件夹（本优化主体）
        fileTags: { "/mock/home/Documents": ["red"], "/mock/home/Notes.txt": ["red"] },
        customQuick: [],
      };
    });
    await page.reload();
    await page.getByTitle(/查看「红色」标签的文件/).click();
    await expect(page.locator('[data-tag-path="/mock/home/Documents"]')).toBeVisible();

    await page.locator('[data-tag-path="/mock/home/Documents"]').click({ button: "right" });
    await page.locator('[data-slot="context-menu-content"]').getByText("重命名…").click();

    const input = page.locator('[data-tag-path="/mock/home/Documents"] input');
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    await input.fill("文档库");
    await input.press("Enter");

    // 标签视图出现新路径、旧路径消失；另一条目标签不受影响
    await expect(page.locator(`[data-tag-path="${HOME}/文档库"]`)).toBeVisible();
    await expect(page.locator('[data-tag-path="/mock/home/Documents"]')).toHaveCount(0);
    await expect(page.locator('[data-tag-path="/mock/home/Notes.txt"]')).toBeVisible();
  });
});

test.describe("31C. 服务器清单导出/导入", () => {
  test("工具 ▾ → 导出服务器列表：save 对话框给路径后调用后端导出", async ({ page }) => {
    // 桩在 invoke 时读 window：直接在活动页注入（addInitScript 在 goto 后不再执行）
    await page.evaluate(() => {
      (window as unknown as { __rdirDialogSave?: string | null }).__rdirDialogSave =
        "/mock/home/servers-backup.json";
    });
    await page.getByTitle("工具").click();
    await page.getByRole("menuitem", { name: "导出服务器列表…" }).click();

    const mock = await page.evaluate(
      () =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { sftpExport: { target: string }[] };
          }
        ).__RDIR_E2E_MOCK__,
    );
    expect(mock.sftpExport).toHaveLength(1);
    expect(mock.sftpExport[0].target).toBe("/mock/home/servers-backup.json");
    await expect(toast(page)).toContainText("已导出");
  });

  test("工具 ▾ → 导入服务器列表：无密文直接导入并提示跳过统计", async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { __rdirDialogOpen?: string | null }).__rdirDialogOpen =
        "/mock/home/servers.json";
    });
    await page.getByTitle("工具").click();
    await page.getByRole("menuitem", { name: "导入服务器列表…" }).click();

    const mock = await page.evaluate(
      () =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { sftpImport: { filePath: string; hasKey: boolean }[] };
          }
        ).__RDIR_E2E_MOCK__,
    );
    expect(mock.sftpImport).toEqual([{ filePath: "/mock/home/servers.json", hasKey: false }]);
    await expect(toast(page)).toContainText("已导入 2 台服务器（跳过 1 台已存在）");
  });

  test("导入含密文文件：必须输入导出方主密码（错误密码框内提示，正确后导入）", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as {
        __rdirDialogOpen?: string | null;
        __rdirImportNeedsKey?: boolean;
      };
      w.__rdirDialogOpen = "/mock/home/servers-enc.json";
      w.__rdirImportNeedsKey = true;
    });
    await page.getByTitle("工具").click();
    await page.getByRole("menuitem", { name: "导入服务器列表…" }).click();

    // NEED_MASTER_KEY → 弹主密码框（描述说明为什么需要）
    const dlg = page.locator("[data-password-dialog]");
    await expect(dlg).toBeVisible();
    const input = dlg.locator('input[type="password"]');
    await expect(input).toBeFocused();

    // 错误密码 → 框内报错、不关闭
    await input.fill("wrong");
    await dlg.getByRole("button", { name: "导入" }).click();
    await expect(dlg).toContainText("主密码不正确");

    // 正确密码 → 导入成功、框关闭
    await input.fill("mk1");
    await dlg.getByRole("button", { name: "导入" }).click();
    await expect(toast(page)).toContainText("已导入 2 台服务器");
    await expect(dlg).toHaveCount(0);
  });

  test("导出遇明文密码且主密钥未解锁：弹主密码框，加密后再写出（v0.31.1）", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as {
        __rdirDialogSave?: string | null;
        __rdirExportNeedsKey?: boolean;
      };
      w.__rdirDialogSave = "/mock/home/servers-backup.json";
      w.__rdirExportNeedsKey = true;
    });
    await page.getByTitle("工具").click();
    await page.getByRole("menuitem", { name: "导出服务器列表…" }).click();

    // NEED_MASTER_KEY → 主密码框（本机未设过主密钥 → 标题为「设置主密码」）
    const dlg = page.locator("[data-password-dialog]");
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("设置主密码");
    await expect(dlg).toContainText("明文保存的服务器密码");
    const input = dlg.locator('input[type="password"]');

    // 错误密码 → 框内报错、不关闭
    await input.fill("wrong");
    await dlg.getByRole("button", { name: "加密并导出" }).click();
    await expect(dlg).toContainText("主密码不正确");

    // 正确密码 → 带密码重试导出、成功提示注明含加密密码、框关闭
    await input.fill("mk1");
    await dlg.getByRole("button", { name: "加密并导出" }).click();
    await expect(toast(page)).toContainText("已导出 3 台服务器（含加密密码");
    await expect(dlg).toHaveCount(0);

    const mock = await page.evaluate(
      () =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { sftpExport: { target: string; hasKey: boolean }[] };
          }
        ).__RDIR_E2E_MOCK__,
    );
    // 首次无密码被拒不计入记录；错误密码被拒不计入；仅正确那次落盘
    expect(mock.sftpExport).toEqual([{ target: "/mock/home/servers-backup.json", hasKey: true }]);
  });
});

test.describe("31D. 远程文件打开与临时目录", () => {
  test("双击远程文件：下载到确定性临时目录后用系统应用打开", async ({ page }) => {
    // 一键重连已存密码的服务器 → 进入远程目录
    await page.getByTitle(/u@127\.0\.0\.1:22/).click();
    await expect(
      page.locator('[data-path="sftp://u@127.0.0.1:22/remote/deploy.sh"]'),
    ).toBeVisible();

    await page.locator('[data-path="sftp://u@127.0.0.1:22/remote/deploy.sh"]').dblclick();

    const mock = await page.evaluate(
      () =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { sftpDownloads: string[]; opened: string[] };
          }
        ).__RDIR_E2E_MOCK__,
    );
    expect(mock.sftpDownloads).toEqual(["sftp://u@127.0.0.1:22/remote/deploy.sh"]);
    expect(mock.opened).toEqual(["/tmp/r-dir-sftp/deploy.sh"]);
  });

  test("侧边栏远程服务器分组名右键 → 清理远程临时文件，提示释放量", async ({ page }) => {
    await page.locator("[data-sidebar-servers-header]").click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toContainText("导出服务器列表…");
    await expect(menu).toContainText("导入服务器列表…");
    await menu.getByText("清理远程临时文件").click();

    await expect(toast(page)).toContainText("已清理 2 个远程临时文件");
    await expect(toast(page)).toContainText("3.0M");
  });
});

test.describe("31E. 服务器编辑仅保存 / 拖拽换组 / 分组重命名", () => {
  /** 侧边栏服务器行（可访问名 = 行内名称文本） */
  function serverRow(page: Page, name: string) {
    return page.getByRole("button", { name, exact: true });
  }
  function groupHeader(page: Page, group: string) {
    return page.locator(`[data-server-group="${group}"]`);
  }

  test("编辑 → 改分组 → 「保存」只写清单：不连接、不切换目录", async ({ page }) => {
    await serverRow(page, "生产机").click({ button: "right" });
    await page.locator('[data-slot="context-menu-content"]').getByText("编辑…").click();

    const groupInput = page.locator('input[placeholder*="分组"]');
    await expect(groupInput).toBeVisible();
    await groupInput.fill("工作站");
    await page.getByRole("button", { name: "保存", exact: true }).click();

    // 对话框关闭；侧边栏出现「工作站」组且生产机在其下；默认组只剩测试机
    await expect(groupInput).toHaveCount(0);
    await expect(groupHeader(page, "工作站")).toBeVisible();
    await expect(groupHeader(page, "工作站")).toContainText("1");
    await expect(groupHeader(page, "默认")).toContainText("1");
    // 未触发连接（sftp_connect 零调用），目录仍是 HOME
    const mock = await page.evaluate(
      () =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { sftpConnects: string[] };
          }
        ).__RDIR_E2E_MOCK__,
    );
    expect(mock.sftpConnects).toEqual([]);
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(toast(page)).toContainText("已保存");
  });

  test("拖服务器到其他分组名：整组归位（调用后端换组）", async ({ page }) => {
    // 准备第二组：经「编辑 → 仅保存」把测试机归到工作站组（保存不连接）
    await serverRow(page, "测试机").click({ button: "right" });
    await page.locator('[data-slot="context-menu-content"]').getByText("编辑…").click();
    const groupInput = page.locator('input[placeholder*="分组"]');
    await groupInput.fill("工作站");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(groupHeader(page, "工作站")).toContainText("1");

    // 生产机（默认组）拖到工作站分组名上
    await page.dragAndDrop('button:has-text("生产机")', '[data-server-group="工作站"]');

    // 生产机换组：工作站 2 台、默认组消失；后端收到换组调用
    await expect(groupHeader(page, "工作站")).toContainText("2");
    await expect(groupHeader(page, "默认")).toHaveCount(0);
    const mock = await page.evaluate(
      () =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { sftpSetGroup: { ids: string[]; group: string }[] };
          }
        ).__RDIR_E2E_MOCK__,
    );
    expect(mock.sftpSetGroup).toEqual([{ ids: ["u@127.0.0.1:22"], group: "工作站" }]);
  });

  test("分组右键 → 重命名分组… → 组内服务器整体换名", async ({ page }) => {
    // 默认组（两台 mock 服务器都在）：右键分组名整体重命名
    await groupHeader(page, "默认").click({ button: "right" });
    await page.locator('[data-slot="context-menu-content"]').getByText("重命名分组…").click();

    const input = page.locator('input[placeholder="新分组名"]');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(page.getByRole("dialog")).toContainText("2 台服务器");
    await input.fill("研发组");
    await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();

    await expect(groupHeader(page, "研发组")).toBeVisible();
    await expect(groupHeader(page, "研发组")).toContainText("2");
    await expect(groupHeader(page, "默认")).toHaveCount(0);
    const mock = await page.evaluate(
      () =>
        (
          window as unknown as {
            __RDIR_E2E_MOCK__: { sftpSetGroup: { ids: string[]; group: string }[] };
          }
        ).__RDIR_E2E_MOCK__,
    );
    expect(mock.sftpSetGroup).toEqual([
      { ids: ["u@127.0.0.1:22", "tester@10.0.0.9:22"], group: "研发组" },
    ]);
  });
});
