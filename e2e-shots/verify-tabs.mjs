// E2E 视觉/行为验证：OneNote 彩色标签 + 同步比对按标签独立生效
// 用法：node e2e-shots/verify-tabs.mjs（需 vite dev 已跑在 1420）
import { chromium } from "@playwright/test";

const BASE = "http://localhost:1420";
const OUT = "e2e-shots";

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // 浏览器环境注入最小 Tauri IPC mock：能启动 UI 即可（空目录、无会话）
  await page.addInitScript(() => {
    const ARRAY_CMDS = /list|quick_access|volumes|complete|read_files|stat_paths|suggest/;
    let cbId = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main", windowLabel: "main" },
      },
      transformCallback: () => ++cbId,
      invoke: (cmd) => {
        if (cmd === "get_home_dir") return Promise.resolve("C:\\Users\\Admin");
        if (cmd === "session_load" || cmd === "prefs_load") return Promise.resolve(null);
        if (cmd === "diff_dirs") return Promise.resolve({ cancelled: false, entries: [] });
        if (cmd === "sftp_master_key_status")
          return Promise.resolve({ configured: false, active: false });
        if (cmd === "plugin:app|name") return Promise.resolve("R-Dir");
        if (cmd === "plugin:app|version") return Promise.resolve("0.25.0");
        if (cmd === "plugin:window|is_maximized") return Promise.resolve(false);
        if (cmd.startsWith("plugin:event|")) return Promise.resolve(1);
        if (cmd === "drag_out_files") return Promise.resolve(0);
        if (ARRAY_CMDS.test(cmd)) return Promise.resolve([]);
        return Promise.resolve(null);
      },
    };
  });
  await page.goto(BASE);
  await page.waitForSelector("[data-tab-idx]");
  await page.waitForTimeout(1300); // splash 1100ms 后隐藏

  // ===== 1. 彩色标签：3 个标签看色彩轮换（浅色）=====
  await page.keyboard.press("Control+t");
  await page.keyboard.press("Control+t");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/tabs-colored-light.png` });
  await page.screenshot({
    path: `${OUT}/tabs-strip-light.png`,
    clip: { x: 0, y: 0, width: 900, height: 44 },
  });

  // ===== 2. 暗色主题同一视角（reload 后会话不恢复，需重建标签）=====
  await page.evaluate(() => localStorage.setItem("rfm.theme", "dark"));
  await page.reload();
  await page.waitForSelector("[data-tab-idx]");
  await page.waitForTimeout(1300); // splash 1100ms 后隐藏
  await page.keyboard.press("Control+t");
  await page.keyboard.press("Control+t");
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${OUT}/tabs-strip-dark.png`,
    clip: { x: 0, y: 0, width: 900, height: 44 },
  });
  await page.evaluate(() => localStorage.setItem("rfm.theme", "light"));
  await page.reload();
  await page.waitForSelector("[data-tab-idx]");
  await page.waitForTimeout(1300); // splash 1100ms 后隐藏

  // ===== 3. 同步比对按标签独立 =====
  // 注意：ghost Button 的 class 恒含 hover:bg-accent，不能拿子串判断点亮态；
  // 开关态以 title 为准（开 = "断开同步比对"，关 = "同步比对（左右窗格）"）
  const btn = page
    .locator('button[title="断开同步比对"], button[title="同步比对（左右窗格）"]')
    .first();
  const state = async () => ({ on: (await btn.getAttribute("title")) === "断开同步比对" });

  await page.keyboard.press("Control+\\"); // 左右分屏 → 两个路径窗格
  await page.waitForTimeout(300);
  await btn.click(); // 标签1开启
  await page.waitForTimeout(300);
  const tab1On = await state();
  await page.screenshot({ path: `${OUT}/sync-tab1-on.png` });

  await page.keyboard.press("Control+t"); // 新标签2 → 应显示关
  await page.waitForTimeout(300);
  const tab2State = await state();
  await page.screenshot({ path: `${OUT}/sync-tab2-off.png` });

  await page.locator('[data-tab-idx="0"]').click(); // 回标签1 → 仍开
  await page.waitForTimeout(300);
  const tab1Again = await state();

  await page.keyboard.press("Control+t"); // 标签3：分屏后独立开启
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+\\");
  await page.waitForTimeout(300);
  await btn.click();
  await page.waitForTimeout(300);
  const tab3On = await state();

  await page.locator('[data-tab-idx="0"]').click(); // 标签1↔3 各自都开
  await page.waitForTimeout(300);
  const tab1With3 = await state();

  await btn.click(); // 关标签1的同步 → 不影响标签3
  await page.waitForTimeout(300);
  const tab1OffAgain = await state();
  await page.locator('[data-tab-idx="2"]').click();
  await page.waitForTimeout(300);
  const tab3StillOn = await state();
  await page.screenshot({ path: `${OUT}/sync-tab3-still-on.png` });

  const results = {
    tab1On,
    tab2State,
    tab1Again,
    tab3On,
    tab1With3,
    tab1OffAgain,
    tab3StillOn,
  };
  console.log(JSON.stringify(results, null, 2));

  const ok =
    tab1On.on &&
    !tab2State.on &&
    tab1Again.on &&
    tab3On.on &&
    tab1With3.on &&
    !tab1OffAgain.on &&
    tab3StillOn.on;
  console.log(ok ? "ALL-CHECKS-PASS" : "CHECKS-FAILED");

  await browser.close();
  process.exit(ok ? 0 : 1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
