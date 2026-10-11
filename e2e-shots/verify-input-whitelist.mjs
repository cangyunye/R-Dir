// 白名单验证：地址栏编辑态输入框右键 → 不被兜底拦截（保留系统编辑菜单）
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  let cbId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: () => ++cbId,
    invoke: (cmd) => {
      if (cmd === "get_home_dir") return Promise.resolve("C:\Users\Admin");
      if (cmd === "session_load" || cmd === "prefs_load") return Promise.resolve(null);
      if (cmd === "plugin:app|name") return Promise.resolve("R-Dir");
      if (cmd === "plugin:app|version") return Promise.resolve("0.25.0");
      if (cmd === "plugin:window|is_maximized") return Promise.resolve(false);
      if (cmd?.startsWith("plugin:event|")) return Promise.resolve(1);
      if (/list|quick_access|volumes|complete|read_files|stat|suggest|diff/.test(cmd)) return Promise.resolve([]);
      return Promise.resolve(null);
    },
  };
});
await page.goto("http://localhost:1420");
await page.waitForSelector("[data-tab-idx]");
await page.waitForTimeout(1300);
await page.evaluate(() => {
  window.addEventListener("contextmenu", (e) => setTimeout(() => { window.__p = e.defaultPrevented; }, 0), { capture: true });
});
await page.click("[data-pathbar-edit]");
await page.waitForTimeout(300);
await page.rightClick?.() ?? null;
// 用 dispatch 右键到输入框
await page.locator("#rdir-addr-input").click({ button: "right" });
await page.waitForTimeout(250);
const prevented = await page.evaluate(() => window.__p);
const native = await page.evaluate(() => !!document.querySelector("#rdir-addr-input"));
console.log(`${prevented === false && native ? "PASS" : "FAIL"} 地址栏输入框右键未被拦截 prevented=${prevented}`);
await browser.close();
process.exit(prevented === false ? 0 : 1);
