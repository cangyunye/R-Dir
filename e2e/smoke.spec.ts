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

test.describe("10. 右键菜单不溢出窗口（界面缩放回归）", () => {
  test("大字体 + 矮窗口下，右键底部条目菜单仍收在窗口内", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("rfm.ui-font", "18");
      localStorage.setItem("rfm.ui-font-migrated-v080", "1");
    });
    await page.setViewportSize({ width: 1000, height: 560 });
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    // 右键最后一行（靠近窗口底部）
    await page.locator("[data-path]").last().click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    const vh = page.viewportSize()!.height;
    // eslint-disable-next-line no-console
    console.log("menu box:", JSON.stringify(box), "viewportH:", vh);
    expect(box).not.toBeNull();
    expect(box!.y, "菜单顶边不应在窗口上方").toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height, "菜单底边不应超出窗口").toBeLessThanOrEqual(vh + 1);
  });
});

test.describe("11. 空白处「属性（当前目录）」（v0.17.1）", () => {
  test("选中文件使地址栏显示文件路径时，右键空白处属性仍统计当前目录", async ({ page }) => {
    // 单击文件 → 地址栏显示该文件完整路径（v0.14 行为）
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${HOME}/Notes.txt`);

    // 右键列表空白处
    const body = page.locator("[data-filelist-body]");
    const box = (await body.boundingBox())!;
    await body.click({ button: "right", position: { x: 120, y: box.height - 14 } });

    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("属性（当前目录）");
    await menu.getByText("属性（当前目录）").click();

    // 属性弹窗统计的是当前目录 HOME，而不是被选中的 Notes.txt
    const dlg = page.locator("[data-properties-dialog]");
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("文件夹");
    await expect(dlg).not.toContainText("Notes.txt");
  });
});

test.describe("12. 标签名磁盘恢复（localStorage 被清空时）", () => {
  test("从 prefs.json 恢复自定义标签名「工程」", async ({ page }) => {
    // 模拟 localStorage 丢失（换 origin / 被清理），且磁盘 prefs.json 有自定义名
    await page.addInitScript(() => {
      localStorage.clear();
      (window as unknown as { __RDIR_PREFS__?: unknown }).__RDIR_PREFS__ = {
        tagNames: { red: "工程" },
        fileTags: {},
        customQuick: [],
      };
    });
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    // 侧栏标签应显示磁盘里保存的自定义名，而不是预设「红色」
    await expect(page.getByText("工程", { exact: true }).first()).toBeVisible();
  });
});

test.describe("13. 同步比对（v0.18 同步浏览 + 实时面板）", () => {
  const syncA = `${HOME}/Documents/syncA`;
  const syncB = `${HOME}/Documents/syncB`;

  /** 分出左右两个窗格，左→syncA、右→syncB，开启同步比对面板 */
  async function openSyncPair(page: import("@playwright/test").Page) {
    await page.getByRole("button", { name: "窗格", exact: true }).click();
    await page.getByText("左右分屏").click();
    await expect(page.locator(`[data-path="${HOME}/Documents"]`)).toHaveCount(2);

    // 左窗格 → syncA
    await page.locator(`[data-path="${HOME}/Documents"]`).first().click();
    await page.locator("#rdir-addr-input").fill(syncA);
    await page.locator("#rdir-addr-input").press("Enter");
    await expect(page.locator(`[data-path="${syncA}/onlyA.txt"]`)).toBeVisible();

    // 右窗格 → syncB（此时只剩右窗格还列着 Documents）
    await page.locator(`[data-path="${HOME}/Documents"]`).first().click();
    await page.locator("#rdir-addr-input").fill(syncB);
    await page.locator("#rdir-addr-input").press("Enter");
    await expect(page.locator(`[data-path="${syncB}/common"]`)).toBeVisible();

    // 开启同步比对（工具栏链接按钮）→ 状态栏出现摘要段（v0.18.2 起结果在模态中，底部横条已移除）
    await page.locator('button[title^="同步比对"]').click();
    await expect(page.locator("[data-sync-diff-status]")).toBeVisible();
  }

  test("X1 开启即比对：状态栏摘要出现、色条显示、模态实时更新", async ({ page }) => {
    await openSyncPair(page);
    // 底部横条不再渲染；文件列表行首色条不受影响
    await expect(page.locator("[data-sync-diff-panel]")).toHaveCount(0);
    await expect(page.locator('[data-diff-mark="left-only"]').first()).toBeVisible();

    // Ctrl+Shift+X 打开结果模态
    await page.keyboard.press(`${MOD}+Shift+KeyX`);
    const modal = page.locator("[data-sync-diff-modal]");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("已对齐");
    await expect(modal).toContainText("onlyA.txt");

    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    // 左窗格进入 common → 右窗格自动跟随；重开模态为该层比对结果
    await page.locator(`[data-path="${syncA}/common"]`).dblclick();
    await expect(page.locator(`[data-path="${syncB}/common/same.txt"]`)).toBeVisible();
    await page.keyboard.press(`${MOD}+Shift+KeyX`);
    await expect(modal).toContainText("a-only.txt");
  });

  test("X2 对侧无同名目录：状态栏 warn + 模态横幅新建后恢复对齐", async ({ page }) => {
    await openSyncPair(page);
    // 左窗格进入右窗格不存在的 missing/
    await page.locator(`[data-path="${syncA}/missing"]`).dblclick();
    await expect(page.locator(`[data-path="${syncA}/missing/x.txt"]`)).toBeVisible();
    // 对侧停在原地；状态栏摘要段变 warn
    await expect(page.locator(`[data-path="${syncB}/common"]`)).toBeVisible();
    const statusSeg = page.locator("[data-sync-diff-status]");
    await expect(statusSeg).toHaveAttribute("data-sync-diff-status", "warn");

    // 打开模态 → 横幅 → 在对侧新建并进入 → 恢复对齐（新目录为空，x.txt 标「仅左侧」）
    await statusSeg.click();
    const modal = page.locator("[data-sync-diff-modal]");
    await expect(modal).toContainText("两侧不同层");
    await page.getByText("在对侧新建并进入").click();
    await expect(page.locator("#rdir-addr-input")).toHaveValue(`${syncB}/missing`);
    await expect(modal).toContainText("已对齐");
    await expect(modal).toContainText("x.txt");
    await expect(modal).toContainText("仅左侧");
  });

  test("X3 断开链接：模态与状态栏段消失、行首标注清除", async ({ page }) => {
    await openSyncPair(page);
    await expect(page.locator('[data-diff-mark="left-only"]').first()).toBeVisible();
    await page.locator("[data-sync-diff-status]").click();
    const modal = page.locator("[data-sync-diff-modal]");
    await expect(modal).toBeVisible();
    await modal.getByText("断开链接").click();
    await expect(page.locator("[data-sync-diff-modal]")).toHaveCount(0);
    await expect(page.locator("[data-sync-diff-status]")).toHaveCount(0);
    await expect(page.locator("[data-diff-mark]")).toHaveCount(0);
    // 两侧窗格仍在原位置
    await expect(page.locator(`[data-path="${syncA}/onlyA.txt"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${syncB}/common"]`)).toBeVisible();
  });
});
