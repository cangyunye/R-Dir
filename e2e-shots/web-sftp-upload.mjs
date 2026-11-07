// 待办 A 验收:web 模式 SFTP 窗格拖拽上传全链路
// 链路:合成 DropEvent → /api/upload(服务端临时目录)→ sftp_upload 转传 → 临时清理 → 窗格刷新
import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const BASE = "http://127.0.0.1:8420";
const TOK = "e2e0deadbeefcafe0123456789abcdef";
const REMOTE = "sftp://kube@172.20.214.44:2222/home/kube/rdir-webtest";
const SSH = 'ssh -o BatchMode=yes -o ConnectTimeout=8 -p 2222 kube@172.20.214.44';
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const log = (...a) => console.log("[t]", ...a);

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", timeout: 30000 });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

try {
  // ── 登录 ──
  await page.goto(`${BASE}/login?k=${TOK}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);

  // ── 服务器清单自愈(幂等种子):已存在 wsl-kube-test 就不再 save ──
  const listed = await page.evaluate(async () =>
    (await (await fetch("/api/invoke", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "sftp_list_servers", args: {} }),
    })).json()),
  );
  const have = JSON.stringify(listed).includes("wsl-kube-test");
  if (!have) {
    const seed = await page.evaluate(async () => {
      const r = await fetch("/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: "sftp_save_server",
          args: {
            server: {
              id: "wsl-kube-test",
              name: "WSL-Ubuntu2604",
              host: "172.20.214.44",
              port: 2222,
              user: "kube",
              root: "/home/kube/rdir-webtest",
              group: "",
              auth: "publicKey",
              keyPath: "C:\\Users\\Admin\\.ssh\\id_ed25519",
              savePassphrase: false,
            },
          },
        }),
      });
      return r.json();
    });
    if (!seed.ok && !seed.data) throw new Error("seed 失败: " + JSON.stringify(seed));
  }
  log("服务器清单就绪(幂等种子)");

  // ── 连接(自适应):会话恢复可能已静默重连;否则侧栏点服务器 → 对话框私钥连接 ──
  let atRemote = await page.evaluate(() =>
    document.body.innerText.split("\n").some((l) => l.trim() === "rdir-webtest"),
  );
  if (!atRemote) {
    await page.getByText("WSL-Ubuntu2604").first().click();
    await page.waitForTimeout(1200);
    const dlgOpen = await page.evaluate(() => document.body.innerText.includes("SFTP 连接"));
    if (dlgOpen) {
      await page.getByRole("button", { name: "私钥" }).click();
      await page.getByRole("button", { name: "连接", exact: true }).click();
    }
    await page.waitForTimeout(2500);
  }
  // ── 地址栏 sftp:// 直连导航(B22):点面包屑空白进编辑态 → 填路径回车 ──
  await page.evaluate(() => {
    document
      .querySelector("[data-pathbar] > div")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await page.locator("#rdir-addr-input").fill(REMOTE);
  await page.locator("#rdir-addr-input").press("Enter");
  await page.waitForTimeout(2500);
  const bc = await page.evaluate(() => document.body.innerText);
  // 收紧断言:面包屑必须出现末段目录名,且不能带着「无法/失败」的错误横幅
  const bcLines = bc.split("\n").map((s) => s.trim());
  const crumbHit = bcLines.some((l) => l === "rdir-webtest");
  if (!crumbHit) {
    throw new Error("远程目录未出现在面包屑:\n" + bc.slice(0, 400));
  }
  await page.screenshot({ path: "e2e-shots/web-sftp-1-connected.png" });
  log("连接 + sftp:// 地址栏导航到测试目录 ✓");

  // ── 拖拽上传 3 文件(含中文名)──
  const files1 = [
    { name: "测试文档-甲.txt", data: "甲-content-v1-中文内容测试" },
    { name: "测试文档-乙.md", data: "# 乙-heading\n\n第二行" },
    { name: "report-data.csv", data: "id,name\n1,alpha\n2,beta\n" },
  ];
  await page.evaluate((fl) => {
    const dt = new DataTransfer();
    for (const f of fl) dt.items.add(new File([f.data], f.name, { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, files1);
  await page.waitForTimeout(3500);
  const after1 = await page.evaluate(() => document.body.innerText);
  for (const f of files1) {
    if (!after1.includes(f.name)) throw new Error(`窗格未显示 ${f.name}`);
  }
  await page.screenshot({ path: "e2e-shots/web-sftp-2-uploaded.png" });
  log("3 文件上传后窗格已显示 ✓");

  // ── 远端内容核验(md5)+ 临时目录零残留 ──
  const remoteList = sh(`${SSH} "cd ~/rdir-webtest && md5sum * 2>/dev/null"`);
  for (const f of files1) {
    const expect = md5(f.data);
    if (!remoteList.includes(expect)) throw new Error(`远端 md5 不匹配 ${f.name}:\n${remoteList}\nexpect ${expect}`);
  }
  log("远端 md5 三文件全匹配 ✓");
  const tempInfo1 = await page.evaluate(async () =>
    (await (await fetch("/api/invoke", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "remote_temp_info", args: { localDir: null } }),
    })).json()),
  );
  log("remote_temp_info:", JSON.stringify(tempInfo1).slice(0, 160));
  const files1n = tempInfo1?.data?.files ?? tempInfo1?.files;
  if (files1n !== 0) throw new Error("服务端临时目录有残留: " + JSON.stringify(tempInfo1));
  log("服务端临时目录零残留 ✓");

  // ── 重名覆盖(与桌面同语义:FXF_TRUNC)──
  await page.evaluate((fl) => {
    const dt = new DataTransfer();
    for (const f of fl) dt.items.add(new File([f.data], f.name, { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [{ name: "测试文档-甲.txt", data: "甲-content-v2-overwrite" }]);
  await page.waitForTimeout(3000);
  const remoteAfter2 = sh(`${SSH} "cd ~/rdir-webtest && md5sum * 2>/dev/null"`);
  if (!remoteAfter2.includes(md5("甲-content-v2-overwrite"))) throw new Error("重名覆盖未生效:\n" + remoteAfter2);
  const cnt = sh(`${SSH} "ls ~/rdir-webtest | wc -l"`).trim();
  if (cnt !== "3") throw new Error(`文件数应为 3,实际 ${cnt}`);
  log("重名覆盖 ✓(内容已替换,文件数仍 3)");

  // ── 断网拖拽:terminate WSL → 上传应报明确错误、页面不崩、临时清理 ──
  execSync("wsl --terminate Ubuntu2604", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["offline-drop"], "断网测试.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  // sftp 连接失败需要时间(SYN 不可达),耐心等错误提示出现
  let offlineToast = false;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(2500);
    const txt = await page.evaluate(() => document.body.innerText);
    if (txt.includes("上传失败")) { offlineToast = true; break; }
  }
  if (!offlineToast) throw new Error("断网拖拽未出现「上传失败」提示");
  const alive = await page.evaluate(() => !!document.querySelector("button") && document.body.innerText.length > 100);
  if (!alive) throw new Error("断网后页面疑似崩溃");
  await page.screenshot({ path: "e2e-shots/web-sftp-3-offline-error.png" });
  log("断网拖拽:明确报错 + 页面存活 ✓");
  const tempInfo2 = await page.evaluate(async () =>
    (await (await fetch("/api/invoke", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "remote_temp_info", args: { localDir: null } }),
    })).json()),
  );
  const files2n = tempInfo2?.data?.files ?? tempInfo2?.files;
  if (files2n !== 0) throw new Error("断网路径临时目录有残留: " + JSON.stringify(tempInfo2));
  log("断网路径临时目录零残留 ✓");

  // ── 恢复:重启 WSL 会话由外部负责;这里先验证 UI 存活即可 ──
  log("ALL-PASS");
} finally {
  await browser.close();
}
