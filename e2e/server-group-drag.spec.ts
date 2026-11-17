import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 侧栏「服务器拖到分组」Windows 指针链回归（dts feat-sidebar_server-drag-to-group-broken）：
 * v0.34.0 起 tauri.windows.conf.json dragDropEnabled:true 让 wry 接管 WebView2 OLE 拖放，
 * HTML5 dragover/drop 不进页面，纯 HTML5 的换组链在真壳静默失效（Chromium e2e 一直假绿）。
 * 修复照抄 SplitView 窗格头方案：指针链合成 DragEvent（见 Sidebar.tsx 顶部注释）。
 * 本文件 addInitScript 预置 rdir.e2e.force-native-drag 强制 canPointerDnd()=true，
 * 用真实鼠标序列覆盖指针链路径；默认环境的 HTML5 路径由 optimizations-31 31E 继续覆盖。
 */

const HOME = "/mock/home";

test.beforeEach(async ({ page }) => {
  // 必须在应用脚本运行前预置：canPointerDnd() 实时读 sessionStorage
  await page.addInitScript(() => {
    sessionStorage.setItem("rdir.e2e.force-native-drag", "1");
  });
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
});

function serverRow(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}
function groupHeader(page: Page, group: string) {
  return page.locator(`[data-server-group="${group}"]`);
}
async function mockState(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __RDIR_E2E_MOCK__: {
            sftpSetGroup: { ids: string[]; group: string }[];
            sftpConnects: string[];
          };
        }
      ).__RDIR_E2E_MOCK__,
  );
}
/** 经「编辑 → 仅保存」把服务器归到指定组（造第二组；保存不连接，同 31E 前置） */
async function setGroupViaEdit(page: Page, server: string, group: string) {
  await serverRow(page, server).click({ button: "right" });
  await page.locator('[data-slot="context-menu-content"]').getByText("编辑…").click();
  const groupInput = page.locator('input[placeholder*="分组"]');
  await expect(groupInput).toBeVisible();
  await groupInput.fill(group);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(groupInput).toHaveCount(0);
  await expect(groupHeader(page, group)).toContainText("1");
}
/** 捕获阶段取消 dragstart 兜底：防 Chromium 在 draggable 行上起原生 HTML5 拖拽后
 *  mousemove 停发（行自身 onDragStart 的 preventDefault 是主保险，这是双保险，
 *  与 drag-ghost.spec 引擎 A 同套路；不影响合成 dragstart 的派发与消费） */
async function killNativeDragstart(page: Page) {
  await page.evaluate(() => {
    window.addEventListener("dragstart", (e) => e.preventDefault(), true);
  });
}

test.describe("侧栏服务器拖拽换组（Windows 指针链）", () => {
  test("真鼠标拖服务器到分组名 → 换组成功、悬停高亮、后端收到换组", async ({ page }) => {
    await setGroupViaEdit(page, "测试机", "工作站");
    await killNativeDragstart(page);

    const row = serverRow(page, "生产机");
    await row.scrollIntoViewIfNeeded();
    const header = groupHeader(page, "工作站");
    await header.scrollIntoViewIfNeeded();
    const rb = (await row.boundingBox())!;
    const gb = (await header.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2, { steps: 10 });

    // 起拖视觉：源行半透明（对齐窗格交换 opacity-60）；悬停工作站组头：dragOverGroup 高亮亮起
    await expect(row).toHaveCSS("opacity", "0.6");
    await expect(header).toHaveClass(/ring-primary\/40/);

    await page.mouse.up();

    await expect(header).toContainText("2");
    await expect(groupHeader(page, "默认")).toHaveCount(0);
    await expect(row).toHaveCSS("opacity", "1");
    const mock = await mockState(page);
    expect(mock.sftpSetGroup).toEqual([{ ids: ["u@127.0.0.1:22"], group: "工作站" }]);
  });

  test("拖拽途中按 Esc → 取消：不换组、高亮与源行透明度还原，后续点击仍正常连接", async ({
    page,
  }) => {
    await setGroupViaEdit(page, "测试机", "工作站");
    await killNativeDragstart(page);

    const row = serverRow(page, "生产机");
    await row.scrollIntoViewIfNeeded();
    const header = groupHeader(page, "工作站");
    await header.scrollIntoViewIfNeeded();
    const rb = (await row.boundingBox())!;
    const gb = (await header.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2, { steps: 10 });
    await expect(row).toHaveCSS("opacity", "0.6");
    await expect(header).toHaveClass(/ring-primary\/40/);

    await page.keyboard.press("Escape");

    await expect(row).toHaveCSS("opacity", "1");
    await expect(header).not.toHaveClass(/ring-primary\/40/);
    await expect(groupHeader(page, "默认")).toContainText("1");
    expect((await mockState(page)).sftpSetGroup).toEqual([]);

    // 取消不吃点击：点生产机仍正常直连（有存盘密码）
    await row.click();
    await expect
      .poll(async () => (await mockState(page)).sftpConnects)
      .toContain("u@127.0.0.1:22");
  });

  test("拖放结束的收拢 click 被抑制 → 不误触连接；主动点击恢复生效", async ({ page }) => {
    await setGroupViaEdit(page, "测试机", "工作站");
    await killNativeDragstart(page);

    const row = serverRow(page, "生产机");
    await row.scrollIntoViewIfNeeded();
    const header = groupHeader(page, "工作站");
    await header.scrollIntoViewIfNeeded();
    const rb = (await row.boundingBox())!;
    const gb = (await header.boundingBox())!;

    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2, { steps: 10 });
    await page.mouse.up();

    await expect(header).toContainText("2");
    // 指针捕获把松手落点收回源行，down+up 组合会合成一个 click —— 不得触发连接
    expect((await mockState(page)).sftpConnects).toEqual([]);

    // suppressClickRef 已在下一宏任务复位：主动点击恢复正常直连
    await row.click();
    await expect
      .poll(async () => (await mockState(page)).sftpConnects)
      .toContain("u@127.0.0.1:22");
  });
});
