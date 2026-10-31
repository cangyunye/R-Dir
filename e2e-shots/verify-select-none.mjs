// E2E 验证：chrome 面 select-none——侧边栏/工具栏/属性条/搜索面板拖不出文字选区
// 用法：node e2e-shots/verify-select-none.mjs（需 vite dev 已跑在 1420）
import { chromium } from "@playwright/test";

const BASE = "http://localhost:1420";
const OUT = "e2e-shots";

const SIDEBAR_SEL = '[data-slot="scroll-area"].w-44.select-none';
const TOOLBAR_SEL = "div.h-10.border-b.bg-background.px-2.select-none";
const PROPS_SEL = "div.h-8.shrink-0.border-t.bg-sidebar.select-none";

const results = [];
const check = (name, ok, detail = "") =>
  results.push({ name, ok, detail }) && console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    const ARRAY_CMDS = /list|quick_access|volumes|complete|read_files|suggest/;
    let cbId = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main", windowLabel: "main" },
      },
      transformCallback: () => ++cbId,
      invoke: (cmd, args) => {
        if (cmd === "get_home_dir") return Promise.resolve("C:\\Users\\Admin");
        if (cmd === "session_load" || cmd === "prefs_load") return Promise.resolve(null);
        if (cmd === "diff_dirs") return Promise.resolve({ cancelled: false, entries: [] });
        if (cmd === "sftp_master_key_status")
          return Promise.resolve({ configured: false, active: false });
        if (cmd === "plugin:app|name") return Promise.resolve("R-Dir");
        if (cmd === "plugin:app|version") return Promise.resolve("0.39.0");
        if (cmd === "plugin:window|is_maximized") return Promise.resolve(false);
        if (cmd.startsWith("plugin:event|")) return Promise.resolve(1);
        if (cmd === "drag_out_files") return Promise.resolve(0);
        if (cmd === "stat_paths")
          return Promise.resolve(
            (args?.paths ?? []).map((p) =>
              (p.split(/[\\/]/).pop() || "").includes(".") ? "file" : "dir",
            ),
          );
        if (ARRAY_CMDS.test(cmd)) return Promise.resolve([]);
        return Promise.resolve(null);
      },
    };
  });

  await page.goto(BASE);
  await page.waitForSelector("[data-tab-idx]");
  await page.waitForTimeout(1300); // splash 1100ms 后隐藏

  // ===== 1. 计算样式：chrome 根 userSelect === none，body 保持可选（auto）=====
  for (const [name, sel] of [["侧边栏根", SIDEBAR_SEL], ["工具栏根", TOOLBAR_SEL], ["属性条根", PROPS_SEL]]) {
    const el = page.locator(sel).first();
    const found = (await el.count()) > 0;
    if (!found) { check(`计算样式 ${name}`, false, `选择器未命中: ${sel}`); continue; }
    const us = await el.evaluate((n) => getComputedStyle(n).userSelect);
    check(`计算样式 ${name} = none`, us === "none", `userSelect=${us}`);
  }
  const bodyUs = await page.evaluate(() => getComputedStyle(document.body).userSelect);
  check("body 仍为 auto（内容面不受影响）", bodyUs === "auto" || bodyUs === "text", `userSelect=${bodyUs}`);

  // ===== 2. 真实拖拽 A/B：侧边栏纵向拖动 =====
  /** 沿侧边栏中线从上往下拖，返回选中文本 */
  const dragSidebar = async () => {
    const box = await page.locator(SIDEBAR_SEL).first().boundingBox();
    const x = box.x + box.width / 2;
    const y0 = box.y + 40;
    const y1 = box.y + Math.min(box.height - 12, 700);
    await page.mouse.move(x, y0);
    await page.mouse.down();
    for (let y = y0 + 25; y <= y1; y += 25) await page.mouse.move(x, y);
    await page.mouse.up();
    return page.evaluate(() => window.getSelection().toString());
  };

  const selNone = await dragSidebar();
  check("侧边栏拖拽 → 无选区", selNone === "", `选中文本 ${JSON.stringify(selNone.slice(0, 40))}…`);
  await page.screenshot({ path: `${OUT}/select-none-sidebar.png` });

  // A/B 对照：临时内联放开侧边栏根的 user-select → 同样拖拽应能选中（证明方法论有效）
  await page.locator(SIDEBAR_SEL).first().evaluate((n) => (n.style.userSelect = "text"));
  const selForced = await dragSidebar();
  check(
    "对照组：放开 CSS 后同样拖拽 → 有选区",
    selForced.length > 0,
    `选中文本 ${JSON.stringify(selForced.slice(0, 40))}…`,
  );
  await page.screenshot({ path: `${OUT}/select-none-control.png` });
  await page.locator(SIDEBAR_SEL).first().evaluate((n) => (n.style.userSelect = ""));

  const selRestored = await dragSidebar();
  check("恢复 CSS 后 → 再次无选区", selRestored === "", `选中文本 ${JSON.stringify(selRestored.slice(0, 40))}…`);

  // ===== 3. 双击侧边栏文字 → 无词选（坐标双击，与界面语言/结构无关）=====
  {
    const box = await page.locator(SIDEBAR_SEL).first().boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + 60);
  }
  const selDbl = await page.evaluate(() => window.getSelection().toString());
  check("双击侧边栏文字 → 无词选", selDbl === "", `选中文本 ${JSON.stringify(selDbl)}`);

  // ===== 4. 搜索面板：打开后其 ScrollArea 亦为 none =====
  await page.locator("button:has(svg.lucide-search)").first().click();
  await page.waitForTimeout(400);
  const panelAreas = page.locator('.z-50 [data-slot="scroll-area"].select-none');
  const n = await panelAreas.count();
  if (n === 0) {
    check("搜索面板 ScrollArea = none", false, "未命中 .z-50 下带 select-none 的 ScrollArea");
  } else {
    const us = await panelAreas.first().evaluate((el) => getComputedStyle(el).userSelect);
    check(`搜索面板 ScrollArea = none（${n} 处）`, us === "none", `userSelect=${us}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项失败`}（共 ${results.length} 项）`);
  if (failed.length > 0) process.exit(1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
