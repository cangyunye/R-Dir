import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.34.1 补充回归：此前三条主流程零 e2e 覆盖——
 * 1) 撤销 / 重做（README 头条功能，回滚错了即丢文件）
 * 2) 右键「压缩为 → zip」（archive-extract.spec 只测了解压）
 * 3) Alt=移动 跨窗格拖放（破坏性：源删除；此前只测了默认复制）
 */

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const UNDO = `${MOD}+z`;
const REDO = process.platform === "darwin" ? "Meta+Shift+z" : "Control+y";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  // 启动闪屏（fixed inset-0 z-9999）1.1s 后退场；覆盖期间 elementFromPoint
  // 命中的是闪屏而不是列表行，拖放/右键类断言必须等它消失
  await page
    .locator("div.z-\\[9999\\]")
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
});

/** 右键列表空白处（底部区域，避开条目行） */
async function rightClickBlank(page: Page) {
  const body = page.locator("[data-filelist-body]").first();
  const box = (await body.boundingBox())!;
  await body.click({ button: "right", position: { x: 120, y: box.height - 14 } });
}

type Mock = {
  copyPlans: { paths: string[]; dest: string }[];
  movePlans: { paths: string[]; dest: string }[];
  compressCalls: { paths: string[]; targetDir: string; format: string }[];
};
const mock = (page: Page) =>
  page.evaluate(() => (window as unknown as { __RDIR_E2E_MOCK__: Mock }).__RDIR_E2E_MOCK__);

/**
 * 合成 HTML5 拖放（与 smoke.spec 的 synthDrag 同构，多了 altKey 与目标窗格索引）：
 * dragstart 落在源行上让行内 onDragStart 写入 dataTransfer，dragover/drop 派发到 window
 * （App 的监听位），坐标取目标元素中心供 dropTargetAt 命中。
 */
function synthDrag(
  page: Page,
  srcSel: string,
  dst: { paneIndex: number; sel: string },
  opts: { altKey?: boolean } = {},
) {
  return page.evaluate(
    ({ srcSel, dst, altKey }) => {
      const src = document.querySelector(srcSel)!;
      const pane = document.querySelectorAll("[data-pane-id]")[dst.paneIndex]!;
      const target = pane.querySelector(dst.sel)!;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const r = target.getBoundingClientRect();
      const o = {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        altKey: !!altKey,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      window.dispatchEvent(new DragEvent("dragover", o));
      window.dispatchEvent(new DragEvent("drop", o));
      src.dispatchEvent(new DragEvent("dragend", o));
    },
    { srcSel, dst, altKey: opts.altKey },
  );
}

test.describe("U. 撤销 / 重做", () => {
  test("U1 新建文件夹 → 撤销条目消失 → 重做条目恢复", async ({ page }) => {
    await rightClickBlank(page);
    await page.locator('[data-slot="context-menu-content"]').getByText("新建文件夹").click();
    const created = page.locator(`[data-path="${HOME}/新建文件夹"]`);
    await expect(created).toBeVisible();
    // 行内重命名默认进入；Esc 保留默认名（RenameInput 内 stopPropagation，不触发全局 clearSelection）
    const input = created.locator("input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await input.press("Escape");
    await expect(created).toBeVisible();
    await expect(created.locator("input")).toHaveCount(0);

    await page.keyboard.press(UNDO);
    await expect(created).toHaveCount(0);

    await page.keyboard.press(REDO);
    await expect(created).toBeVisible();
  });

  test("U2 重命名 → 撤销还原旧名 → 重做再次改名", async ({ page }) => {
    const notes = page.locator(`[data-path="${HOME}/Notes.txt"]`);
    await notes.click({ button: "right" });
    await page.getByRole("menu").getByText("重命名").click();
    const input = notes.locator("input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(400);
    await input.fill("Renamed.txt");
    await input.press("Enter");
    const renamed = page.locator(`[data-path="${HOME}/Renamed.txt"]`);
    await expect(renamed).toBeVisible();
    await expect(notes).toHaveCount(0);

    await page.keyboard.press(UNDO);
    await expect(notes).toBeVisible();
    await expect(renamed).toHaveCount(0);

    await page.keyboard.press(REDO);
    await expect(renamed).toBeVisible();
    await expect(notes).toHaveCount(0);
  });

  test("U3 空栈撤销无副作用（不报错、列表不变）", async ({ page }) => {
    const before = await page.locator("[data-path]").allInnerTexts();
    await page.keyboard.press(UNDO);
    await page.keyboard.press(REDO);
    await page.waitForTimeout(200);
    expect(await page.locator("[data-path]").allInnerTexts()).toEqual(before);
    await expect(page.locator("[data-toast][data-variant='error']")).toHaveCount(0);
  });
});

test.describe("Z. 压缩为 zip", () => {
  test("Z1 右键文件 → 压缩为 → zip：后端收到 (paths, 当前目录, zip)，列表出现 Notes.zip", async ({
    page,
  }) => {
    await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await expect(menu).toBeVisible();
    await menu.locator('[data-testid="menu-group-compress"]').click();
    await menu.getByRole("menuitem", { name: "zip", exact: true }).click();

    await expect
      .poll(async () => (await mock(page)).compressCalls.at(-1), { timeout: 5000 })
      .toMatchObject({ paths: [`${HOME}/Notes.txt`], targetDir: HOME, format: "zip" });
    await expect(page.locator(`[data-path="${HOME}/Notes.zip"]`)).toBeVisible();
  });

  test("Z2 多选压缩：两项一起进同一归档调用", async ({ page }) => {
    const notes = page.locator(`[data-path="${HOME}/Notes.txt"]`);
    const photo = page.locator(`[data-path="${HOME}/photo.png"]`);
    await notes.click();
    await photo.click({ modifiers: [MOD] });
    await photo.click({ button: "right" });
    const menu = page.locator('[data-slot="context-menu-content"]');
    await menu.locator('[data-testid="menu-group-compress"]').click();
    await menu.getByRole("menuitem", { name: "zip", exact: true }).click();

    await expect
      .poll(async () => (await mock(page)).compressCalls.at(-1), { timeout: 5000 })
      .toMatchObject({ paths: [`${HOME}/Notes.txt`, `${HOME}/photo.png`], format: "zip" });
  });
});

test.describe("M. Alt=移动 跨窗格拖放", () => {
  test("M1 按住 Alt 拖到另一窗格的目录行 → move_entries_plan，源消失、目标目录出现；默认复制链路未触发", async ({
    page,
  }) => {
    await page.keyboard.press(`${MOD}+Backslash`);
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
    const docsSel = `[data-path="${HOME}/Documents"]`;
    const copyBefore = (await mock(page)).copyPlans.length;

    await synthDrag(page, `[data-path="${HOME}/Notes.txt"]`, { paneIndex: 1, sel: docsSel }, { altKey: true });

    await expect
      .poll(async () => (await mock(page)).movePlans.at(-1), { timeout: 5000 })
      .toMatchObject({ paths: [`${HOME}/Notes.txt`], dest: `${HOME}/Documents` });
    expect((await mock(page)).copyPlans.length).toBe(copyBefore);
    // 源目录不再有 Notes.txt。非活动窗格（keep-alive）的陈旧列表要等激活时
    // 按 refreshKey 失配重读——先点回窗格 1 触发重载再断言
    await page.locator("[data-pane-id]").first().locator(docsSel).click();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);
    // 进入 Documents 能看到被移入的文件
    await page.locator("[data-pane-id]").first().locator(docsSel).dblclick();
    await expect(
      page.locator("[data-pane-id]").first().locator(`[data-path="${HOME}/Documents/Notes.txt"]`),
    ).toBeVisible();
  });

  test("M2 移动后撤销：文件回到源目录", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Backslash`);
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
    const docsSel = `[data-path="${HOME}/Documents"]`;
    await synthDrag(page, `[data-path="${HOME}/Notes.txt"]`, { paneIndex: 1, sel: docsSel }, { altKey: true });
    // 激活窗格 1 重读陈旧列表后再断言（keep-alive 语义，见 M1 注释）
    await page.locator("[data-pane-id]").first().locator(docsSel).click();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toHaveCount(0);

    await page.keyboard.press(UNDO);
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`).first()).toBeVisible();
  });

  test("M3 不按 Alt 拖到另一窗格目录行 = 复制：源保留、走 copy_entries_plan", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Backslash`);
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
    const docsSel = `[data-path="${HOME}/Documents"]`;
    const moveBefore = (await mock(page)).movePlans.length;

    await synthDrag(page, `[data-path="${HOME}/Notes.txt"]`, { paneIndex: 1, sel: docsSel });

    await expect
      .poll(async () => (await mock(page)).copyPlans.at(-1), { timeout: 5000 })
      .toMatchObject({ paths: [`${HOME}/Notes.txt`], dest: `${HOME}/Documents` });
    expect((await mock(page)).movePlans.length).toBe(moveBefore);
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`).first()).toBeVisible();
  });
});
