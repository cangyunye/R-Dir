// B20:master-key 流程——设置→密码密文落盘→重启→未解锁拒连→解锁→可连
// 用法:node web-masterkey.mjs pre|post   (两次运行之间由外部重启服务)
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8420";
const TOK = "e2e0deadbeefcafe0123456789abcdef";
const MK = "mk-e2e-测试主密钥-1234";
const CFG = "F:\\cargotarget\\webtest-data\\config\\servers.json";
const PID = "kali@192.168.31.100:22";
const phase = process.argv[2];

let pass = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) throw new Error(`FAIL ${name} ${extra}`);
  pass++;
  console.log("[pass]", name);
};

const loginRes = await fetch(`${BASE}/login?k=${TOK}`, { redirect: "manual" });
const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
const invoke = async (cmd, args = {}) => {
  const r = await fetch(`${BASE}/api/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ cmd, args }),
  });
  return r.json();
};

const RDIR = "sftp://kali@192.168.31.100/home/kali/rdir-webtest";

if (phase === "pre") {
  // 1) 设置主密钥
  let r = await invoke("sftp_set_master_key", { key: MK });
  ok("设置主密钥", r.ok === true, JSON.stringify(r).slice(0, 150));
  r = await invoke("sftp_master_key_status");
  const st = r.data?.data ?? r.data;
  ok("状态 configured+active", st?.configured === true && st?.active === true, JSON.stringify(st));

  // 2) 保存 Pi 服务器且记住密码 → 密文落盘
  r = await invoke("sftp_save_server", {
    server: {
      id: PID, name: "Pi-kali", host: "192.168.31.100", port: 22, user: "kali",
      root: "/home/kali/rdir-webtest", group: "",
      auth: "password", password: "hwx1515661", savePassword: true,
    },
  });
  ok("保存(记住密码)", r.ok === true, JSON.stringify(r).slice(0, 150));
  const raw = readFileSync(CFG, "utf8");
  ok("密文前缀 enc:v1: 已落盘", raw.includes("enc:v1:") && !raw.includes("hwx1515661"));
  console.log("PRE-PHASE-DONE");
} else if (phase === "post") {
  // 0) 清掉同进程内可能残留的 Pi 活连接(否则 connect 命中"已连接"早退,测不到密文分支)
  await invoke("sftp_disconnect", { id: PID });
  // 3) 重启后:configured 但内存未解锁
  let r = await invoke("sftp_master_key_status");
  const st = r.data?.data ?? r.data;
  ok("重启后 configured 但未解锁", st?.configured === true && st?.active === false, JSON.stringify(st));

  // 4) 密码留空连接(回退存盘密文)→ 必须 NEED_MASTER_KEY
  r = await invoke("sftp_connect", {
    server: { id: PID, name: "Pi-kali", host: "192.168.31.100", port: 22, user: "kali",
      root: "/home/kali/rdir-webtest", auth: "password", password: "", savePassword: false },
  });
  ok("未解锁连接被拒 NEED_MASTER_KEY", r.ok === false && String(r.error).includes("NEED_MASTER_KEY"), JSON.stringify(r).slice(0, 150));

  // 5) 解锁(重输主密钥)→ 空密码重连成功
  r = await invoke("sftp_set_master_key", { key: MK });
  ok("主密钥解锁", r.ok === true, JSON.stringify(r).slice(0, 150));
  r = await invoke("sftp_connect", {
    server: { id: PID, name: "Pi-kali", host: "192.168.31.100", port: 22, user: "kali",
      root: "/home/kali/rdir-webtest", auth: "password", password: "", savePassword: false },
  });
  ok("解锁后空密码重连成功", r.ok === true, JSON.stringify(r).slice(0, 200));
  r = await invoke("list_dir", { path: RDIR });
  ok("解锁后可浏览", r.ok === true && Array.isArray(r.data?.data ?? r.data));

  // 6) 清场:删除服务器 + 复位主密钥
  await invoke("sftp_remove_server", { id: PID });
  r = await invoke("sftp_reset_master_key");
  ok("复位主密钥", r.ok === true, JSON.stringify(r).slice(0, 150));
  const raw = readFileSync(CFG, "utf8");
  ok("清场后无密文残留", !raw.includes("enc:v1:"));
  console.log("POST-PHASE-DONE");
} else {
  throw new Error("usage: node web-masterkey.mjs pre|post");
}
console.log(`B20-${phase}: ${pass} checks passed`);
