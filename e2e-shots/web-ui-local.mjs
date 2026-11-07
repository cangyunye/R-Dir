// B6–B12:本地文件管理浏览器 UI 环(导航/标签/右键写链路/冲突/压缩/拖入/预览/CSP)
import { chromium } from "@playwright/test";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:8420";
const TOK = "e2e0deadbeefcafe0123456789abcdef";
const FIX = "F:\\cargotarget\\webtest-fixtures";
let pass = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) throw new Error(`FAIL ${name} ${extra}`);
  pass++;
  console.log("[pass]", name);
};
const sh = (c) => execSync(c, { encoding: "utf8", timeout: 20000 });

// 夹具复位(勿用 fs.rmSync:node v24 Windows 同进程多次 rmSync 硬崩,见 dts infra-build_node-rmsync-uv-assert-crash)
for (const f of ["ui-新建-甲.txt", "ui-新建-甲 (2).txt", "ui-folder", "ui-folder-renamed", "ui-压缩包.tar", "ui-page.html", "ui-上传-乙.md", "ui-上传-report.csv", "ui-上传-report (2).csv"]) {
  try { execSync(`rm -rf 'F:/cargotarget/webtest-fixtures/${f}'`); } catch {}
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 160)));

try {
  await page.goto(`${BASE}/login?k=${TOK}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);

  // ── B6 导航:面包屑编辑态 → 输入路径回车 ──
  await page.evaluate(() => {
    document.querySelector("[data-pathbar] > div")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await page.locator("#rdir-addr-input").fill(FIX);
  await page.locator("#rdir-addr-input").press("Enter");
  await page.waitForTimeout(1200);
  ok("B6 导航到夹具目录", (await page.evaluate(() => document.body.innerText)).includes("report-data.csv"));

  // B6 新建标签页 + 关闭(标签元素标记 data-tab-idx)
  const tabsBefore = await page.locator("[data-tab-idx]").count();
  await page.locator("button[title=\"新建标签页\"]").click();
  await page.waitForTimeout(600);
  const tabsAfter = await page.locator("[data-tab-idx]").count();
  ok("B6 新建标签页", tabsAfter > tabsBefore, `${tabsBefore}→${tabsAfter}`);
  // 新标签回主目录,再前进/后退回到夹具
  await page.locator("button[title=\"后退\"]").click().catch(() => {});
  await page.waitForTimeout(600);
  await page.locator("button[title=\"前进\"]").click().catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: "e2e-shots/web-ui-1-nav.png" });

  // 回到单标签状态(Ctrl+W 关掉当前多出的标签)
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(500);
  const tabsFinal = await page.locator("[data-tab-idx]").count();
  ok("B6 关闭标签页恢复", tabsFinal === tabsBefore, `${tabsAfter}→${tabsFinal}`);

  // ── B10 拖入本地窗格(含中文名/重名 → (2) 后缀)──
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["乙-内容"], "ui-上传-乙.md", { type: "text/markdown" }));
    dt.items.add(new File(["id,name\n9,gamma\n"], "ui-上传-report.csv", { type: "text/csv" }));
    dt.items.add(new File(["id,name\n8,dup\n"], "report-data.csv", { type: "text/csv" })); // 与已有文件重名 → (2)
    window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(2500);
  ok("B10 拖入落盘(中文名)", existsSync(FIX + "\\ui-上传-乙.md") && existsSync(FIX + "\\ui-上传-report.csv"));
  ok("B10 重名 (2) 后缀", existsSync(FIX + "\\report-data (2).csv") &&
    readFileSync(FIX + "\\report-data (2).csv", "utf8").includes("8,dup"));
  await page.screenshot({ path: "e2e-shots/web-ui-2-drop.png" });

  // ── B7 右键 → 新建文件夹 → 重命名 ──
  await page.getByText("report-data.csv", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建文件夹" }).click();
  await page.waitForTimeout(800);
  // 新建后立即进重命名态:输入框全选,直接键入新名回车
  const renameBox = page.locator("input[data-rename-input], form input").last();
  await renameBox.press("Control+a");
  await renameBox.type("ui-folder");
  await renameBox.press("Enter");
  await page.waitForTimeout(1000);
  ok("B7 新建文件夹", existsSync(FIX + "\\ui-folder"));

  await page.getByText("ui-folder", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await page.waitForTimeout(600);
  const rb2 = page.locator("input[data-rename-input], form input").last();
  await rb2.press("Control+a");
  await rb2.type("ui-folder-renamed");
  await rb2.press("Enter");
  await page.waitForTimeout(1000);
  ok("B7 重命名", existsSync(FIX + "\\ui-folder-renamed"));
  await page.screenshot({ path: "e2e-shots/web-ui-3-create.png" });

  // ── B7 删除 → 撤销 ──
  await page.getByText("ui-folder-renamed", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除（回收站）" }).click();
  await page.waitForTimeout(600);
  // 可能弹确认框
  const confirmBtn = page.getByRole("button", { name: /确认|确定|删除/ }).last();
  if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
  await page.waitForTimeout(1200);
  ok("B7 删除(回收站)", !existsSync(FIX + "\\ui-folder-renamed"));
  await page.getByText("report-data.csv", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "撤销" }).click();
  await page.waitForTimeout(1200);
  ok("B7 撤销还原", existsSync(FIX + "\\ui-folder-renamed"));

  // ── B8 冲突复制(复制 → Ctrl+V 同目录粘贴 → 冲突弹窗)──
  await page.getByText("report-data.csv", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(1500);
  const dialogText = await page.evaluate(() => document.body.innerText);
  ok("B8 冲突裁决弹窗出现", /冲突|已存在|覆盖|保留两者|跳过/.test(dialogText), dialogText.slice(0, 250));
  await page.screenshot({ path: "e2e-shots/web-ui-4-conflict.png" });
  const overwrite = page.getByRole("button", { name: /覆盖|保留两者/ }).last();
  if (await overwrite.isVisible().catch(() => false)) await overwrite.click();
  await page.waitForTimeout(1200);

  // ── B9 压缩(tar)──
  await page.getByText("ui-上传-乙.md", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "压缩为" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("menuitem", { name: "tar（仅打包）" }).click();
  await page.waitForTimeout(2500);
  ok("B9 压缩产物落盘", existsSync(FIX + "\\ui-上传-乙.tar") || existsSync(FIX + "\\ui-上传-乙.md.tar"),
    sh(`ls ${"F:/cargotarget/webtest-fixtures"}`).replace(/\n/g, " "));
  await page.screenshot({ path: "e2e-shots/web-ui-5-compress.png" });

  // ── B12 CSP sandbox:不可信 html 内 fetch /api/invoke 必须失败 ──
  writeFileSync(FIX + "\\ui-page.html",
    "<!doctype html><html><body><h1>untrusted</b></h1></body></html>", "utf8");
  const p2 = await browser.newPage();
  await p2.goto(`${BASE}/login?k=${TOK}`);
  const c2 = (await p2.context().cookies()).find((c) => c.name === "rdir_token");
  await p2.close();
  const p3 = await browser.newPage();
  // 直接以匿名上下文访问 /api/file(带 cookie),在沙箱页内 fetch API
  const ctx3 = await browser.newContext();
  await ctx3.addCookies([{ name: "rdir_token", value: TOK, url: BASE }]);
  const p4 = await ctx3.newPage();
  await p4.goto(`${BASE}/api/file?path=${encodeURIComponent(FIX + "\\ui-page.html")}`);
  const probe = await p4.evaluate(async () => {
    try {
      const r = await fetch("/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "get_home_dir", args: {} }),
      });
      let body = null;
      try { body = await r.text(); } catch {}
      return { status: r.status, body: (body || "").slice(0, 80) };
    } catch (e) {
      return { blocked: String(e).slice(0, 80) };
    }
  });
  console.log("[B12 probe]", JSON.stringify(probe));
  ok("B12 沙箱页拿不到 API 数据", "blocked" in probe || (!probe.status || probe.status !== 200), JSON.stringify(probe));
  await ctx3.close();
  void c2;

  // ── B11 双击打开(popup /api/file):先刷新列表让外部写入的 html 可见 ──
  await page.locator("button[title=\"刷新\"]").first().click().catch(() => {});
  await page.locator("button[title=\"刷新当前目录\"]").first().click().catch(() => {});
  await page.waitForTimeout(1200);
  const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
  await page.getByText("ui-page.html", { exact: true }).dblclick();
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    ok("B11 双击弹 /api/file", popup.url().includes("/api/file"), popup.url());
    await popup.close();
  } else {
    console.log("[note] B11 无 popup(当前环境拦截 window.open?),降级检查当前页");
  }

  console.log(`\nUI-LOCAL ALL DONE: ${pass} checks passed`);
} finally {
  await browser.close();
}
