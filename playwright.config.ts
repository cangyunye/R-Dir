import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 配置：针对前端 dev server（vite 1420）。
 * Tauri IPC 由 e2e/tauri-mock.ts 用 addInitScript 注入 __TAURI_INTERNALS__ 桩
 * （固定虚拟文件系统 /mock/home），因此用例可以断言真实数据与交互结果。
 * 首次运行需要：pnpm exec playwright install chromium
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:1420",
    // CI 行为门禁模拟系统「减弱动态效果」：CSS 对 reduce 强制 --rdir-anim-dur:0,
    // 等同「素」——e2e 断言不被 150ms 入场动画干扰（v0.49.0 mac runner 上雅默认
    // 曾致菜单点击稳定性检查风暴,大面积 30s 超时）。动画接线的正验由
    // anim-level.spec 显式 test.use({ reducedMotion: "no-preference" }) 继续
    // 跑真动画;本地默认同样 reduce,与 CI 一致。
    reducedMotion: "reduce",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
