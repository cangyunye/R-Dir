import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 配置：针对前端 dev server（vite 1420）。
 * Tauri API（invoke/event）在浏览器里不可用，测试在 playwright/index.html
 * 用 mock 注入 window.__TAURI__ 桩。
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
