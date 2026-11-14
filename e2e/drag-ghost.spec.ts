import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";
const switchBtn = (mode: string) => `[data-view-switch] button[data-view-mode="${mode}"]`;

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
  await expect(page.locator('[class*="z-[9999]"]')).toHaveCount(0);
});

test.describe("拖拽拖影与落点确认（v0.49 特性4）", () => {
  test("引擎A:大图标拖动条目 → 拖影显示文件名;悬停文件夹图标 → 落点行;松手归零", async ({
    page,
  }) => {
    // 捕获阶段取消 dragstart：否则 Chromium 起原生 HTML5 拖拽后 mousemove 停发
    // （被 dragover 取代），引擎 A 的拖影/落点链路整个不跑
    await page.evaluate(() => {
      window.addEventListener("dragstart", (e) => e.preventDefault(), true);
    });
    await page.locator(switchBtn("icons")).click();
    await expect(page.locator("[data-grid-item]")).toHaveCount(6);
    const item = page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`);
    const box = await item.boundingBox();
    // 图标语义：按下未选中图标 = 立即选中并成为拖拽候选
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 8, { steps: 4 });
    const ghost = page.locator("[data-drag-ghost]");
    await expect(ghost).toHaveAttribute("data-drag-ghost", "");
    await expect
      .poll(() => ghost.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
    await expect(ghost).toContainText("Notes.txt");
    // 跟手位置：拖影容器左上角 ≈ 光标 + (10,10) 视觉像素（zoom 折算后,未折算时
    // 会按 1.0769 放大偏离 ~27px）
    const cx = box.x + box.width / 2 + 20;
    const cy = box.y + box.height / 2 + 8;
    const gb = (await ghost.boundingBox())!;
    expect(Math.abs(gb.x - (cx + 10))).toBeLessThanOrEqual(8);
    expect(Math.abs(gb.y - (cy + 10))).toBeLessThanOrEqual(8);

    // 拖到 Documents 文件夹图标上：落点行「复制到「Documents」」
    const dir = page.locator(`[data-grid-item][data-path="${HOME}/Documents"]`);
    const db = await dir.boundingBox();
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 4 });
    await expect(ghost).toContainText("复制到「Documents」");

    await page.mouse.up();
    await expect
      .poll(() => ghost.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("0");
  });

  test("引擎A:多选拖动 → 数量徽章与操作文案", async ({ page }) => {
    await page.evaluate(() => {
      window.addEventListener("dragstart", (e) => e.preventDefault(), true);
    });
    await page.locator(switchBtn("icons")).click();
    await expect(page.locator("[data-grid-item]")).toHaveCount(6);
    // Ctrl+点选两个文件后按住其一拖动
    await page.keyboard.down("Control");
    await page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`).click();
    await page.locator(`[data-grid-item][data-path="${HOME}/photo.png"]`).click();
    await page.keyboard.up("Control");
    const item = page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`);
    const box = await item.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 8, { steps: 4 });
    const ghost = page.locator("[data-drag-ghost]");
    await expect(ghost).toContainText("2");
    await expect(ghost).toContainText("复制");
    await page.mouse.up();
  });

  test("HTML5:文件行拖到目录行 → 跟手拖影含文件名与落点行「复制到「Documents」」,移开落点行消失", async ({
    page,
  }) => {
    const srcSel = `[role="row"][data-path="${HOME}/Notes.txt"]`;
    const dirSel = `[role="row"][data-path="${HOME}/Documents"]`;
    const fileSel = `[role="row"][data-path="${HOME}/photo.png"]`;
    await page.evaluate(
      ({ srcSel, dirSel }) => {
        const src = document.querySelector(srcSel)!;
        const dir = document.querySelector(dirSel)!;
        const dt = new DataTransfer();
        src.dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
        const at = (el: Element) => {
          const r = el.getBoundingClientRect();
          return {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          };
        };
        window.dispatchEvent(new DragEvent("dragover", at(dir)));
        // 悬停在目录行上：拖影含落点行；移到文件行（非目录落点）落点行消失
        (window as unknown as { __rdirMoveTo: (el: Element) => void }).__rdirMoveTo = (el) =>
          window.dispatchEvent(new DragEvent("dragover", at(el)));
      },
      { srcSel, dirSel },
    );
    const ghost = page.locator("[data-native-ghost]");
    await expect(ghost).toContainText("Notes.txt"); // 拖影主卡=被拖文件
    await expect(ghost).toContainText("复制到「Documents」"); // 目录落点行
    // 跟手位置：拖影容器左上角 ≈ dragover 坐标 + (16,20) 视觉像素
    const dirBox = (await page.locator(dirSel).boundingBox())!;
    const gb2 = (await ghost.boundingBox())!;
    expect(Math.abs(gb2.x - (dirBox.x + dirBox.width / 2 + 16))).toBeLessThanOrEqual(8);
    expect(Math.abs(gb2.y - (dirBox.y + dirBox.height / 2 + 20))).toBeLessThanOrEqual(8);
    await page.evaluate(
      ({ fileSel }) => {
        const file = document.querySelector(fileSel)!;
        (window as unknown as { __rdirMoveTo: (el: Element) => void }).__rdirMoveTo(file);
      },
      { fileSel },
    );
    await expect(ghost).not.toContainText("复制到「Documents」"); // 落点行随目标消失
    await expect(ghost).toContainText("Notes.txt"); // 拖影本体仍在
    await page.evaluate(() => window.dispatchEvent(new DragEvent("dragend", { bubbles: true })));
    await expect
      .poll(() => ghost.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("0"); // 会话结束拖影归零
  });
});

test.describe("雅·挤开位移动画（v0.49 特性5,大图标）", () => {
  async function dragOverNeighbor(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      window.addEventListener("dragstart", (e) => e.preventDefault(), true);
    });
    await page.locator(switchBtn("icons")).click();
    await expect(page.locator("[data-grid-item]")).toHaveCount(6);
    const item = page.locator(`[data-grid-item][data-path="${HOME}/Notes.txt"]`);
    const nb = page.locator(`[data-grid-item][data-path="${HOME}/photo.png"]`);
    const ib = await item.boundingBox();
    const nbBox = await nb.boundingBox();
    // 拖 Notes.txt 到 photo.png 所在槽位（插入语义:photo.png 应被推移）
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.mouse.down();
    await page.mouse.move(nbBox.x + nbBox.width / 2, nbBox.y + nbBox.height / 2, { steps: 5 });
    return { item, nb, nbBox };
  }

  test("雅:拖到邻居槽位 → 被越过项带 transform 推移;松手落位=预览", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("rfm.anim-level", "elegant");
      } catch { /* ignore */ }
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator('[class*="z-[9999]"]')).toHaveCount(0);
    const { item, nb, nbBox } = await dragOverNeighbor(page);
    // 挤开推移进行中:photo.png 带 transform（雅预览）
    await expect
      .poll(() => nb.evaluate((el) => getComputedStyle(el).transform))
      .not.toBe("none");
    // 松手落位:插入语义生效 → Notes.txt 落 photo.png 原槽,预览 transform 归零
    await page.mouse.up();
    await expect
      .poll(() => nb.evaluate((el) => getComputedStyle(el).transform))
      .toBe("none");
    const ibAfter = await item.boundingBox();
    // Notes.txt 现在在 photo.png 原来的槽位（左上角对齐,容差 2px）
    expect(Math.abs(ibAfter.x - nbBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(ibAfter.y - nbBox.y)).toBeLessThanOrEqual(2);
  });

  test("素:同样的拖拽悬停,邻居不带 transform（无挤开）", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("rfm.anim-level", "plain");
      } catch { /* ignore */ }
    });
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator('[class*="z-[9999]"]')).toHaveCount(0);
    const { nb } = await dragOverNeighbor(page);
    await page.waitForTimeout(200);
    expect(await nb.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
    await page.mouse.up();
  });
});
