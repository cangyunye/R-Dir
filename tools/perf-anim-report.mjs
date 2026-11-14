// 素/雅性能对比报告生成器：读 e2e-shots/perf-anim.json → tools/perf-anim-report.md
// 验收线（v0.49 方案）：雅 @1000 拖拽横扫 ≥50fps、p95 ≤33ms、longtask>100ms = 0
import { readFileSync, writeFileSync } from "fs";

const data = JSON.parse(readFileSync("e2e-shots/perf-anim.json", "utf8"));
const { runs, meta } = data;

const SIZES = [200, 1000, 4000];
const SCENARIOS = [
  ["S1-menu-toggle", "S1 菜单组展开收起×40"],
  ["S2-list-drag-sweep", "S2 详情列表拖拽横扫"],
  ["S3-grid-slot-sweep", "S3 大图标槽位横扫（雅=挤开预览）"],
  ["S4-ghost-zigzag", "S4 拖影跟随锯齿移动"],
  ["S5-drop-finalize", "S5 松手落位"],
];
const get = (mode, size, sc) =>
  runs.find((r) => r.mode === mode && r.size === size && r.scenario === sc)?.metrics;
const fmt = (m, key) => (m ? String(m[key]) : "—");

const lines = [];
lines.push("# v0.49 素/雅动效性能对比报告");
lines.push("");
lines.push(`- 采集时间：${meta.when}`);
lines.push(`- 环境：${meta.ua}`);
lines.push(`- ${meta.note}`);
lines.push(`- 规模：200 / 1000 / 4000 条合成目录（list_dir 拦截生成）；指标为页内 rAF 帧间隔与 PerformanceObserver longtask，JS 堆为 usedJSHeapSize。`);
lines.push("- 判读口径：headless chromium 的 fps/帧时 = **主线程帧生产成本代理**（合成器节流不影响 rAF 采样），用于素/雅相对对比与验收线初筛；真机 WebView2（Edge 157 + 根 zoom）的进程级 CPU/GPU/内存待工作站解锁后用 CDP 附着补测。");
lines.push("");
lines.push("## 帧产率 fps（rAF ticks/s,headless 无 vsync,>60 表示主线程有余裕;绝对值不作刷新率解读）");
lines.push("");
for (const [sc, label] of SCENARIOS) {
  lines.push(`### ${label}`);
  lines.push("");
  lines.push("| 规模 | 素 fps | 雅 fps | Δ |");
  lines.push("| --- | --- | --- | --- |");
  for (const size of SIZES) {
    const p = get("plain", size, sc);
    const e = get("elegant", size, sc);
    const d = p && e ? e.fps - p.fps : null;
    lines.push(`| ${size} | ${fmt(p, "fps")} | ${fmt(e, "fps")} | ${d === null ? "—" : (d > 0 ? "+" : "") + d} |`);
  }
  lines.push("");
}
lines.push("## 帧时 p95 ms（越低越好,≤33ms ≈ 30fps 及格线）");
lines.push("");
for (const [sc, label] of SCENARIOS) {
  lines.push(`### ${label}`);
  lines.push("");
  lines.push("| 规模 | 素 p95 | 雅 p95 |");
  lines.push("| --- | --- | --- |");
  for (const size of SIZES) {
    const p = get("plain", size, sc);
    const e = get("elegant", size, sc);
    lines.push(`| ${size} | ${fmt(p, "p95Ms")} | ${fmt(e, "p95Ms")} |`);
  }
  lines.push("");
}
lines.push("## longtask（>100ms 的卡顿帧数 / 最大 longtask ms）");
lines.push("");
lines.push("| 场景 | 规模 | 素 | 雅 |");
lines.push("| --- | --- | --- | --- |");
for (const [sc, label] of SCENARIOS) {
  for (const size of SIZES) {
    const p = get("plain", size, sc);
    const e = get("elegant", size, sc);
    const cell = (m) =>
      m ? `${m.longtasks.filter((x) => x > 100).length} / ${m.longtaskMax}` : "—";
    lines.push(`| ${label} | ${size} | ${cell(p)} | ${cell(e)} |`);
  }
}
lines.push("");
lines.push("## JS 堆 MB（usedJSHeapSize,采集窗口结束时点）");
lines.push("");
lines.push("| 场景 | 规模 | 素 | 雅 |");
lines.push("| --- | --- | --- | --- |");
for (const [sc, label] of SCENARIOS) {
  for (const size of SIZES) {
    const p = get("plain", size, sc);
    const e = get("elegant", size, sc);
    lines.push(`| ${label} | ${size} | ${fmt(p, "heapMB")} | ${fmt(e, "heapMB")} |`);
  }
}
lines.push("");

// 验收线判定（雅 @1000 拖拽横扫 S2/S3/S4）
lines.push("## 验收线判定（方案口径）");
lines.push("");
lines.push("| 验收项 | 阈值 | 实测 | 判定 |");
lines.push("| --- | --- | --- | --- |");
const checks = [];
for (const sc of ["S2-list-drag-sweep", "S3-grid-slot-sweep", "S4-ghost-zigzag"]) {
  const e = get("elegant", 1000, sc);
  if (!e) continue;
  checks.push({
    item: `雅 @1000 ${sc} fps`,
    limit: "≥50",
    actual: e.fps,
    pass: e.fps >= 50,
  });
  checks.push({
    item: `雅 @1000 ${sc} p95 帧时`,
    limit: "≤33ms",
    actual: e.p95Ms,
    pass: e.p95Ms <= 33,
  });
  checks.push({
    item: `雅 @1000 ${sc} longtask>100ms`,
    limit: "0",
    actual: e.longtasks.filter((x) => x > 100).length,
    pass: e.longtasks.filter((x) => x > 100).length === 0,
  });
}
for (const c of checks) {
  lines.push(`| ${c.item} | ${c.limit} | ${c.actual} | ${c.pass ? "✅ PASS" : "❌ FAIL"} |`);
}
const allPass = checks.every((c) => c.pass);
lines.push("");
lines.push(`**总体判定：${allPass ? "✅ 全部通过" : "❌ 存在不达标项——按方案降级（rAF 节流/仅可见项）或回退对应动效"}**`);
lines.push("");
lines.push("## 待办");
lines.push("");
lines.push("- [ ] 真机 WebView2（Edge 157 + 根 zoom≈1.15）CDP 附着复测:进程级 CPU/GPU/内存 + rAF（工作站解锁后运行 `tools/perf-anim-cdp.mjs --port 9333`,或以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 启动后同参复跑）。");
lines.push("- [ ] 4000 条规模若 S3 雅 p95 超线 → 挤开预览 rAF 节流重算（当前逐 move 重算已做 shiftKey 去重）。");

writeFileSync("tools/perf-anim-report.md", lines.join("\n") + "\n");
console.log("report written: tools/perf-anim-report.md");
console.log("总体判定:", allPass ? "PASS" : "FAIL");
