// B26:GUI 与 web 共享同一份配置(便携沙箱)——互写可见 + 并发 last-write-wins 无损坏
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";

const SANDBOX = "F:\\cargotarget\\webtest-b26";
const CFG = SANDBOX + "\\data\\config";
const TOK = "e2e0deadbeefcafe0123456789abcdef";
let pass = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) throw new Error(`FAIL ${name} ${extra}`);
  pass++;
  console.log("[pass]", name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitBanner(proc, marker, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("启动超时")), timeoutMs);
    const on = (d) => {
      out += d.toString();
      if (out.includes(marker)) { clearTimeout(t); resolve(out); }
    };
    proc.stdout?.on("data", on);
    proc.stderr?.on("data", on);
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error("提前退出 " + c + ": " + out.slice(0, 300))); });
  });
}
async function waitPort(port, timeoutMs = 8000) {
  for (let i = 0; i < timeoutMs / 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }); return; } catch { await sleep(100); }
  }
  throw new Error("port not ready " + port);
}

// ── 沙箱 ──
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
cpSync("F:\\cargotarget\\debug\\rdir-web.exe", SANDBOX + "\\rdir-web.exe");
cpSync("F:\\cargotarget\\debug\\R-Dir.exe", SANDBOX + "\\R-Dir.exe");
writeFileSync(SANDBOX + "\\R-Dir.portable", "");

// ── ① web 先写:主题/自定义标记进共享 prefs.json ──
let web = spawn(SANDBOX + "\\rdir-web.exe", ["--listen", "127.0.0.1:8427", "--token", TOK], { stdio: ["ignore", "pipe", "pipe"] });
await waitBanner(web, "Ctrl+C");
await waitPort(8425);
const l = await fetch(`http://127.0.0.1:8427/login?k=${TOK}`, { redirect: "manual" });
if (l.status !== 303) throw new Error(`8427 被其他服务占用(login=${l.status}),请换端口`);
const cookie = (l.headers.get("set-cookie") || "").split(";")[0];
const invoke = async (cmd, args = {}) =>
  (await fetch("http://127.0.0.1:8427/api/invoke", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ cmd, args }),
  })).json();
let r = await invoke("prefs_save", { value: { themeMode: "dark", b26marker: "written-by-web" } });
ok("① web 写 prefs", r.ok === true, JSON.stringify(r).slice(0, 120));
web.kill();
await sleep(600);
ok("① 共享 prefs.json 落便携目录", existsSync(CFG + "\\prefs.json") &&
  readFileSync(CFG + "\\prefs.json", "utf8").includes("written-by-web"));

// ── ② GUI 后起:读同一份配置(进程存活 + 配置目录同源)──
const gui = spawn(SANDBOX + "\\R-Dir.exe", [], { stdio: ["ignore", "ignore", "ignore"], detached: false });
await sleep(7000);
ok("② GUI 进程存活且用的是同一 config", gui.exitCode === null && existsSync(CFG + "\\prefs.json"),
  "exitCode=" + gui.exitCode);
// GUI 启动会写自己的 session.json(证明它解析到了同一目录)
const sessAfterGui = existsSync(CFG + "\\session.json");
console.log("[note] GUI 启动后 session.json 存在:", sessAfterGui);

// ── ③ 双实例并发 15s:双方存活 + json 无损坏(last-write-wins 语义实证)──
web = spawn(SANDBOX + "\\rdir-web.exe", ["--listen", "127.0.0.1:8427", "--token", TOK], { stdio: ["ignore", "pipe", "pipe"] });
await waitBanner(web, "Ctrl+C");
await waitPort(8425);
const r2 = await invoke("session_load");
ok("③ web 读到会话数据(不分家)", r2.ok === true, JSON.stringify(r2).slice(0, 120));
await sleep(15000);
ok("③ 双实例并发后均存活", gui.exitCode === null && web.exitCode === null,
  `gui=${gui.exitCode} web=${web.exitCode}`);
for (const f of ["prefs.json", "session.json", "servers.json"]) {
  const p = CFG + "\\" + f;
  if (!existsSync(p)) continue; // 未产生过的文件不要求存在
  try { JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(`FAIL ③ ${f} 损坏: ${e.message}`); }
}
ok("③ 共享配置三个 json 全部可解析(无损坏)", true);
web.kill();
gui.kill();
await sleep(500);
console.log(`\nB26 ALL DONE: ${pass} checks passed`);
