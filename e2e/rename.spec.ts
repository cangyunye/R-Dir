import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
});

test.describe("主列表重命名", () => {
  test("右键→重命名→回车提交：列表出现新名", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();

    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    await input.fill("Renamed.txt");
    await input.press("Enter");

    await expect(page.locator(`[data-path="${HOME}/Renamed.txt"]`)).toBeVisible();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);
  });

  test("右键→重命名→点击其他行提交（失焦提交）", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();

    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await input.fill("Blurred.txt");
    // 点击其他行触发失焦提交
    await page.locator(`[data-path="${HOME}/photo.png"]`).click();
    await expect(page.locator(`[data-path="${HOME}/Blurred.txt"]`)).toBeVisible();
  });

  test("F2 重命名 → 回车提交", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press("F2");
    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    await input.fill("F2ed.txt");
    await input.press("Enter");
    await expect(page.locator(`[data-path="${HOME}/F2ed.txt"]`)).toBeVisible();
  });
});

test.describe("重命名框内鼠标拖选（v0.41.2 回归）", () => {
  /** 在重命名输入框文本中段按下并拖动 40px（跨过 5px 拖拽阈值），断言：
   *  拖拽中途文件拖拽幽灵未显形、松手后留下文本选区、会话未被拖拽打断 */
  async function dragSelectInsideRenameInput(
    page: import("@playwright/test").Page,
    input: import("@playwright/test").Locator,
  ) {
    await expect(input).toBeVisible();
    // 起手安定窗口：重试聚焦链在 0/120/300/600/1000ms 补焦点，已持焦时全部跳过不动选区
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();
    const box = await input.boundingBox();
    if (!box) throw new Error("重命名输入框无几何信息");
    const startX = box.x + 20;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(startX + i * 8, y);
    // 拖拽中途：文件拖拽幽灵标签（「复制 N 项」）必须仍未显形——
    // 旧实现会在这里升级成文件拖拽（幽灵显形 + select-none 掐断框内选区）
    const ghostOpacity = await page.evaluate(() => {
      const ghost = [...document.querySelectorAll("div")].find(
        (d) =>
          d.className.includes("pointer-events-none") &&
          /^复制 \d+ 项$/.test(d.textContent ?? ""),
      );
      return ghost ? getComputedStyle(ghost).opacity : "missing";
    });
    expect(ghostOpacity).toBe("0");
    await page.mouse.up();
    const selLen = await input.evaluate(
      (el) => (el as HTMLInputElement).selectionEnd - (el as HTMLInputElement).selectionStart,
    );
    expect(selLen).toBeGreaterThan(0);
    // 拖选不结束重命名会话（点框外才会收口）
    await expect(input).toBeVisible();
  }

  test("详情列表：框内按住左键拖动 = 文本选区而非文件拖拽", async ({ page }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();
    await dragSelectInsideRenameInput(page, page.locator(`[data-path="${HOME}/Notes.txt"] input`));
  });

  test("大图标网格：框内按住左键拖动 = 文本选区而非位置拖拽", async ({ page }) => {
    await page.keyboard.press("Alt+2");
    const item = page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`);
    await expect(item).toBeVisible();
    await item.click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();
    await dragSelectInsideRenameInput(page, item.locator("input"));
  });

  test("F2 后立即框内拖选：重试聚焦链不重置选区（v0.48 用户实测回归点）", async ({ page }) => {
    // 用户真实场景：F2 后不等安定窗口立刻在框内拖选。接管的 mousedown
    // preventDefault 会取消原生聚焦，重试聚焦链（120–1000ms）若在拖选期间
    // 补 select() 会把选区整个重置——everPressedRef 守卫回归点。
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press("F2");
    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    if (!box) throw new Error("重命名输入框无几何信息");
    const y = box.y + box.height / 2;
    const x0 = box.x + 8;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x0 + i * 8, y);
    await page.mouse.up();
    const selLen = await input.evaluate(
      (el) => (el as HTMLInputElement).selectionEnd - (el as HTMLInputElement).selectionStart,
    );
    expect(selLen).toBeGreaterThan(0);
    // 静置跨过整个重试聚焦链（至 1000ms）后选区必须保持原样
    await page.waitForTimeout(1100);
    const selLen2 = await input.evaluate(
      (el) => (el as HTMLInputElement).selectionEnd - (el as HTMLInputElement).selectionStart,
    );
    expect(selLen2).toBe(selLen);
    await expect(input).toBeVisible();
  });

  test("F2 后在重命名行（输入框外的列区域）按下拖动：准心路由进输入框而非文件拖拽（v0.48.1）", async ({
    page,
  }) => {
    // 用户实测：F2 后光标停在点选文件时的旧位置（可能不在名称列），行上按压
    // 旧代码会升级成文件拖拽，拖经列表松在同目录触发覆盖确认。修复=重命名行
    // 上的左键按压一律路由进输入框（准心激活）。
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click();
    await page.keyboard.press("F2");
    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    await expect(input).toBeVisible();
    const rowBox = await page.locator(`[data-path="${HOME}/Notes.txt"]`).boundingBox();
    const inputBox = await input.boundingBox();
    if (!rowBox || !inputBox) throw new Error("无几何信息");
    expect(inputBox.x + inputBox.width).toBeLessThan(rowBox.x + rowBox.width - 8);
    // 行右端（输入框覆盖不到的列区域）按下并向左拖
    const px = rowBox.x + rowBox.width - 24;
    const py = rowBox.y + rowBox.height / 2;
    await page.mouse.move(px, py);
    await page.mouse.down();
    // 一路拖进文本起点（按压点在文本末端之外，偏移被钳到串尾；左拖穿越文本才会扩展）
    await page.mouse.move(inputBox.x + 12, py, { steps: 8 });
    // 拖动中途读选区：路由后的手动扩展必须产生非空选区（用户的核心诉求）
    const mid = await input.evaluate((el) => [el.selectionStart, el.selectionEnd]);
    await page.mouse.up();
    const st = await input.evaluate((el) => ({
      focused: document.activeElement === el,
      sel: [el.selectionStart, el.selectionEnd],
    }));
    const aeInfo = await page.evaluate((sel) => {
      const a = document.activeElement as HTMLElement | null;
      return {
        tag: a?.tagName ?? null,
        dp: a?.closest("[data-path]")?.getAttribute("data-path") ?? null,
        renamingInputAlive: !!document.querySelector(`${sel} input`),
      };
    }, `[data-path="${HOME}/Notes.txt"]`);
    expect(mid[1] - mid[0]).toBeGreaterThan(0); // 拖选扩展生效
    expect(st.focused).toBe(true);
    expect(aeInfo.renamingInputAlive).toBe(true);
    // 无文件拖拽幽灵、无覆盖确认弹窗
    await expect(page.locator("[data-app-confirm]")).toHaveCount(0);
    await expect(input).toBeVisible();
  });
});

test.describe("分屏重命名（窗格隔离）", () => {
  test("上下分屏同目录：在上窗格重命名，编辑框只出现一份且属于上窗格", async ({ page }) => {
    // 应用菜单 → 上下分屏：原窗格成为上（node.a），新窗格在下——两窗格默认同目录
    await page.getByTitle("应用菜单").click();
    await page.getByRole("menuitem", { name: "上下分屏" }).click();
    const rows = page.locator(`[data-path="${HOME}/Notes.txt"]`);
    await expect(rows).toHaveCount(2);
    // 上窗格（DOM 顺序第一 = 先打开的原窗格）右键 → 重命名
    await rows.first().click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();
    const input = page.locator(`[data-path="${HOME}/Notes.txt"] input`);
    // 修复前：renaming 未按窗格过滤，两侧行同 path 双命中，编辑框渲染两份、
    // 焦点竞争落到后挂载的下窗格
    await expect(input).toHaveCount(1);
    const [top, bottom, box] = await Promise.all([
      rows.nth(0).boundingBox(),
      rows.nth(1).boundingBox(),
      input.boundingBox(),
    ]);
    if (!top || !bottom || !box) throw new Error("几何信息缺失");
    expect(box.y).toBeLessThan(bottom.y); // 编辑框在上窗格区域内
    // 改名提交走原链路：发起窗格刷新出现新名
    await page.waitForTimeout(400);
    await input.fill("Split.txt");
    await input.press("Enter");
    await expect(page.locator(`[data-path="${HOME}/Split.txt"]`)).toHaveCount(1);
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"] input`)).toHaveCount(0);
  });
});
