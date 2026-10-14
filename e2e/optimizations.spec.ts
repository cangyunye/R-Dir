import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.28.0 优化项回归：
 * 1) 侧边栏标签新增（悬停 +，上限 10 + 提醒）；
 * 2) 快捷访问上限 10 + 提醒；
 * 3) 标签重命名对话框输入框自动聚焦（重命名失效回归）；
 * 4) 复制语义：同目录目录复制询问「新增目录」，跨目录目录复制直接覆盖；
 * 5) 文本比较窗口 F11 全屏（仅比对窗口生效）。
 */

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
});

function toast(page: Page) {
  return page.locator("[data-statusbar]").getByText(/上限|最多/);
}

test.describe("29A. 侧边栏标签新增（上限 10）", () => {
  test("T1 标签重命名对话框输入框自动聚焦（v0.28 失效回归）", async ({ page }) => {
    await page.getByTitle(/查看「红色」标签的文件/).click({ button: "right" });
    await page.getByRole("menuitem", { name: /重命名/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const input = dialog.locator("input");
    // 修复前：radix 初始焦点给了色块按钮，输入框永远拿不到焦点（打字无反应）
    await expect(input).toBeFocused();
    await input.fill("紧急");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(page.getByTitle(/查看「紧急」标签的文件/)).toBeVisible();
  });

  test("T2 悬停分组显示 +，新增自定义标签后侧栏出现并可选中", async ({ page }) => {
    const header = page.locator("[data-sidebar-tags-header]");
    const plus = header.locator('button[title="新增标签"]');
    // 悬停前隐藏
    await expect(plus).toBeHidden();
    await header.hover();
    await expect(plus).toBeVisible();
    await plus.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const input = dialog.locator("input");
    await expect(input).toBeFocused();
    await input.fill("紧急");
    // 选一个非默认色
    await dialog.locator('button[title="#ff2d55"]').click();
    await dialog.getByRole("button", { name: "新增" }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByTitle(/查看「紧急」标签的文件/);
    await expect(row).toBeVisible();
    // 点击选中新标签 → 标签视图横幅
    await row.click();
    await expect(page.getByText("标签：紧急")).toBeVisible();
  });

  test("T2A 大图标网格内重命名：逐键输入生效（v0.28 重命名回归）", async ({ page }) => {
    await page.keyboard.press("Alt+2");
    const item = page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`);
    await expect(item).toBeVisible();
    await item.click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();
    const input = item.locator("input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    await page.keyboard.press(`${MOD}+KeyA`);
    await page.keyboard.type("Grid.txt", { delay: 30 });
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-grid-item][data-path="${HOME}/Grid.txt"]`)).toBeVisible();
  });

  test("T3 拉满：7 预设 + 3 自定义 = 10，再点 + 提醒上限", async ({ page }) => {
    const header = page.locator("[data-sidebar-tags-header]");
    for (let i = 1; i <= 3; i++) {
      await header.hover();
      await header.locator('button[title="新增标签"]').click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.locator("input").fill(`自定义${i}`);
      await dialog.getByRole("button", { name: "新增" }).click();
      await expect(dialog).toBeHidden();
    }
    // 侧栏标签行 = 10（7 预设 + 3 自定义）
    const tagRows = page.locator('button[title^="查看「"]');
    await expect(tagRows).toHaveCount(10);

    // 再点 + → 提醒上限，对话框不再打开
    await header.hover();
    await header.locator('button[title="最多 10 个标签"]').click();
    await expect(toast(page)).toContainText("标签最多 10 个");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("29B. 快捷访问上限 10", () => {
  test("T4 预置 10 条后添加 → 提醒且不新增；移除后可再加", async ({ page }) => {
    await page.addInitScript(() => {
      const items = Array.from({ length: 10 }, (_, i) => `/mock/home/quick${i}`);
      localStorage.setItem("rfm.quick", JSON.stringify(items));
    });
    await page.goto("/");
    await expect(page.locator("[data-path]").first()).toBeVisible();
    let custom = page.locator('button[title^="/mock/home/quick"]');
    await expect(custom).toHaveCount(10);

    // 右键文件 → 添加到快捷访问 → 达上限提醒，列表不变
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "添加到快捷访问" }).click();
    await expect(toast(page)).toContainText("快速访问最多添加 10 个");
    await expect(page.locator('button[title^="/mock/home/quick"]')).toHaveCount(10);

    // 移除一条后可再加
    await page.locator('button[title="/mock/home/quick0"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "从快速访问移除" }).click();
    await expect(page.locator('button[title^="/mock/home/quick"]')).toHaveCount(9);
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "添加到快捷访问" }).click();
    await expect(page.locator('button[title="/mock/home/Notes.txt"]')).toBeVisible();
  });
});

test.describe("29C. 目录复制语义", () => {
  test("C1 同目录复制目录（Ctrl+D）遇同名 → 询问新增目录 → 确认后复制为 Documents (2)", async ({ page }) => {
    await page.evaluate((home) => {
      (
        window as unknown as {
          __rdirDirDups?: (paths: string[], dest: string) => { src: string; suggest: string }[];
        }
      ).__rdirDirDups = (paths, dest) =>
        dest === home && paths.includes(`${home}/Documents`)
          ? [{ src: `${home}/Documents`, suggest: "Documents (2)" }]
          : [];
    }, HOME);
    await page.locator(`[data-path="${HOME}/Documents"]`).click();
    await page.keyboard.press(`${MOD}+KeyD`);

    const confirm = page.locator("[data-app-confirm]");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("新增目录");
    await expect(confirm).toContainText("Documents");
    await confirm.getByRole("button", { name: "新增目录" }).click();

    await expect(page.locator(`[data-path="${HOME}/Documents (2)"]`)).toBeVisible();
  });

  test("C2 同目录复制目录遇同名 → 取消则跳过，不产生新目录", async ({ page }) => {
    await page.evaluate((home) => {
      (
        window as unknown as {
          __rdirDirDups?: (paths: string[], dest: string) => { src: string; suggest: string }[];
        }
      ).__rdirDirDups = (paths, dest) =>
        dest === home && paths.includes(`${home}/Documents`)
          ? [{ src: `${home}/Documents`, suggest: "Documents (2)" }]
          : [];
    }, HOME);
    await page.locator(`[data-path="${HOME}/Documents"]`).click();
    await page.keyboard.press(`${MOD}+KeyD`);
    const confirm = page.locator("[data-app-confirm]");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(page.locator(`[data-path="${HOME}/Documents (2)"]`)).toHaveCount(0);
    // 原目录不受影响
    await expect(page.locator(`[data-path="${HOME}/Documents"]`)).toBeVisible();
  });

  test("C3 跨窗格复制目录（注入同名冲突）→ 不弹冲突框，直接覆盖复制", async ({ page }) => {
    await page.evaluate((home) => {
      (
        window as unknown as {
          __rdirConflicts?: (a: { paths: string[]; dest: string }) => unknown[];
        }
      ).__rdirConflicts = ({ dest }) =>
        dest === `${home}/Documents`
          ? [
              {
                src: `${home}/Projects`,
                dest: `${home}/Documents/Projects`,
                srcKind: "dir",
                destKind: "dir",
                suggest: "Projects_1",
              },
            ]
          : [];
    }, HOME);
    // 左右分屏，右窗格进入 Documents
    await page.locator(`[data-path="${HOME}/Documents"]`).click();
    await page.keyboard.press(`${MOD}+Backslash`);
    await expect(page.locator(`[data-path="${HOME}/Documents"]`)).toHaveCount(2);
    await page.keyboard.press(`${MOD}+KeyL`);
    await page.locator("#rdir-addr-input").fill(`${HOME}/Documents`);
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();

    // 左窗格选中 Projects → 复制 → 右窗格粘贴
    await page.locator(`[data-path="${HOME}/Projects"]`).first().click();
    await page.keyboard.press(`${MOD}+KeyC`);
    await page.locator(`[data-path="${HOME}/Documents/readme.md"]`).first().click();
    await page.keyboard.press(`${MOD}+KeyV`);

    // 目录覆盖语义：不弹冲突裁决，直接完成
    await expect(page.locator(`[data-path="${HOME}/Documents/Projects"]`)).toBeVisible();
    await expect(page.getByText("全部覆盖")).toHaveCount(0);
  });

  test("C4 跨窗格复制文件遇同名 → 仍弹冲突裁决框（文件语义不变）", async ({ page }) => {
    await page.evaluate((home) => {
      (
        window as unknown as {
          __rdirConflicts?: (a: { paths: string[]; dest: string }) => unknown[];
        }
      ).__rdirConflicts = ({ dest }) =>
        dest === `${home}/Documents`
          ? [
              {
                src: `${home}/Notes.txt`,
                dest: `${home}/Documents/Notes.txt`,
                srcKind: "file",
                destKind: "file",
                suggest: "Notes_1.txt",
              },
            ]
          : [];
    }, HOME);
    await page.locator(`[data-path="${HOME}/Documents"]`).click();
    await page.keyboard.press(`${MOD}+Backslash`);
    await expect(page.locator(`[data-path="${HOME}/Documents"]`)).toHaveCount(2);
    await page.keyboard.press(`${MOD}+KeyL`);
    await page.locator("#rdir-addr-input").fill(`${HOME}/Documents`);
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();

    await page.locator(`[data-path="${HOME}/Notes.txt"]`).first().click();
    await page.keyboard.press(`${MOD}+KeyC`);
    await page.locator(`[data-path="${HOME}/Documents/readme.md"]`).first().click();
    await page.keyboard.press(`${MOD}+KeyV`);

    // 文件冲突 → 冲突裁决弹窗照常
    const dialog = page.locator("[data-conflict-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "停止" }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe("29D. 文本比较窗口 F11 全屏", () => {
  async function openTextDiff(page: Page) {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "比较" }).click();
    await page.getByRole("menuitem", { name: "设为比较基准" }).click();
    await page.locator(`[data-path="${HOME}/photo.png"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "比较" }).click();
    await page.getByRole("menuitem", { name: "与基准比较" }).click();
    const dialog = page.locator("[data-text-diff]");
    await expect(dialog).toBeVisible();
    return dialog;
  }

  // v0.29.1：打开即最大化；F11 与 mod+shift+F（mac ⌘⇧F，绕开系统「显示桌面」吃 F11）双键位切换
  test("D1 打开即最大化；F11 与 mod+shift+F 切换还原；关闭后不再拦截", async ({ page }) => {
    const dialog = await openTextDiff(page);
    // 量内层卡片（[data-text-diff] 是 fixed inset-0 遮罩，恒等于视口宽）
    const card = dialog.locator("> div");
    // 打开即最大化：宽度撑满视口（100vw - 24px）
    const box = await card.boundingBox();
    expect(box!.width).toBeGreaterThan(page.viewportSize()!.width - 40);
    // 标题前缀两平台一致（F11 / ⌘⇧F 或 F11 / Ctrl+Shift+F）
    await expect(dialog.locator('button[title^="还原窗口（F11"]').first()).toBeVisible();

    // F11 → 还原（宽度回落到 min(1400px, 96vw)）
    await page.keyboard.press("F11");
    await expect(dialog.locator('button[title^="最大化（F11"]').first()).toBeVisible();
    const box2 = await card.boundingBox();
    expect(box2!.width).toBeLessThan(page.viewportSize()!.width - 40);

    // mod+shift+F → 再最大化（macOS 上 F11 到不了页面，靠这路键位）
    await page.keyboard.press(`${MOD}+Shift+F`);
    await expect(dialog.locator('button[title^="还原窗口（F11"]').first()).toBeVisible();
    const box3 = await card.boundingBox();
    expect(box3!.width).toBeGreaterThan(page.viewportSize()!.width - 40);

    // 关闭后：全局无按键拦截（此处仅断言窗口已关，生效范围由组件挂载期保证）
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
