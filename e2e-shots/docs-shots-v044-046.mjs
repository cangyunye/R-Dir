// 文档摆拍 v2：v0.44–v0.46 新功能截图（R-Dir-Docs site/shots.md 用，编号 65+）
// 前置：rdir-web 已在 127.0.0.1:8420（--data-dir /tmp/rdir-shots-data）
//   node e2e-shots/docs-shots-v044-046.mjs
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";

const BASE = "http://127.0.0.1:8420";
const TOK = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OUT = "/tmp/rdir-shots";
const GIT_CLONED = "/Volumes/ORICO2T_Data/Users/sinvigil/git_cloned";
const GBK = "/tmp/rdir-shots/demo/gbk";

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

const closePanel = async () => {
  const x = page.locator('button[title="关闭搜索面板"]');
  if (await x.count()) { await x.click(); await sleep(400); }
};

const indexStatus = () => page.evaluate(() =>
  fetch("/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "index_status", args: {} }),
  }).then((r) => r.json()),
);

await step("登录", async () => {
  await page.goto(`${BASE}/login?k=${TOK}`);
  await page.waitForLoadState("networkidle");
  await sleep(1200);
  if (!(await page.locator("[data-pathbar]").count())) throw new Error("主界面未出现");
  await nav(GIT_CLONED);
});

// ── 66: 修排除目录（去掉 /Volumes）→ 等构建 → 截设置分区 ──
await step("66 设置:排除目录去掉 /Volumes 并等待构建", async () => {
  await page.keyboard.press("Meta+,");
  await sleep(700);
  // 设置对话框加高，整分区入镜
  await page.addStyleTag({ content: ".settings-glass{height:940px!important;max-height:94vh!important;}" });
  await page.locator("nav button", { hasText: "全盘索引" }).first().click();
  await sleep(800);
  const section = page.locator('[data-settings-section="index"]');
  const excl = section.locator("textarea").nth(1);
  const cur = await excl.inputValue();
  const next = cur.split("\n").map((s) => s.trim()).filter((s) => s && s !== "/Volumes").join("\n");
  if (next !== cur) {
    await excl.fill(next);
    await section.getByRole("button", { name: "保存索引配置" }).click();
  }
  // 轮询 API 直到构建完成（entries>0 且 ready）
  await page.waitForFunction(async () => {
    const r = await fetch("/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "index_status", args: {} }),
    }).then((x) => x.json());
    return r?.data?.phase === "ready" && r.data.entries > 0;
  }, null, { timeout: 300000, polling: 2000 });
  // 等设置页状态行离开「构建中」瞬态（增量重扫期间 entries 从 0 重计）
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-settings-section="index"]');
    if (!el) return false;
    const t = el.innerText;
    return t.includes("已索引") && !t.includes("构建中");
  }, null, { timeout: 60000, polling: 1000 });
  await sleep(1000);
});

await step("66 截图:全盘索引设置分区", async () => {
  await page.locator("nav button", { hasText: "全盘索引" }).first().click();
  await sleep(900); // 等滚动定位与 scroll-spy 高亮
  await page.locator(".settings-glass").screenshot({ path: `${OUT}/66-web-index-settings.png` });
});

// ── 71: 右键菜单显示项（开快捷链接组）──
await step("71 右键菜单配置 + 截图", async () => {
  await page.locator("nav button", { hasText: "右键菜单" }).first().click();
  await sleep(600);
  const row = page.locator('label[role="switch"][aria-label^="快捷链接"]');
  if ((await row.getAttribute("aria-checked")) !== "true") await row.click();
  await sleep(500);
  await page.locator('[data-settings-section="contextMenu"]').scrollIntoViewIfNeeded();
  await sleep(400);
  await page.locator('[data-settings-section="contextMenu"]').screenshot({ path: `${OUT}/71-web-menu-config.png` });
  await page.keyboard.press("Escape");
  await sleep(600);
});

// ── 65: 全盘索引搜索（全屏化 + 双行结果；已产出则跳过）──
if (existsSync(`${OUT}/65-web-index-search.png`)) {
  console.log("[skip] 65 已产出");
} else await step("65 全盘搜索 + 全屏化截图", async () => {
  await page.keyboard.press("Meta+f");
  await sleep(800);
  await page.getByRole("button", { name: "全盘", exact: true }).click();
  await sleep(600);
  await page.locator('input[placeholder*="全盘索引检索"]').click();
  await page.keyboard.type("agent");
  await page.locator("[data-search-path]").first().waitFor({ timeout: 30000 });
  await sleep(800);
  await page.getByTitle(/切换全屏/).click();
  await sleep(800);
  await page.screenshot({ path: `${OUT}/65-web-index-search.png` });
  await page.keyboard.press("Meta+Enter"); // ⌘↩ 退出全屏（面板自身捕获监听）
  await sleep(600);
  await closePanel();
});

// ── 67: fd 递归 + 深度 chip 下拉展开 ──
await step("67 深度 chip 下拉截图", async () => {
  await page.keyboard.press("Meta+f");
  await sleep(700);
  await page.getByRole("button", { name: "递归", exact: true }).click();
  await sleep(400);
  await page.locator('[aria-label="搜索深度"]').click();
  await sleep(500);
  await page.getByRole("menuitem", { name: /深度：2 层/ }).click();
  await sleep(400);
  await page.locator('[aria-label="搜索深度"]').click();
  await sleep(500);
  await page.screenshot({ path: `${OUT}/67-web-search-depth-chip.png` });
  await page.keyboard.press("Escape"); // 关下拉
  await sleep(400);
  await closePanel();
});

// ── 68: 内容搜索 + 排除的文件 ──
await step("68 内容搜索排除截图", async () => {
  await page.keyboard.press("Meta+f");
  await sleep(700);
  await page.getByRole("tab", { name: "内容" }).click();
  await sleep(500);
  await page.getByRole("button", { name: "递归", exact: true }).click();
  await sleep(300);
  await page.locator('[aria-label="排除的文件"]').fill("node_modules\n*.log\n*.min.js");
  await page.locator('input[placeholder="搜索文件内容…"]').click();
  await page.keyboard.type("the");
  await page.locator("[data-search-path]").first().waitFor({ timeout: 60000 });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/68-web-search-exclude.png` });
  await closePanel();
});

// ── 69/70: 侧边栏收缩 + 远程临时目录入口 ──
await step("69 侧边栏收缩截图", async () => {
  await page.keyboard.press("Meta+e");
  await sleep(900);
  await page.screenshot({ path: `${OUT}/69-web-sidebar-collapsed.png` });
});
await step("70 远程临时目录入口截图", async () => {
  await page.keyboard.press("Meta+e");
  await sleep(900);
  await page.locator("[data-sidebar]").screenshot({ path: `${OUT}/70-web-remote-temp-entry.png` });
});

// ── 73: 右键「快捷链接」组 ──
await step("73 快捷链接右键组截图", async () => {
  await page.getByText("awesome-rust", { exact: true }).click({ button: "right" });
  await sleep(700);
  const group = page.getByRole("menuitem", { name: "快捷链接" });
  await group.hover();
  await sleep(600);
  if (!(await page.getByText("创建快捷方式").isVisible().catch(() => false))) {
    await group.click();
    await sleep(600);
  }
  await page.getByText("创建快捷方式").waitFor({ timeout: 5000 });
  await sleep(300);
  await page.screenshot({ path: `${OUT}/73-web-shortcut-links-menu.png` });
  await page.keyboard.press("Escape");
  await sleep(400);
});

// ── 74: SFTP 覆盖确认 ──
async function addServer(display) {
  const header = page.locator('[data-sidebar-servers-header]');
  await header.hover();
  await sleep(300);
  await page.locator('button[title="添加 SFTP 服务器"]').click();
  await sleep(600);
  await page.getByPlaceholder("可选，默认 user@host").fill(display);
  await page.getByPlaceholder("127.0.0.1").fill("127.0.0.1");
  await page.getByPlaceholder("登录用户").fill("sinvigil");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await sleep(800);
}

await step("74 SFTP 覆盖确认截图", async () => {
  await addServer("本机 A");
  await addServer("本机 B");
  await page.getByText("覆盖服务器配置").waitFor({ timeout: 5000 });
  await sleep(400);
  await page.screenshot({ path: `${OUT}/74-web-sftp-overwrite-confirm.png` });
  await page.getByRole("button", { name: "取消" }).last().click();
  await sleep(400);
  await page.keyboard.press("Escape");
  await sleep(300);
});

// ── 76: GBK 内容搜索 ──
await step("76 GBK 内容搜索截图", async () => {
  await nav(GBK);
  await page.keyboard.press("Meta+f");
  await sleep(700);
  await page.getByRole("tab", { name: "内容" }).click();
  await sleep(400);
  await page.locator('input[placeholder="搜索文件内容…"]').click();
  await page.keyboard.type("数据迁移");
  await page.locator("[data-search-path]").first().waitFor({ timeout: 30000 });
  await sleep(1200);
  await page.screenshot({ path: `${OUT}/76-web-search-gbk.png` });
  await closePanel();
});

await browser.close();
console.log("all done");
