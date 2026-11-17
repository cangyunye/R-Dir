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
    // v0.49.1 起雅不受系统 reduce 影响（见 lib/anim.ts）,此模拟不再能全局关动画;
    // 行为门禁的「素」由 e2e/tauri-mock.ts 预置 rfm.anim-level-v2=plain 承担
    // （RDIR_E2E_ANIM=elegant 可让 mock 默认雅）,保留本行仅为语义显式。
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
