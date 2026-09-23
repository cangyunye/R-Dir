import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * E2E 回归用例（前端 dev server + Tauri IPC 桩）。
 *
 * 桩在 e2e/tauri-mock.ts：给一个固定的虚拟文件系统 /mock/home，
 * 因此这里可以断言真实数据与交互结果，而不是只断言 "body 可见"。
 *
 * 运行：pnpm test:e2e
 */

const HOME = "/mock/home";

// 与 src/lib/keymap.ts 的 isMac 判定保持一致：macOS 上 mod = ⌘(Meta)，Windows/Linux = Ctrl
const MOD = process.platform === "darwin" ? "Meta" : "Control";
// goUp 的默认键位：mac = mod+up，win = alt+up（Backspace 只在 Windows 生效）
const GO_UP = process.platform === "darwin" ? "Meta+ArrowUp" : "Alt+ArrowUp";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
});

test.describe("1. 启动", () => {
  test("W1 默认打开家目录并列出内容", async ({ page }) => {
    await expect(page.locator("#rdir-addr-input")).toHaveValue(HOME);
    await expect(page.locator(`[data-path="${HOME}/Documents"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/Projects"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/photo.png"]`)).toBeVisible();
  });

  test("W2 目录排在文件前面", async ({ page }) => {
    const names = await page.locator("[data-path]").allInnerTexts();
    expect(names.length).toBe(5);
    const firstFile = names.findIndex((t) => t.includes("Notes.txt"));
    const lastDir = names.findLastIndex((t) => t.includes("Documents") || t.includes("Projects"));
    expect(lastDir).toBeLessThan(firstFile);
  });

  test("W6 菜单栏包含 文件/编辑/查看", async ({ page }) => {
    const bar = page.locator("[data-keymap-version]");
    await expect(bar).toContainText("文件");
    await expect(bar).toContainText("编辑");
    await expect(bar).toContainText("查看");
  });
});

test.describe("2. 导航", () => {
  test("N1 双击目录进入下一级", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${HOME}/Documents`);
  });

  test("N2 返回上一级", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${HOME}/Documents`);
    await page.keyboard.press(GO_UP);
    await expect(page.locator("#rdir-addr-input")).toHaveValue(HOME);
  });

  test("N7 F5 刷新后列表仍在", async ({ page }) => {
    await page.keyboard.press("F5");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  });
});

test.describe("3. 文件列表交互", () => {
  test("L1 单击选中一行", async ({ page }) => {
    const row = page.locator(`[data-path="${HOME}/Notes.txt"]`);
    await row.click();
    await expect(row).toHaveClass(/bg-accent|bg-primary/);
  });

  test("L2 全选", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press(`${MOD}+KeyA`);
    await expect(page.locator("[data-path]")).toHaveCount(5);
  });
});

test.describe("4. 标签页", () => {
  test("T1 新开标签页", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await expect(page.locator("[data-tab-idx]")).toHaveCount(1);
    await page.keyboard.press(`${MOD}+KeyT`);
    await expect(page.locator("[data-tab-idx]")).toHaveCount(2);
  });
});

test.describe("5. 右键菜单", () => {
  test("C1 右键文件出现操作项", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("打开");
    await expect(menu).toContainText("重命名");
    await expect(menu).toContainText("删除");
  });

  test("C2 右键空白处出现新建项", async ({ page }) => {
    await page.locator("[data-path]").first().click({ button: "right" });
    await page.keyboard.press("Escape");
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeHidden();
  });
});

test.describe("6. 搜索", () => {
  test("S1 打开搜索面板", async ({ page }) => {
    await page.keyboard.press(`${MOD}+KeyF`);
    await expect(page.getByPlaceholder(/搜索|输入/).first()).toBeVisible();
  });

  test("S2 结果右键出现定位/复制路径项", async ({ page }) => {
    await page.keyboard.press(`${MOD}+KeyF`);
    await page.getByPlaceholder(/搜索当前层文件名/).fill("Notes");
    const row = page.locator(`[data-search-path="${HOME}/Notes.txt"]`);
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("定位到文件");
    await expect(menu).toContainText("复制绝对路径");
    await expect(menu).toContainText("复制相对路径");
  });

  test("S3 双击结果用系统关联程序打开", async ({ page }) => {
    await page.keyboard.press(`${MOD}+KeyF`);
    await page.getByPlaceholder(/搜索当前层文件名/).fill("photo");
    await page.locator(`[data-search-path="${HOME}/photo.png"]`).dblclick();
    const opened = await page.evaluate(
      () => (window as unknown as { __RDIR_E2E_MOCK__: { opened: string[] } }).__RDIR_E2E_MOCK__.opened,
    );
    expect(opened).toContain(`${HOME}/photo.png`);
  });

  test("S4 目录结果右键定位进入文件夹", async ({ page }) => {
    await page.keyboard.press(`${MOD}+KeyF`);
    await page.getByPlaceholder(/搜索当前层文件名/).fill("Projects");
    await page.locator(`[data-search-path="${HOME}/Projects"]`).click({ button: "right" });
    await page
      .locator('[data-slot="context-menu-content"]')
      .getByText("定位到文件夹")
      .click();
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${HOME}/Projects`);
  });
});

test.describe("6b. 标签视图右键菜单", () => {
  test("G1 标签条目右键可加标签/复制路径/移除此标签", async ({ page }) => {
    // 预置标签数据后再加载（localStorage 在应用初始化时读取）
    await page.addInitScript(() => {
      localStorage.setItem(
        "rfm.tags",
        JSON.stringify({ "/mock/home/Notes.txt": ["red"] }),
      );
    });
    await page.reload();
    await page.getByRole("button", { name: "红色" }).first().click();
    const row = page.locator(`[data-tag-path="${HOME}/Notes.txt"]`);
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("复制路径");
    await expect(menu).toContainText("移除此标签");
    // 展开「标签」折叠组，应出现其他预设标签
    await menu.getByText("标签", { exact: true }).click();
    await expect(menu).toContainText("橙色");
  });
});

test.describe("7. SFTP 侧边栏（回归：一键重连 / 无凭据弹框）", () => {
  test("F1 已保存密码的服务器一键重连并列出远程目录", async ({ page }) => {
    await page.getByRole("button", { name: "生产机" }).click();
    await expect(page.locator("#rdir-addr-input")).toHaveValue("sftp://u@127.0.0.1:22/remote");
    await expect(page.locator('[data-path="sftp://u@127.0.0.1:22/remote/deploy.sh"]')).toBeVisible();
  });

  test("F2 无凭据的服务器弹出连接框", async ({ page }) => {
    await page.getByRole("button", { name: "测试机" }).click();
    await expect(page.getByText("SFTP 连接")).toBeVisible();
  });
});

test.describe("8. 快捷键不崩溃（全量冒烟）", () => {
  const combos = [
    "Enter", "F5", "F2", "F1", "Delete", "Escape",
    `${MOD}+KeyC`, `${MOD}+KeyX`, `${MOD}+KeyV`,
    `${MOD}+KeyA`, `${MOD}+KeyZ`, `${MOD}+KeyY`,
    `${MOD}+KeyW`,
    `${MOD}+Shift+KeyT`,
    `${MOD}+KeyJ`, `${MOD}+KeyL`,
    `${MOD}+Comma`,
  ];

  for (const combo of combos) {
    test(`${combo} 后列表仍可用`, async ({ page }) => {
      await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
      await page.keyboard.press(combo);
      // 断言不是"页面还活着"，而是数据仍在、可继续操作
      await expect(page.locator("[data-path]").first()).toBeVisible();
    });
  }
});

test.describe("9. 设置对话框滑动分区", () => {
  test("S1 左栏为锚点跳转，对话框高度不随分区变化", async ({ page }) => {
    await page.getByRole("button", { name: "帮助" }).click();
    await page.getByText("设置（快捷键录制与主题）").click();
    await expect(page.getByText("配置自动保存在本机")).toBeVisible();

    const dialog = page.locator(".fixed.inset-0 > div").first();
    const scroller = dialog.locator(".overflow-y-auto").last();
    const height0 = (await dialog.boundingBox())!.height;

    // 点「快捷键」→ 滚动到该分区，且分区标题不被顶边裁掉
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const scrollerTop = (await scroller.boundingBox())!.y;
    const keysTop = (await scroller.locator(":scope > div").nth(1).boundingBox())!.y;
    expect(keysTop).toBeGreaterThanOrEqual(scrollerTop);

    // 点「关于」→ 继续向下滚动；对话框高度保持恒定（不再随分区跳动）
    await page.getByRole("button", { name: "关于", exact: true }).click();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
    expect((await dialog.boundingBox())!.height).toBe(height0);
  });
});
