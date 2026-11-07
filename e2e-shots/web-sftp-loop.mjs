// B14–B19/B21/B23–B24/B13:SFTP 全环 API 级回归(树莓派 = 密码认证目标)
// 纯 fetch 走 /api/invoke 桥(与 UI 同链路),远端真相用 ssh 核验
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";

const BASE = "http://127.0.0.1:8420";
const TOK = "e2e0deadbeefcafe0123456789abcdef";
const FIX = "F:\\cargotarget\\webtest-fixtures";
const FIXW = "/f/cargotarget/webtest-fixtures";
const PI = "kali@192.168.31.100";
const PID = "kali@192.168.31.100:22"; // 派生 id(user@host:port)=池键
const RDIR = "sftp://kali@192.168.31.100/home/kali/rdir-webtest";
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
let pass = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) throw new Error(`FAIL ${name} ${extra}`);
  pass++;
  console.log("[pass]", name);
};
const ssh = (c) => execSync(`ssh -o BatchMode=yes -o ConnectTimeout=8 ${PI} "${c}"`, { encoding: "utf8", timeout: 30000 });

// ── 清场(上轮残留,保证幂等)──
try { ssh("rm -rf ~/rdir-webtest/webtest-d1 ~/rdir-webtest/webtest-f1.txt ~/rdir-webtest/webtest-f2.txt ~/rdir-webtest/b16.txt ~/rdir-webtest/b24-right.txt"); } catch {}
try { rmSync(`${FIXW}/b16.txt`); } catch {}
try { rmSync(`${FIXW}/b24-left.txt`); } catch {}

// ── 登录取 cookie ──
const loginRes = await fetch(`${BASE}/login?k=${TOK}`, { redirect: "manual" });
const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
ok("B3 登录 303+cookie", loginRes.status === 303 && cookie.includes("rdir_token"));

const invoke = async (cmd, args = {}) => {
  const r = await fetch(`${BASE}/api/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ cmd, args }),
  });
  return r.json();
};

// ── 种 Pi 服务器(密码认证,本次会话不存盘——master-key 流程 B20 单独测)──
const piServer = {
  id: "pi-kali-custom-check", // 故意传自定义 id:后端必须归一成派生键(下方断言)
  name: "Pi-kali",
  host: "192.168.31.100",
  port: 22,
  user: "kali",
  root: "/home/kali/rdir-webtest",
  group: "",
  auth: "password",
  password: "hwx1515661",
  savePassword: false,
};
let r = await invoke("sftp_save_server", { server: piServer });
ok("B14 前置:保存服务器", r.ok === true, JSON.stringify(r));
const views0 = await invoke("sftp_list_servers");
ok("id 归一:存盘 id=派生键", JSON.stringify(views0).includes(PID) && !JSON.stringify(views0).includes("pi-kali-test"), JSON.stringify(views0).slice(0, 300));

// ── B14 连接 + 浏览 ──
r = await invoke("sftp_connect", { server: piServer });
ok("B14 连接", r.ok === true, JSON.stringify(r).slice(0, 200));
r = await invoke("list_dir", { path: RDIR });
ok("B14 浏览远程目录", r.ok === true && Array.isArray(r.data), JSON.stringify(r).slice(0, 150));

// ── B15 远端写链路:mkdir → create → rename → delete ──
r = await invoke("sftp_mkdir", { dir: RDIR, name: "webtest-d1" });
ok("B15 mkdir", r.ok === true, JSON.stringify(r).slice(0, 150));
ok("B15 mkdir ssh 核验", ssh("test -d ~/rdir-webtest/webtest-d1 && echo Y").includes("Y"));
r = await invoke("sftp_create_file", { dir: RDIR, name: "webtest-f1.txt" });
ok("B15 create_file", r.ok === true, JSON.stringify(r).slice(0, 150));
r = await invoke("sftp_rename", { path: `${RDIR}/webtest-f1.txt`, newName: "webtest-f2.txt" });
ok("B15 rename", r.ok === true, JSON.stringify(r).slice(0, 150));
ok("B15 rename ssh 核验", ssh("test -f ~/rdir-webtest/webtest-f2.txt && echo Y").includes("Y"));
r = await invoke("sftp_delete", { paths: [`${RDIR}/webtest-f2.txt`] });
ok("B15 delete", r.ok === true, JSON.stringify(r).slice(0, 150));
ok("B15 delete ssh 核验", !ssh("ls ~/rdir-webtest/").includes("webtest-f2"));
r = await invoke("sftp_delete", { paths: [`${RDIR}/webtest-d1`] });
ok("B15 rmdir 清场", r.ok === true);

// ── B16 远程文件双击打开(前端链路:sftp_download 落临时 → /api/file 流式)──
const content16 = "B16-内容-双击打开-中文";
r = await invoke("sftp_create_file", { dir: RDIR, name: "b16.txt" });
r = await invoke("write_text_file", { path: `${RDIR}/b16.txt`, lines: [content16], eol: "lf" });
ok("B16 写入远端文件", r.ok === true, JSON.stringify(r).slice(0, 150));
r = await invoke("sftp_download", { path: `${RDIR}/b16.txt`, localDir: null });
ok("B16 sftp_download 预取", r.ok === true, JSON.stringify(r).slice(0, 150));
const tempLocal = r.data?.data ?? r.data;
const f = await fetch(`${BASE}/api/file?path=${encodeURIComponent(String(tempLocal))}`, { headers: { Cookie: cookie } });
ok("B16 /api/file 200", f.status === 200, String(f.status));
ok("B16 内容一致", (await f.text()).replace(/\n$/, "") === content16);

// ── B17 远程 → 本地(sftp_download_to)──
r = await invoke("sftp_download_to", { localDir: FIX, path: `${RDIR}/b16.txt`, overwrite: true });
ok("B17 download_to 调用", r.ok === true, JSON.stringify(r).slice(0, 150));
const localPath = typeof r.data === "string" ? r.data : `${FIX}\\b16.txt`;
ok("B17 本地落盘", existsSync(localPath) && readFileSync(localPath, "utf8").replace(/\r?\n$/, "") === content16);

// ── B19 断开 → 重连 ──
r = await invoke("sftp_disconnect", { id: PID });
ok("B19 断开", r.ok === true, JSON.stringify(r).slice(0, 120));
let views = await invoke("sftp_list_servers");
ok("B19 断开后 connected=false", JSON.stringify(views).includes('"connected":false'));
r = await invoke("sftp_connect", { server: piServer });
ok("B19 重连", r.ok === true, JSON.stringify(r).slice(0, 150));
r = await invoke("list_dir", { path: RDIR });
ok("B19 重连后可浏览", r.ok === true);

// ── B21 导出 → 删除 → 导入(合并按 id 去重)──
const exportPath = "F:\\cargotarget\\webtest-data\\sftp-export.json";
r = await invoke("sftp_export_servers", { target: exportPath, exportedAt: new Date().toISOString() });
ok("B21 导出", r.ok === true && existsSync(exportPath), JSON.stringify(r).slice(0, 150));
r = await invoke("sftp_remove_server", { id: PID });
ok("B21 删除服务器", r.ok === true);
views = await invoke("sftp_list_servers");
ok("B21 清单已空", !JSON.stringify(views).includes("kali@192.168.31.100:22"));
r = await invoke("sftp_import_servers", { filePath: exportPath });
ok("B21 导入", r.ok === true, JSON.stringify(r).slice(0, 200));
views = await invoke("sftp_list_servers");
ok("B21 导入恢复", JSON.stringify(views).includes("kali@192.168.31.100:22"));

// ── B23 目录比对 local × sftp(level 2)──
r = await invoke("diff_dirs", { id: "t-b23", left: FIX, right: RDIR, level: 2, caseSensitive: false, mtimeToleranceMs: 1000 });
const diffOut = r.data?.data ?? r.data;
ok("B23 diff_dirs", r.ok === true && Array.isArray(diffOut?.entries) && diffOut.entries.length > 0 && diffOut.cancelled === false,
  JSON.stringify(diffOut).slice(0, 200));

// ── B24 文本比较 local × sftp + 回写往返 ──
const localTxt = `${FIX}\\b24-left.txt`;
writeFileSync(localTxt, "line1\nline2-local\n", "utf8");
r = await invoke("write_text_file", { path: `${RDIR}/b24-right.txt`, lines: ["line1", "line2-remote"], eol: "lf" });
ok("B24 write_text sftp", r.ok === true, JSON.stringify(r).slice(0, 150));
r = await invoke("diff_text_files", { left: localTxt, right: `${RDIR}/b24-right.txt` });
const diffData = r.data?.data ?? r.data;
const segCount = diffData?.segments?.length ?? 0;
ok("B24 diff 有 segments", r.ok === true && segCount > 0, JSON.stringify(r).slice(0, 250));
const newLines = ["line1", "line2-本地回写"];
r = await invoke("write_text_file", { path: `${RDIR}/b24-right.txt`, lines: newLines, eol: "lf" });
ok("B24 回写调用", r.ok === true, JSON.stringify(r).slice(0, 150));
r = await invoke("read_text_file", { path: `${RDIR}/b24-right.txt` });
const readBack = r.data?.data ?? r.data;
ok("B24 回写往返一致", readBack?.text?.replace(/\n$/, "") === newLines.join("\n"), JSON.stringify(readBack).slice(0, 200));
ok("B24 ssh 核验回写", ssh("cat ~/rdir-webtest/b24-right.txt").includes("本地回写"));

// ── B13 搜索/检索/指纹 ──
writeFileSync(`${FIX}\\b13-needle.txt`, "alpha-content\n", "utf8");
r = await invoke("search_content", { query: "alpha", dir: FIX, recursive: true, caseSensitive: false, includeHidden: false, useRegex: false });
ok("B13 内容搜索", r.ok === true && JSON.stringify(r.data).includes("b13-needle.txt"), JSON.stringify(r).slice(0, 150));
r = await invoke("find_files", { pattern: "*.csv", dir: FIX, showHidden: false, maxDepth: null, glob: true, caseSensitive: false });
ok("B13 文件检索", r.ok === true && JSON.stringify(r.data).includes(".csv"));
const fpContent = readFileSync(`${FIX}\\report-data.csv`, "utf8");
r = await invoke("file_fingerprints", { paths: [`${FIX}\\report-data.csv`] });
ok("B13 MD5 指纹一致", JSON.stringify(r.data).toLowerCase().includes(md5(fpContent)), `${md5(fpContent)} vs ${JSON.stringify(r).slice(0, 200)}`);

console.log(`\nSFTP-LOOP ALL DONE: ${pass} checks passed`);
