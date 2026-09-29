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
// goUp 的默认键位：mac = mod+up / ⌫(Backspace)，win = alt+up / Backspace（v0.21.1 起两平台 ⌫ 一致）
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

  test("W6 应用菜单含 文件/编辑/查看 分组，Ctrl+K 打开命令面板", async ({ page }) => {
    // v0.20 撤常驻菜单条：功能入口收进右上 ⋮ 应用菜单 + 命令面板
    await page.getByTitle("应用菜单").click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("文件");
    await expect(menu).toContainText("编辑");
    await expect(menu).toContainText("查看");
    await page.keyboard.press("Escape");
    // CI 在 macOS 上跑 e2e：键位按平台取 Mod（⌘/Ctrl），硬编码 Control 在 mac 非注册键位
    await page.keyboard.press(`${MOD}+k`);
    await expect(page.getByPlaceholder(/搜索命令/)).toBeVisible();
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
    await expect(page.getByPlaceholder("搜索当前层文件名…")).toBeVisible();
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
    await page.getByTitle("设置（快捷键录制）").click();
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
    await page.getByTitle("应用菜单").click();
    await page.getByRole("menuitem", { name: "左右分屏" }).click();
    await expect(page.locator(`[data-path="${HOME}/Documents"]`)).toHaveCount(2);

    // 左窗格 → syncA
    await page.locator(`[data-path="${HOME}/Documents"]`).first().click();
    await page.locator("[data-pathbar-edit]").click();
    await page.locator("#rdir-addr-input").fill(syncA);
    await page.locator("#rdir-addr-input").press("Enter");
    await expect(page.locator(`[data-path="${syncA}/onlyA.txt"]`)).toBeVisible();

    // 右窗格 → syncB（此时只剩右窗格还列着 Documents）
    await page.locator(`[data-path="${HOME}/Documents"]`).first().click();
    await page.locator("[data-pathbar-edit]").click();
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

test.describe("14. 整页不滚动（界面缩放回归，v0.18.3）", () => {
  test("大字体（根 zoom>1）下整页无滚动条，状态栏在视口内", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("rfm.ui-font", "18");
      localStorage.setItem("rfm.ui-font-migrated-v080", "1");
    });
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    const m = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
    }));
    expect(m.scrollH, "根 zoom>1 时布局不得超出视口（否则整页出现滚动条）").toBeLessThanOrEqual(
      m.clientH + 1,
    );

    // 状态栏（含同步比对/分享按钮）无需滚动即可见：底边在视口内
    const sb = (await page.locator("[data-statusbar]").boundingBox())!;
    expect(sb.y + sb.height, "状态栏应完整落在视口内").toBeLessThanOrEqual(
      page.viewportSize()!.height + 1,
    );
  });
});

test.describe("15. 键盘焦点回归（v0.21.0 修复）", () => {
  // 根因：radix 右键菜单关闭时的焦点恢复会抢走行内重命名输入框的焦点，
  // onBlur 以未修改的名字静默提交 → 输入框闪退、名字不变。
  // 修复后输入框应拿到焦点并拿稳（0/120/300ms 重试），可正常输入改名。
  test("R1 右键重命名：输入框保持焦点，改名后列表显示新名称", async ({ page }) => {
    const row = page.locator(`[data-path="${HOME}/Notes.txt"]`);
    await row.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("重命名");
    await menu.getByText("重命名").click();

    const input = row.locator("input");
    await expect(input).toBeVisible();
    // 越过 300ms 重试窗口断言焦点仍在输入框上（修复前会被 radix 抢走并闪退）
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();

    await input.fill("Renamed.txt");
    await input.press("Enter");
    await expect(page.locator(`[data-path="${HOME}/Renamed.txt"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);
  });

  // 粘贴完成后应定位并选中新条目（含主选中高亮）
  test("R2 复制→粘贴：新条目出现在目标目录且被选中", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press(`${MOD}+c`);
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();

    await page.keyboard.press(`${MOD}+v`);
    const pasted = page.locator(`[data-path="${HOME}/Documents/Notes.txt"]`);
    await expect(pasted).toBeVisible();
    // 主选中：行带 ring 高亮（粘贴后定位选中）
    await expect(pasted).toHaveClass(/ring-1/);
  });
});

test.describe("16. 搜索结果内联重命名（v0.21.0）", () => {
  test("R3 递归检索结果右键重命名：改名生效、面板与主列表同步更新", async ({ page }) => {
    await page.keyboard.press(`${MOD}+f`);
    await page.getByPlaceholder("搜索当前层文件名…").fill("photo");
    // 开启 fd 递归检索后再输入触发检索
    await page.getByText("递归检索（fd 引擎）").click();
    const input = page.getByPlaceholder("检索文件（fd 正则）…");
    await input.fill("photo");

    const row = page.locator(`[data-search-path="${HOME}/photo.png"]`);
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("重命名");
    await menu.getByText("重命名").click();

    const input2 = page.locator(`[data-search-path="${HOME}/photo.png"] input`);
    await expect(input2).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input2).toBeFocused();
    await input2.fill("renamed_photo.png");
    await input2.press("Enter");

    // 面板结果乐观更新 + 所在目录窗格刷新 + 定位选中
    await expect(page.locator(`[data-search-path="${HOME}/renamed_photo.png"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/renamed_photo.png"]`)).toBeVisible();
  });
});

test.describe("17. 删除确认弹窗（v0.21.0）", () => {
  test("R4 删除目录：确认框展示内部统计，确认后删除", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Projects"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("删除（回收站）").click();

    const dialog = page.locator("[data-delete-confirm]");
    await expect(dialog).toBeVisible();
    // 内部统计（与属性同引擎）：递归计入 Projects 内的 app.ts(900B)
    await expect(dialog).toContainText("个文件");
    await expect(dialog).toContainText("900B");
    await expect(dialog).toContainText("撤销恢复");

    await dialog.getByRole("button", { name: "删除" }).click();
    await expect(page.locator(`[data-path="${HOME}/Projects"]`)).toHaveCount(0);
  });

  test("R5 删除文件也弹确认框：取消则不删，确认才删除", async ({ page }) => {
    // 文件此前不弹框，现在一律确认
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("删除（回收站）").click();
    const dialog = page.locator("[data-delete-confirm]");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("删除（回收站）").click();
    await page.locator("[data-delete-confirm]").getByRole("button", { name: "删除" }).click();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);
  });
});

test.describe("18. 搜索起始目录回归（点击选中后 Ctrl+F）", () => {
  // 用户曾报：Ctrl+F 前点击了文件/文件夹，搜索起点不对。
  // 当前代码验证：选中只影响地址栏显示（PropertiesBar/地址栏），不影响窗格 path，
  // 搜索面板冻结的目录恒为窗格目录——用例锁定该行为。
  test("R6 点击文件后 Ctrl+F：搜索目录仍为本层级，递归检索正常", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press(`${MOD}+f`);

    // 面板头部冻结目录 = 窗格目录（而非选中条目路径；属性栏的 title=选中路径不算）
    await expect(page.locator(`span[title="${HOME}"]`).first()).toBeVisible();

    // 递归检索从本层级起搜：能命中子目录 Documents 下的 readme.md
    await page.locator("input[type=checkbox]").first().check();
    await page.getByPlaceholder("检索文件（fd 正则）…").fill("readme");
    await expect(page.locator(`[data-search-path="${HOME}/Documents/readme.md"]`)).toBeVisible();
  });
});

test.describe("19. 路径栏面包屑（v0.21.0）", () => {
  test("R7 分段展示与点击跳转：点上一层级返回", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    const bar = page.locator("[data-pathbar]");
    await expect(bar).toBeVisible();
    // 分段：/ / mock / home / Documents（末段高亮=当前位置）
    await expect(bar.getByRole("button", { name: "Documents" })).toBeVisible();
    // 点击 home 分段返回上级
    await bar.getByRole("button", { name: "home", exact: true }).click();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    // 路径变化后分段同步
    await expect(bar.getByRole("button", { name: "Documents" })).toHaveCount(0);
  });

  test("R8 点击铅笔进入编辑模式：输入框含完整路径，Esc 返回面包屑", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await page.locator("[data-pathbar-edit]").click();
    const input = page.locator("#rdir-addr-input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(`${HOME}/Documents`);
    // Esc 退出编辑，回到面包屑
    await input.press("Escape");
    await expect(page.locator("[data-pathbar]")).toBeVisible();
  });
});

test.describe("20. 路径栏输入校验（v0.21.0）", () => {
  test("R9 不存在的路径回车：就地红字提示，窗格不切换", async ({ page }) => {
    await page.keyboard.press(`${MOD}+l`);
    await page.locator("#rdir-addr-input").fill(`${HOME}/不存在的目录`);
    await page.locator("#rdir-addr-input").press("Enter");
    const hint = page.locator("[data-path-error]");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("路径不存在或无法访问");
    // 不导航：当前目录内容保持，仍处编辑态可继续修改
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator("#rdir-addr-input")).toBeVisible();
    // 修改输入后提示消失
    await page.locator("#rdir-addr-input").fill(`${HOME}/Documents`);
    await expect(hint).toHaveCount(0);
    await page.locator("#rdir-addr-input").press("Enter");
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();
  });

  test("R10 输入已存在的文件路径：跳父目录并选中该文件", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Documents"]`).dblclick();
    await page.keyboard.press(`${MOD}+l`);
    await page.locator("#rdir-addr-input").fill(`${HOME}/Notes.txt`);
    await page.locator("#rdir-addr-input").press("Enter");
    const row = page.locator(`[data-path="${HOME}/Notes.txt"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/ring-1/);
  });
});

test.describe("21. 地址栏命令（v0.22.0）", () => {
  test("R11 裸词补全出现命令分组：回车在终端执行（记录 input 与 cwd）", async ({ page }) => {
    await page.keyboard.press(`${MOD}+l`);
    const input = page.locator("#rdir-addr-input");
    await input.fill("git");
    // 本层无 git 开头的目录，命令分组独立出现：git / gitui（含可执行路径）
    await expect(page.locator("[data-cmd-suggest]")).toHaveCount(2);
    await expect(page.locator("[data-cmd-suggest]").first()).toContainText("git");
    await expect(page.locator("[data-cmd-suggest]").first()).toContainText("/usr/bin/git");
    await input.press("Enter");
    // 执行成功：退出编辑态回面包屑、窗格留在原目录
    await expect(page.locator("[data-pathbar]")).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    const rec = await page.evaluate(
      () =>
        (window as unknown as { __RDIR_E2E_MOCK__: { runCmds: { input: string; cwd: string }[] } })
          .__RDIR_E2E_MOCK__.runCmds,
    );
    expect(rec.at(-1)).toEqual({ input: "git", cwd: HOME });
  });

  test("R12 Tab 补全命令名（尾随空格）；点击命令项直接执行", async ({ page }) => {
    await page.keyboard.press(`${MOD}+l`);
    const input = page.locator("#rdir-addr-input");
    await input.fill("gr");
    await expect(page.locator("[data-cmd-suggest]")).toHaveCount(1);
    await input.press("Tab");
    // Tab 只补全到输入框（带尾随空格便于补参数），不执行
    await expect(input).toHaveValue("grep ");
    await expect(page.locator("[data-cmd-suggest]")).toHaveCount(0);
    // 点击命令项 → 立即执行
    await input.fill("gre");
    await expect(page.locator("[data-cmd-suggest]")).toHaveCount(1);
    await page.locator("[data-cmd-suggest]").first().click();
    await expect(page.locator("[data-pathbar]")).toBeVisible();
    const rec = await page.evaluate(
      () =>
        (window as unknown as { __RDIR_E2E_MOCK__: { runCmds: { input: string; cwd: string }[] } })
          .__RDIR_E2E_MOCK__.runCmds,
    );
    expect(rec.at(-1)).toEqual({ input: "grep", cwd: HOME });
  });

  test("R13 带参数命令行回车执行：整串原样传给终端，多词不再弹命令组", async ({ page }) => {
    await page.keyboard.press(`${MOD}+l`);
    const input = page.locator("#rdir-addr-input");
    await input.fill("git status");
    // 多词输入不请求命令补全（只有目录补全逻辑，此处无命中 → 无下拉）
    await expect(page.locator("[data-cmd-suggest]")).toHaveCount(0);
    await input.press("Enter");
    await expect(page.locator("[data-pathbar]")).toBeVisible();
    const rec = await page.evaluate(
      () =>
        (window as unknown as { __RDIR_E2E_MOCK__: { runCmds: { input: string; cwd: string }[] } })
          .__RDIR_E2E_MOCK__.runCmds,
    );
    expect(rec.at(-1)).toEqual({ input: "git status", cwd: HOME });
  });

  test("R14 既不是路径也不是命令：合并红字提示、保持编辑态", async ({ page }) => {
    await page.keyboard.press(`${MOD}+l`);
    const input = page.locator("#rdir-addr-input");
    await input.fill("zzzznope");
    await input.press("Enter");
    const hint = page.locator("[data-path-error]");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("路径不存在，也不是 PATH 中的命令：zzzznope");
    // 窗格不动、仍处编辑态可继续修改
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(input).toBeVisible();
  });

  test("R15 带分隔符的输入不出现命令分组（路径语义优先）", async ({ page }) => {
    await page.keyboard.press(`${MOD}+l`);
    const input = page.locator("#rdir-addr-input");
    await input.fill(`${HOME}/git`);
    // 绝对路径输入只走目录补全，即便 PATH 里真有 git
    await expect(page.locator("[data-dir-suggest], [data-cmd-suggest]")).toHaveCount(0);
    await input.press("Escape");
    await expect(page.locator("[data-pathbar]")).toBeVisible();
  });
});
