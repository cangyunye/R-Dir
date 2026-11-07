// B28/B29/B32/B4:CLI 级回归——只读实例 / 便携标记 / 0.0.0.0 banner / 随机 token 重启
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";

const EXE = "F:\\cargotarget\\debug\\rdir-web.exe";
const TOK = "e2e0deadbeefcafe0123456789abcdef";
const SANDBOX = "F:\\cargotarget\\webtest-data";
let pass = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) throw new Error(`FAIL ${name} ${extra}`);
  pass++;
  console.log("[pass]", name);
};

function start(args, datadir) {
  return start2(EXE, args, datadir);
}
function start2(exe, args, datadir) {
  const proc = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("启动超时: " + args.join(" "))), 20000);
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("Ctrl+C")) {
        clearTimeout(timer);
        // banner 先于监听就绪打印:轮询端口直到可连(最多 8s),消除启动竞态
        void (async () => {
          const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
          const port = m?.[1];
          for (let i = 0; i < 80 && port; i++) {
            try {
              await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 100));
            }
          }
          resolve({ proc, banner: out });
        })();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (c) => {
      clearTimeout(timer);
      console.log("[proc-exit]", exe, "code=", c, "tail=", out.split("\n").slice(-3).join(" | "));
      reject(new Error(`提前退出(${c}): ${out}`));
    });
    void datadir;
  });
}
const invoke = async (port, cmd, args = {}, cookie) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ cmd, args }),
  });
  return r.json();
};

// ── B28 只读实例(与主实例同数据目录,共享 SFTP 清单)──
{
  const { proc, banner } = await start(["--listen", "127.0.0.1:8421", "--token", TOK, "--data-dir", SANDBOX, "--read-only"]);
  try {
    ok("B28 banner 标注只读", /只读|read-only/i.test(banner), banner);
    const l = await fetch(`http://127.0.0.1:8421/login?k=${TOK}`, { redirect: "manual" });
    const cookie = (l.headers.get("set-cookie") || "").split(";")[0];
    let r = await invoke(8421, "list_dir", { path: "F:\\cargotarget\\webtest-fixtures" }, cookie);
    ok("B28 只读可浏览", r.ok === true);
    r = await invoke(8421, "create_dir", { parent: "F:\\cargotarget\\webtest-fixtures", name: "ro-test" }, cookie);
    ok("B28 写命令拒 READ_ONLY", r.ok === false && String(r.error).startsWith("READ_ONLY|"), JSON.stringify(r));
    const boundary = "----rdtest-b28";
    const up = await fetch("http://127.0.0.1:8421/api/upload?dir=F:\\cargotarget\\webtest-fixtures", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="ro.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    });
    ok("B28 上传拒 403", up.status === 403, String(up.status) + " " + JSON.stringify(await up.json().catch(() => null)));
    r = await invoke(8421, "sftp_connect", {
      server: { id: "kube@172.20.214.44:2222", name: "WSL", host: "172.20.214.44", port: 2222,
        user: "kube", auth: "publicKey", keyPath: "C:\\Users\\Admin\\.ssh\\id_ed25519", savePassphrase: false },
    }, cookie);
    ok("B28 只读可连接", r.ok === true, JSON.stringify(r).slice(0, 120));
    r = await invoke(8421, "sftp_download", { path: "sftp://kube@172.20.214.44:2222/home/kube/rdir-webtest/report-data.csv", localDir: null }, cookie);
    ok("B28 远程下载(缓存写)照常", r.ok === true, JSON.stringify(r).slice(0, 120));
  } finally { proc.kill(); }
}

// ── B29 便携标记 ──
{
  const dir = "F:\\cargotarget\\webtest-portable";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(EXE, dir + "\\rdir-web.exe");
  writeFileSync(dir + "\\R-Dir.portable", "");
  const { proc, banner } = await start2(dir + "\\rdir-web.exe", ["--listen", "127.0.0.1:8422", "--token", TOK]);
  try {
    ok("B29 数据落便携目录", banner.includes(dir + "\\data\\config"), banner);
    const l = await fetch(`http://127.0.0.1:8422/login?k=${TOK}`, { redirect: "manual" });
    const cookie = (l.headers.get("set-cookie") || "").split(";")[0];
    await invoke(8422, "prefs_save", { prefs: { b29probe: true } }, cookie);
  } finally { proc.kill(); }
  ok("B29 目录真实创建", existsSync(dir + "\\data\\config"));
}

// ── B32 0.0.0.0 banner 提示 ──
{
  const dir = "F:\\cargotarget\\webtest-b32";
  rmSync(dir, { recursive: true, force: true });
  const { proc, banner } = await start(["--listen", "0.0.0.0:8423", "--token", TOK, "--data-dir", dir]);
  proc.kill();
  console.log("[banner]", banner.split("\n").join(" | ").slice(0, 400));
  ok("B32 0.0.0.0 监听有安全提示", /0\.0\.0\.0/.test(banner) && /(提示|警告|暴露|反代|TLS|局域网)/.test(banner), banner);
}

// ── B4 随机 token 重启后旧 cookie 失效 ──
{
  const dir = "F:\\cargotarget\\webtest-b4";
  rmSync(dir, { recursive: true, force: true });
  const first = await start(["--listen", "127.0.0.1:8424", "--data-dir", dir]);
  const url1 = first.banner.match(/http:\/\/\S+\/login\?k=\S+/)?.[0];
  ok("B4 banner 打印进站链接", !!url1, first.banner);
  const l = await fetch(url1, { redirect: "manual" });
  const oldCookie = (l.headers.get("set-cookie") || "").split(";")[0];
  ok("B4 首次登录得 cookie", l.status === 303 && oldCookie.includes("rdir_token"));
  first.proc.kill();
  await new Promise((r) => setTimeout(r, 800));
  const second = await start(["--listen", "127.0.0.1:8424", "--data-dir", dir]);
  try {
    // 新随机 token 实例存活时,旧 cookie(token A 签发)必须 401
    await new Promise((r) => setTimeout(r, 500));
    const probe = await fetch("http://127.0.0.1:8424/api/invoke", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: oldCookie },
      body: JSON.stringify({ cmd: "get_home_dir", args: {} }),
    });
    ok("B4 重启后旧 cookie 401", probe.status === 401, String(probe.status));
  } finally { second.proc.kill(); }
}

console.log(`\nCLI-REGRESSION ALL DONE: ${pass} checks passed`);
