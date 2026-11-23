import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 素/雅性能对比套件（v0.49,由方案「性能测试方案」落地）：
 * - 场景：S1 菜单组展开收起 ×40；S2 详情列表拖拽横扫；S3 大图标拖拽槽位横扫
 *   （雅=挤开预览 on）；S4 拖影跟随锯齿移动；S5 松手落位。
 * - 规模：/mock/perf 合成目录 200 / 1000 / 4000 条（拦截 list_dir 生成）。
 * - 指标：页内 rAF 帧间隔（fps/avg/p95/p99）+ PerformanceObserver longtask +
 *   JS 堆（performance.memory）。进程级 CPU/GPU 需真机 WebView2 CDP 附着采集
 *   （工作站锁屏暂缓,见 tools/perf-anim-report.md 说明）。
 * - 产物：单行 JSON 打到 stdout（__PERF_JSON__ 前缀）,由调用方 bash 提取落盘到
 *   e2e-shots/perf-anim.json → node tools/perf-anim-report.mjs 生成对比表。
 *   （不直接写文件:playwright worker 在沙箱环境的文件写会进覆盖层丢弃,实测。）
 * - 验收线（方案）：雅 @1000 拖拽横扫 ≥50fps、p95 ≤33ms、longtask>100ms = 0。
 */
const SIZES = [200, 1000, 4000];
const MODES = ["plain", "elegant"] as const;
const HOME = "/mock/home";

type Metrics = {
  frames: number;
  fps: number;
  durationMs: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  longtasks: number[];
  longtaskMax: number;
  heapMB: number;
};

async function seedOnce(page: import("@playwright/test").Page) {
  await installTauriMock(page);
  // 只注册一次（addInitScript 会叠加）：参数经 localStorage 惰性读取——
  // 每轮先 setItem(perf-n / perf-mode) 再 reload,init 脚本读到的即本轮参数
  await page.addInitScript(() => {
    const n = Number(localStorage.getItem("perf-n") || "0");
    const mode = localStorage.getItem("perf-mode") || "plain";
    try {
      localStorage.setItem("rfm.anim-level-v2", mode);
    } catch {
      /* ignore */
    }
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    };
    const orig = w.__TAURI_INTERNALS__!.invoke.bind(w.__TAURI_INTERNALS__);
    w.__TAURI_INTERNALS__!.invoke = (cmd: string, args?: unknown) => {
      if (cmd === "list_dir" && (args as { path?: string })?.path === "/mock/perf") {
        const entries = [];
        for (let i = 0; i < n; i++) {
          const name = `item-${String(i).padStart(4, "0")}.dat`;
          entries.push({
            name,
            path: `/mock/perf/${name}`,
            is_dir: false,
            is_symlink: false,
            size: 1024 + i,
            modified: 1_700_000_000_000 + i * 1000,
            created: null,
            permissions: "rw-r--r--",
            extension: "dat",
          });
        }
        return Promise.resolve(entries);
      }
      return orig(cmd, args);
    };
    // 捕获层取消 dragstart（原生 HTML5 拖拽会让 mousemove 停发,引擎 A 不跑）
    window.addEventListener("dragstart", (e) => e.preventDefault(), true);
    // rAF 采样器 + longtask 观察器
    const w2 = window as unknown as {
      __frames: number[];
      __fpsOn: boolean;
      __longtasks: number[];
    };
    w2.__frames = [];
    w2.__fpsOn = false;
    w2.__longtasks = [];
    const tick = (t: number) => {
      if (w2.__fpsOn) w2.__frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w2.__longtasks.push(e.duration);
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* 老引擎无 longtask */
    }
  });
}

async function sampleStart(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __frames: number[];
      __longtasks: number[];
      __fpsOn: boolean;
      __t0?: number;
    };
    w.__frames = [];
    w.__longtasks = [];
    w.__t0 = performance.now();
    w.__fpsOn = true;
  });
}

async function sampleStop(page: import("@playwright/test").Page): Promise<Metrics> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __frames: number[];
      __longtasks: number[];
      __fpsOn: boolean;
      __t0?: number;
    };
    w.__fpsOn = false;
    const f = w.__frames;
    const deltas: number[] = [];
    for (let i = 1; i < f.length; i++) deltas.push(f[i] - f[i - 1]);
    deltas.sort((a, b) => a - b);
    const q = (p: number) =>
      deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] : 0;
    const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const durationMs = w.__t0 ? performance.now() - w.__t0 : 0;
    return {
      frames: f.length,
      // headless 无 vsync 语义下这是 rAF 帧产率（>60 = 主线程有余裕）,不作刷新率解读
      fps: durationMs > 0 ? Math.round((f.length / durationMs) * 1000) : 0,
      durationMs: +durationMs.toFixed(0),
      avgMs: +avg.toFixed(2),
      p95Ms: +q(0.95).toFixed(2),
      p99Ms: +q(0.99).toFixed(2),
      longtasks: w.__longtasks,
      longtaskMax: w.__longtasks.length ? Math.max(...w.__longtasks) : 0,
      heapMB: +(
        ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? 0) / 1048576
      ).toFixed(1),
    };
  });
}

test("素/雅性能对比套件（stdout 输出 __PERF_JSON__ 单行 JSON）", async ({ page }) => {
  // 性能画像仅本地跑：CI 的 e2e 是行为门禁，不跑基准（mac runner 上本套件要
  // 7min+，v0.49.0 曾因此顶爆 release.yml test job 的 30min 上限——已改 60min
  // 并在此跳过；本地跑法与 JSON 提取见 tools/perf-anim-report.mjs 头注）
  test.skip(!!process.env.CI, "性能画像套件仅本地跑（CI 行为门禁不含基准）");
  test.setTimeout(480_000);
  const runs: { mode: string; size: number; scenario: string; metrics: Metrics }[] = [];
  await seedOnce(page);

  for (const mode of MODES) {
    for (const size of SIZES) {
      // 同页 reload 换参数（init 脚本只注册一次,参数走 localStorage）
      await page.goto("/");
      await page.evaluate(
        ([m, n]) => {
          localStorage.setItem("perf-mode", m);
          localStorage.setItem("perf-n", String(n));
        },
        [mode, size],
      );
      await page.reload();
      await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();

      // 导航到合成目录（mac 上 mod=⌘ 即 Meta，win/linux mod=Ctrl；本套件仅本地跑，
      // 按运行机平台选修饰键——写死 Control+l 在 mac 上匹配不到 mod+l 绑定）
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+l`);
      await page.locator("#rdir-addr-input").fill("/mock/perf");
      await page.keyboard.press("Enter");
      await expect(page.locator('[role="row"]').first()).toBeVisible({ timeout: 15_000 });

      // 预热轮：承担 vite 模块编译 + 首次大目录渲染成本,不采样（否则冷启动伪影
      // 全落在首个素用例上,素/雅对比失真）
      await page.locator('[role="row"]').first().click({ button: "right" });
      await page.keyboard.press("Escape");
      const warmRow = page.locator('[role="row"]').nth(2);
      await warmRow.click();
      await page.locator('[data-view-switch] button[data-view-mode="icons"]').click();
      await expect(page.locator("[data-grid-item]").first()).toBeVisible({ timeout: 15_000 });
      const warmItem = page.locator("[data-grid-item]").nth(1);
      const wb = await warmItem.boundingBox();
      await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2);
      await page.mouse.down();
      await page.mouse.move(wb.x + wb.width / 2 + 300, wb.y + wb.height / 2 + 60, { steps: 6 });
      await page.mouse.up();
      await page.locator('[data-view-switch] button[data-view-mode="details"]').click();
      await expect(page.locator('[role="row"]').first()).toBeVisible({ timeout: 15_000 });

      // S1 菜单组展开收起 ×40（详情列表行右键 → 菜单组展开/收起循环 → Esc）
      await sampleStart(page);
      for (let i = 0; i < 40; i++) {
        await page.locator('[role="row"]').first().click({ button: "right" });
        const group = page.locator('[data-testid^="menu-group-"]').first();
        await group.click();
        await group.click();
        await page.keyboard.press("Escape");
      }
      runs.push({ mode, size, scenario: "S1-menu-toggle", metrics: await sampleStop(page) });

      // S2 详情列表拖拽横扫（选中一行按住,纵向扫过 30 行间距）
      const row = page.locator('[role="row"]').nth(2);
      await row.click(); // 先选中（选中行按下=拖拽候选）
      const rb = await row.boundingBox();
      await sampleStart(page);
      await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 30; i++) {
        await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2 + i * 26, { steps: 2 });
      }
      await page.mouse.up();
      runs.push({ mode, size, scenario: "S2-list-drag-sweep", metrics: await sampleStop(page) });

      // S3/S4/S5 大图标模式
      await page.locator('[data-view-switch] button[data-view-mode="icons"]').click();
      await expect(page.locator("[data-grid-item]").first()).toBeVisible({ timeout: 15_000 });
      const item = page.locator("[data-grid-item]").nth(1);
      const ib = await item.boundingBox();

      // S3 槽位横扫：按住拖过 12 个槽位（雅=挤开预览重算）
      await sampleStart(page);
      await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(ib.x + ib.width / 2 + i * 96, ib.y + ib.height / 2, { steps: 3 });
      }
      runs.push({ mode, size, scenario: "S3-grid-slot-sweep", metrics: await sampleStop(page) });

      // S4 拖影跟随锯齿移动 ~40 步
      await sampleStart(page);
      for (let i = 1; i <= 40; i++) {
        await page.mouse.move(
          ib.x + ib.width / 2 + 96 * 12 - i * 24,
          ib.y + ib.height / 2 + (i % 2 ? 40 : -30),
          { steps: 2 },
        );
      }
      runs.push({ mode, size, scenario: "S4-ghost-zigzag", metrics: await sampleStop(page) });

      // S5 松手落位（雅=插入推移落盘重排）
      await sampleStart(page);
      await page.mouse.up();
      await page.waitForTimeout(600);
      runs.push({ mode, size, scenario: "S5-drop-finalize", metrics: await sampleStop(page) });
    }
  }

  // 单行 JSON 到 stdout（__PERF_JSON__ 前缀,调用方 bash 提取落盘）
  console.log(
    "__PERF_JSON__" +
      JSON.stringify({
        meta: {
          when: new Date().toISOString(),
          ua: await page.evaluate(() => navigator.userAgent),
          note: "headless chromium：主线程帧生产成本代理;进程级 CPU/GPU 待真机 WebView2 附着补测",
        },
        runs,
      }),
  );
  // 质量门：每个场景必须采到帧（采样链断了立即失败,不留全零数据）
  for (const r of runs) expect(r.metrics.frames).toBeGreaterThan(10);
});
