import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * v0.44.0 回归：
 * 1) 分屏表头：名称列固定宽改 minmax(0, W)（窄窗格名称先收缩，后续列不被挤出）；
 *    列宽拖拽按 rect/offsetWidth 换算 zoom（Chromium/WebView2 不再把宽度放大）；
 * 2) 左侧导航栏收缩为图标栏（标题栏按钮 / 栏底按钮 / mod+e，跨重启保留），
 *    收缩态远程服务器只显示图标、点击只提示展开；
 * 3) SFTP↔SFTP 经远程临时目录中转（拖拽带同名覆盖确认；粘贴回源目录跳过）。
 */

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const REMOTE = "sftp://u@127.0.0.1:22/remote";

type Relay = { src: string; destDir: string; name: string; localDir: string | null };
const relays = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __RDIR_E2E_MOCK__: { relays: Relay[] } }).__RDIR_E2E_MOCK__.relays,
  );
const sftpConnects = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __RDIR_E2E_MOCK__: { sftpConnects: string[] } }).__RDIR_E2E_MOCK__
        .sftpConnects,
  );

/** 合成 HTML5 拖放（与 smoke.spec 的 synthDrag 同构）：dragstart 落源行，dragover/drop 派发到 window */
function synthDrag(page: Page, srcSel: string, dstSel: string) {
  return page.evaluate(
    ({ srcSel, dstSel }) => {
      const src = document.querySelector(srcSel)!;
      const dst = document.querySelector(dstSel)!;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const r = dst.getBoundingClientRect();
      const o = {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      window.dispatchEvent(new DragEvent("dragover", o));
      window.dispatchEvent(new DragEvent("drop", o));
      src.dispatchEvent(new DragEvent("dragend", o));
    },
    { srcSel, dstSel },
  );
}

async function boot(page: Page, storage: Record<string, string> = {}) {
  await installTauriMock(page);
  if (Object.keys(storage).length > 0) {
    await page.addInitScript((kv) => {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    }, storage);
  }
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
}

test.describe("44A. 分屏表头：名称列可收缩 + zoom 换算", () => {
  test("根 zoom 15/13 下拖名称列分隔线：列宽视觉变化与鼠标位移一致（不再放大）", async ({ page }) => {
    await boot(page, { "rfm.ui-font": "15" });
    const handle = page.locator("[data-name-col-resize]").first();
    const cell = handle.locator("xpath=..");
    const h = (await handle.boundingBox())!;
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    // 启动 splash（fixed z-[9999]，淡出约 1.4s）期间裸 mouse 事件会打在遮罩上：
    // 等命中测试真正落到分隔线再拖（click() 有可操作性等待，page.mouse 没有）
    await expect
      .poll(() =>
        page.evaluate(
          ({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[data-name-col-resize]"),
          { x, y },
        ),
      )
      .toBe(true);
    const before = (await cell.boundingBox())!;
    // 自动列宽下名称列已占满剩余空间，向左拖（收窄）才能观察真实位移
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 120, y, { steps: 6 });
    await page.mouse.up();
    const after = (await cell.boundingBox())!;
    // 旧实现：起点取视觉宽当布局宽存，宽度先被放大 (zoom−1) 倍，收窄量远小于 120
    expect(Math.abs(before.width - after.width - 120)).toBeLessThan(4);
  });

  test("拖宽过的名称列在左右分屏后自动收缩：两窗格表头 5 列都在窗格内", async ({ page }) => {
    await boot(page, { "rdir.nameColW": "1100" });
    await page.keyboard.press(`${MOD}+Backslash`);
    const panes = page.locator("[data-pane-id]");
    await expect(panes).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const pane = panes.nth(i);
      const header = pane.locator("[data-name-col-resize]").locator("xpath=../..");
      const cells = header.locator(":scope > button");
      await expect(cells).toHaveCount(5);
      const paneBox = (await pane.boundingBox())!;
      const last = (await cells.nth(4).boundingBox())!;
      // 「权限」列完整落在窗格右边界内（旧实现 1100px 名称列把后 4 列挤出可视区）
      expect(last.x + last.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
      expect(last.width).toBeGreaterThan(40);
      await expect(cells.nth(1)).toBeInViewport();
    }
  });
});

test.describe("44B. 左侧导航栏收缩为图标栏", () => {
  test("标题栏按钮收起 → 仅图标、刷新后保持 → mod+e 展开", async ({ page }) => {
    await boot(page);
    const sidebar = page.locator("[data-sidebar]");
    await expect(sidebar.getByText("快速访问")).toBeVisible();
    await page.getByTestId("sidebar-app-toggle").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "");
    await expect(sidebar.getByText("快速访问")).toHaveCount(0);
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(70);

    // 收缩态快速访问图标仍可导航（title = 名称 + 路径）
    await sidebar.locator('button[title^="下载"]').click();
    await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();

    await page.reload();
    await expect(page.locator("[data-path]").first()).toBeVisible();
    await expect(page.locator("[data-sidebar]")).toHaveAttribute("data-collapsed", "");

    await page.locator("[data-filelist-body]").first().click();
    await page.keyboard.press(`${MOD}+KeyE`);
    await expect(page.locator("[data-sidebar]")).not.toHaveAttribute("data-collapsed", /.*/);
    await expect(page.locator("[data-sidebar]").getByText("快速访问")).toBeVisible();
  });

  test("收缩态远程服务器：只显示图标，点击只提示展开、不连接；栏底按钮展开后可正常连接", async ({ page }) => {
    await boot(page);
    await page.getByTestId("sidebar-app-toggle").click();
    const rows = page.locator("[data-sidebar-server-collapsed]");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("[data-sidebar]").getByText("生产机")).toHaveCount(0);
    // aria-disabled：真实浏览器照常派发点击（提示才出得来），Playwright 的可操作性检查
    // 却把它当禁用拒点——force 跳过检查，验证的正是「点了只提示」
    await rows.first().click({ force: true });
    await expect(page.locator("[data-toast]")).toContainText("展开侧边栏后查看远程服务器");
    expect(await sftpConnects(page)).toEqual([]);
    await expect(page.locator('[data-path^="sftp://"]')).toHaveCount(0);

    await page.getByTestId("sidebar-collapse-toggle").click();
    await expect(page.locator("[data-sidebar]")).not.toHaveAttribute("data-collapsed", /.*/);
    await page.getByRole("button", { name: "生产机" }).click();
    await expect(page.locator(`[data-path="${REMOTE}/deploy.sh"]`)).toBeVisible();
  });
});

test.describe("44C. SFTP↔SFTP 经临时目录中转", () => {
  test("拖到同服务器子目录：中转上传；再拖一次同名 → 覆盖上传确认", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: "生产机" }).click();
    const src = `[data-path="${REMOTE}/deploy.sh"]`;
    const logs = `[data-path="${REMOTE}/logs"]`;
    await expect(page.locator(src)).toBeVisible();

    await synthDrag(page, src, logs);
    await expect
      .poll(async () => (await relays(page)).at(-1), { timeout: 5000 })
      .toMatchObject({ src: `${REMOTE}/deploy.sh`, destDir: `${REMOTE}/logs`, name: "deploy.sh" });
    // 不删源（远程语义按复制）
    await expect(page.locator(src)).toBeVisible();

    await synthDrag(page, src, logs);
    const dlg = page.locator("[data-app-confirm]");
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("覆盖上传");
    await expect(dlg).toContainText("deploy.sh");
    await dlg.getByRole("button", { name: "覆盖" }).click();
    await expect.poll(async () => (await relays(page)).length, { timeout: 5000 }).toBe(2);
  });

  test("复制后粘贴回源目录 = 跳过并提示；进入子目录粘贴 = 中转", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: "生产机" }).click();
    await page.locator(`[data-path="${REMOTE}/deploy.sh"]`).click();
    await page.keyboard.press(`${MOD}+KeyC`);

    await page.keyboard.press(`${MOD}+KeyV`);
    await expect(page.locator("[data-statusbar]")).toContainText("远程复制暂不支持（可拖拽到其他窗格）");
    expect(await relays(page)).toEqual([]);

    await page.locator(`[data-path="${REMOTE}/logs"]`).dblclick();
    await expect(page.locator(`[data-path="${REMOTE}/deploy.sh"]`)).toHaveCount(0);
    await page.locator("[data-filelist-body]").first().click();
    await page.keyboard.press(`${MOD}+KeyV`);
    await expect
      .poll(async () => (await relays(page)).at(-1), { timeout: 5000 })
      .toMatchObject({ src: `${REMOTE}/deploy.sh`, destDir: `${REMOTE}/logs`, name: "deploy.sh" });
    await expect(page.locator(`[data-path="${REMOTE}/logs/deploy.sh"]`)).toBeVisible();
  });

  // v0.48 粘贴到远程撞名：与本地粘贴同一套冲突裁决弹窗（覆盖/全部覆盖/改名/停止）
  test("粘贴到远程撞名 → 冲突弹窗：停止不传 / 改名落新名 / 覆盖重传", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: "生产机" }).click();
    // 先拖一份 deploy.sh 进 logs 作为已存在条目
    await synthDrag(page, `[data-path="${REMOTE}/deploy.sh"]`, `[data-path="${REMOTE}/logs"]`);
    await expect
      .poll(async () => (await relays(page)).length, { timeout: 5000 })
      .toBe(1);

    const copyDeploy = async () => {
      await page.getByRole("button", { name: "生产机" }).click();
      await page.locator(`[data-path="${REMOTE}/deploy.sh"]`).click();
      await page.keyboard.press(`${MOD}+KeyC`);
      await page.locator(`[data-path="${REMOTE}/logs"]`).dblclick();
      await page.locator("[data-filelist-body]").first().click();
      await page.keyboard.press(`${MOD}+KeyV`);
    };

    // 顶层同名 → ConflictDialog（第 1/1 项，含建议名回填）
    await copyDeploy();
    const dlg = page.locator("[data-conflict-dialog]");
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("目标已存在同名项目");
    await expect(dlg).toContainText("deploy.sh");
    await expect(dlg.locator("input")).toHaveValue("deploy_1.sh");

    // 停止：不传输、剪贴板保留（无需重新复制即可再次粘贴）
    await dlg.getByRole("button", { name: "停止" }).click();
    await expect(dlg).not.toBeVisible();
    expect(await relays(page)).toHaveLength(1);

    // 再粘贴 → 改名（默认建议名 deploy_1.sh）→ 中转按新名落盘
    await page.keyboard.press(`${MOD}+KeyV`);
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "改名" }).click();
    await expect
      .poll(async () => (await relays(page)).at(-1), { timeout: 5000 })
      .toMatchObject({ src: `${REMOTE}/deploy.sh`, destDir: `${REMOTE}/logs`, name: "deploy_1.sh" });
    await expect(page.locator(`[data-path="${REMOTE}/logs/deploy_1.sh"]`)).toBeVisible();

    // 重新复制 → 粘贴 → 覆盖 → 原名重传
    await copyDeploy();
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "覆盖", exact: true }).click();
    await expect
      .poll(async () => (await relays(page)).at(-1), { timeout: 5000 })
      .toMatchObject({ src: `${REMOTE}/deploy.sh`, destDir: `${REMOTE}/logs`, name: "deploy.sh" });
    await expect(dlg).not.toBeVisible();
    expect(await relays(page)).toHaveLength(3);
  });
});
