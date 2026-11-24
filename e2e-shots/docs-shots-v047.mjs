// 文档摆拍：v0.47 新功能截图（R-Dir-Docs site/shots.md 用，编号 76+）
// 前置：rdir-web 已在 127.0.0.1:8420（--data-dir /tmp/rdir-shots-data）
//   node e2e-shots/docs-shots-v047.mjs
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:8420";
const TOK = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OUT = "/tmp/rdir-shots";
const LOGS = "/tmp/rdir-shots/demo/logs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

const step = async (name, fn) => {
  try { await fn(); console.log("[ok]", name); }
  catch (e) { console.log("[FAIL]", name, String(e).slice(0, 300)); }
};
const sleep = (ms) => page.waitForTimeout(ms);

async function nav(path) {
  await page.evaluate(() => {
    document.querySelector("[data-pathbar] > div")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await page.locator("#rdir-addr-input").fill(path);
  await page.locator("#rdir-addr-input").press("Enter");
  await sleep(1400);
}

await step("登录", async () => {
  await page.goto(`${BASE}/login?k=${TOK}`);
  await page.waitForLoadState("networkidle");
  await sleep(1200);
  if (!(await page.locator("[data-pathbar]").count())) throw new Error("主界面未出现");
  await nav(LOGS);
});

// ── 76/77/78: ⌘⇧D 比较 + 忽略正则 ──
await step("76 选中两文件 ⌘⇧D 比较（未掩码红绿）", async () => {
  await page.getByText("app-a.log", { exact: true }).click();
  await sleep(300);
  await page.getByText("app-b.log", { exact: true }).click({ modifiers: ["Meta"] });
  await sleep(400);
  await page.keyboard.press("Meta+Shift+d");
  await page.getByText("服务启动完成", { exact: false }).first().waitFor({ timeout: 15000 });
  await sleep(800);
  await page.screenshot({ path: `${OUT}/76-web-diff-selected.png` });
});

await step("77 忽略正则模态框 + 预设", async () => {
  await page.getByRole("button", { name: "正则忽略" }).click();
  await sleep(700);
  // 追加「日期时间」预设到左侧编辑区
  await page.getByRole("button", { name: /日期时间（2024-01-01/ }).click();
  await sleep(500);
  await page.screenshot({ path: `${OUT}/77-web-diff-ignore-dialog.png` });
});

await step("78 应用掩码后 eq 对齐双栏原文", async () => {
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await sleep(2000); // 等模态框关闭 + 重比
  await page.getByText("服务启动完成", { exact: false }).first().waitFor({ timeout: 15000 });
  await sleep(800);
  await page.screenshot({ path: `${OUT}/78-web-diff-masked-eq.png` });
  await page.keyboard.press("Escape");
  await sleep(600);
});

// ── 79: SFTP 私钥路径回填与浏览 ──
await step("79 SFTP 私钥模式对话框", async () => {
  const header = page.locator("[data-sidebar-servers-header]");
  await header.hover();
  await sleep(300);
  await page.locator('button[title="添加 SFTP 服务器"]').click();
  await sleep(600);
  await page.getByRole("button", { name: "私钥", exact: true }).click();
  await sleep(500);
  await page.screenshot({ path: `${OUT}/79-web-sftp-keypath.png` });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await sleep(300);
});

await browser.close();
console.log("all done");
