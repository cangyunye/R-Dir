#!/usr/bin/env node
// web 桥覆盖审计:桌面命令全集 vs web_commands! 桥表 vs 「刻意不桥」登记。
// 桌面端存在、既未桥接又未登记豁免的命令 = 漏桥,退出码 1。
// 新增刻意不桥命令时必须同步更新下方 UNBRIDGED 分类注释与 docs/web-handoff.md §1.3。
import { readFileSync } from "node:fs";

const LIB = new URL("../src-tauri/src/lib.rs", import.meta.url);
const BRIDGE = new URL("../src-tauri/src/web/bridge.rs", import.meta.url);

/** 「刻意不桥」登记(41 个,与 docs/web-handoff.md §1.3 对应;防"顺手漏桥"的豁免清单) */
const UNBRIDGED = {
  "NFS 伴生插件族(产品决策:web 不提供 NFS)": [
    "nfs_mkdir", "nfs_create_file", "nfs_delete", "nfs_rename", "nfs_upload",
    "nfs_download", "nfs_download_to",
    "nfs_plugin_install_online", "nfs_plugin_import", "nfs_plugin_status", "nfs_plugin_uninstall",
  ],
  "服务端/本机执行族(远端执行无意义,将来统一归 --allow-exec)": [
    "open_terminal", "open_local_file", "open_with", "open_vscode", "open_git_tool",
    "open_quick_tool", "open_terminal",
    "run_command", "complete_commands",
    "detect_editors", "vscode_detected",
    "list_openers", "add_custom_opener", "remove_custom_opener", "set_opener_extensions",
    "list_quick_tools", "add_quick_tool", "remove_quick_tool", "move_quick_tool", "set_quick_tool_args",
    "list_shells", "list_git_tools",
  ],
  "桌面 shell 专属(浏览器沙箱内做不到)": [
    "allow_exit", "drag_out_files", "query_modifiers",
    "clipboard_read_files", "clipboard_write_files", "clipboard_clear_files",
    "share_create", "share_list", "share_stop", "share_stop_by_dir",
  ],
};
const EXEMPT = new Set(Object.values(UNBRIDGED).flat());

function stripNoise(block) {
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#[") && !l.startsWith("//"));
}

// ── 桌面命令全集:generate_handler![ ... ]); ──
const lib = readFileSync(LIB, "utf8");
const gi = lib.indexOf("generate_handler!");
if (gi < 0) throw new Error("lib.rs 找不到 generate_handler!");
const gj = lib.indexOf("]);", gi);
const desktop = new Set(
  (stripNoise(lib.slice(gi, gj)).join(" ").match(/[a-z_][a-z0-9_]*\s*,/g) ?? [])
    .map((s) => s.replace(/[\s,]/g, "")),
);
// 收尾最后一个无逗号条目
const tailM = stripNoise(lib.slice(gi, gj)).join(" ").match(/([a-z_][a-z0-9_]*)\s*\]?$/);
if (tailM) desktop.add(tailM[1]);
desktop.delete("generate_handler");

// ── web 桥表:web_commands! { "name" => c_xxx, ... } ──
const bridge = readFileSync(BRIDGE, "utf8");
const bi = bridge.indexOf("web_commands!");
if (bi < 0) throw new Error("bridge.rs 找不到 web_commands!");
const bj = bridge.indexOf("\n}", bi);
const web = new Set(
  (bridge.slice(bi, bj).match(/"([a-z_0-9]+)"\s*=>/g) ?? []).map((s) => s.match(/"([a-z_0-9]+)"/)[1]),
);

// ── 比对 ──
const missing = [...desktop].filter((c) => !web.has(c) && !EXEMPT.has(c)).sort();
const extraExempt = [...EXEMPT].filter((c) => !desktop.has(c)).sort();
const webOnly = [...web].filter((c) => !desktop.has(c)).sort();

console.log(`桌面命令 ${desktop.size} / web 桥接 ${web.size} / 登记不桥 ${EXEMPT.size}`);
for (const [cat, list] of Object.entries(UNBRIDGED)) {
  const hit = list.filter((c) => desktop.has(c)).length;
  console.log(`  豁免·${cat}: ${hit}/${list.length}`);
}
if (webOnly.length) console.log(`[warn] 仅 web 有、桌面无(检查是否命名笔误): ${webOnly.join(" ")}`);
if (extraExempt.length) console.log(`[warn] 豁免清单里有但桌面已不存在的命令(清理登记): ${extraExempt.join(" ")}`);
if (missing.length) {
  console.error(`\n[FAIL] ${missing.length} 个桌面命令未桥接且未登记豁免:\n  ${missing.join("\n  ")}`);
  console.error("处理:在 bridge.rs web_commands! 桥接,或按 docs/web-handoff.md §1.3 分类登记进本脚本 UNBRIDGED。");
  process.exit(1);
}
console.log("\n覆盖审计通过:无漏桥命令。");
