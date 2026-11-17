import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 重命名光标态按拖 = 文本拖选，不被行文件拖拽劫持（dts feat-rename_rename-caret-drag-becomes-file-drag）。
 *
 * 根因：v0.49 BUG2（54f7c3b）的「重命名会话 draggable=false」关源硬化只加在 IconGrid，
 * FileList 行 `draggable="true"` 无条件写死——输入框内光标态（无选中）按拖时 Blink 沿
 * 祖先链找到 draggable 行起原生拖拽，框内拖选被「文件拖动」劫持（真壳实测 dragstart
 * 触发、选区不动）。修复 = FileList 行对齐 `draggable={renaming?.path !== entry.path}`。
 *
 * page.mouse 本不走浏览器拖拽状态机（CDP 注入），必须 Input.setInterceptDrags 才与
 * 真硬件鼠标等效（同 tools/drag-intercept-probe.mjs 手法）。
 */

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
});

/** 光标态按拖（在文本区域内按住向左拖 25px） */
async function caretPressDrag(page: Page) {
  const row = page.locator(`[role="row"][data-path="${HOME}/Notes.txt"]`);
  await row.click();
  await page.keyboard.press("F2");
  const input = row.locator("input");
  await expect(input).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.setInterceptDrags", { enabled: true });
  await page.evaluate(() => {
    (window as unknown as { __ds: number }).__ds = 0;
    window.addEventListener("dragstart", () => (window as unknown as { __ds: number }).__ds++, true);
  });

  // 单击塌缩成光标（F2 后是全选态；用户场景 = 只有光标没有选中）
  const box = (await input.boundingBox())!;
  await input.click({ position: { x: 42, y: box.height / 2 } });
  await expect
    .poll(() => input.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([expect.any(Number), expect.any(Number)]);
  const caret = await input.evaluate((el) => [el.selectionStart, el.selectionEnd]);

  // 按住向左拖：修复前 → 行 dragstart（文件拖动劫持）、选区不动；修复后 → 原生拖选出新选区
  const x = box.x + 35;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 25, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const st = await input.evaluate((el) => ({
    ds: (window as unknown as { __ds: number }).__ds,
    sel: [el.selectionStart, el.selectionEnd],
    focused: document.activeElement === el,
  }));
  expect(st.ds).toBe(0); // 没有任何 dragstart = 没被行文件拖拽劫持
  expect(st.focused).toBe(true);
  expect(st.sel[0]).not.toBe(st.sel[1]); // 拖出了非空文本选区
  expect(st.sel).not.toEqual(caret); // 且与塌缩光标位不同
  await cdp.send("Input.setInterceptDrags", { enabled: false });
  await page.keyboard.press("Escape");
}

test("重命名光标态按拖：无 dragstart、拖出文本选区（FileList 补齐 draggable 关源）", async ({
  page,
}) => {
  await caretPressDrag(page);
});
