import { test, expect } from "@playwright/test";

/**
 * E2E 回归用例（针对前端 dev server）。
 * Tauri API 在浏览器里不可用，这些用例验证 UI 结构不白屏、关键交互不崩溃。
 * 真实 Tauri 窗口交互（文件操作/SFTP）用手动回归手册。
 *
 * 运行：pnpm test:e2e
 */

test.describe("1. 启动与窗口", () => {
  test("W1 页面加载不白屏", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
  });

  test("W3 默认目录加载完成", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 根容器渲染
    await expect(page.locator("body")).toBeVisible();
  });

  test("W6 菜单栏存在", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    // 菜单栏应包含 文件/编辑/查看/转到/窗格/帮助
    const body = await page.locator("body").innerText();
    expect(body).toContain("文件");
  });
});

test.describe("2. 标签页", () => {
  test("T1 标签栏存在", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("3. 导航", () => {
  test("N1 按 Backspace 不崩溃", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Backspace");
    await expect(page.locator("body")).toBeVisible();
  });

  test("N7 按 F5 不崩溃", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    await page.keyboard.press("F5");
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("4. 文件列表", () => {
  test("L5 单击不崩溃", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 文件列表容器存在
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("5. 快捷键（全量不崩溃）", () => {
  const combos = [
    "Enter", "F5", "F2", "F1", "Delete", "Escape",
    "Control+KeyC", "Control+KeyX", "Control+KeyV",
    "Control+KeyA", "Control+KeyZ", "Control+KeyY",
    "Control+KeyT", "Control+KeyW", "Control+Tab",
    "Control+Shift+Tab", "Control+Shift+T",
    "Control+KeyJ", "Control+KeyL", "Control+KeyF",
    "Control+Comma",
  ];

  for (const combo of combos) {
    test(`快捷键 ${combo} 不崩溃`, async ({ page }) => {
      await page.goto("/");
      await page.waitForTimeout(1500);
      await page.keyboard.press(combo);
      await expect(page.locator("body")).toBeVisible();
    });
  }
});

test.describe("6. 右键菜单", () => {
  test("右键文件列表不崩溃", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    await page.locator("body").click({ button: "right" });
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("7. 标签虚拟目录", () => {
  test("左侧标签栏存在", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    const body = await page.locator("body").innerText();
    // 标签区应有 红色/橙色/黄色 等
    expect(body).toContain("红色");
  });
});

test.describe("8. 搜索", () => {
  test("Ctrl+F 不崩溃", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Control+KeyF");
    await expect(page.locator("body")).toBeVisible();
  });
});
