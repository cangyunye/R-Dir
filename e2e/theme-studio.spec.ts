import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const TOGGLE = `${MOD}+Alt+p`;

/** 与 examples/themes/blueberry 同形的最小夹具：主色系 275°，功能色各占一角 */
const BLUEBERRY = {
  id: "blueberry",
  name: "蓝莓",
  author: "cangyunye",
  version: "1.0.0",
  base: "dark",
  tokens: {
    "--background": "oklch(0.185 0.035 275)",
    "--primary": "oklch(0.68 0.15 275)",
    "--folder": "oklch(0.8 0.14 75)",
    "--border": "oklch(1 0 0 / 12%)",
  },
};

type Saved = { pack: Record<string, unknown>; path?: string };

/**
 * 在 tauri-mock 之上桩化主题命令：themes_list 返回内存列表，theme_save 写入该列表并回传，
 * theme_export 只记录参数。调用记录挂在 window.__rdirThemeCalls 供断言。
 */
async function mockThemes(page: Page) {
  await installTauriMock(page);
  await page.addInitScript((seed) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => unknown };
      __rdirThemeCalls: { save: Saved[]; export: Saved[] };
    };
    const packs: Record<string, unknown>[] = [seed];
    w.__rdirThemeCalls = { save: [], export: [] };
    const orig = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "themes_list") return Promise.resolve({ packs, errors: [] });
      if (cmd === "theme_save") {
        const pack = args!.pack as Record<string, unknown>;
        const idx = packs.findIndex((p) => p.id === pack.id);
        if (idx >= 0) packs[idx] = pack;
        else packs.push(pack);
        w.__rdirThemeCalls.save.push({ pack });
        return Promise.resolve(pack);
      }
      if (cmd === "theme_export") {
        w.__rdirThemeCalls.export.push({ pack: args!.pack as Record<string, unknown>, path: args!.path as string });
        return Promise.resolve(null);
      }
      return orig(cmd, args);
    };
  }, BLUEBERRY);
}

const htmlVar = (page: Page, name: string) =>
  page.locator("html").evaluate((n, k) => (n as HTMLElement).style.getPropertyValue(k).trim(), name);

const themeCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rdirThemeCalls: { save: Saved[]; export: Saved[] } }).__rdirThemeCalls);

test.describe("主题调色盘（v0.39）", () => {
  test.beforeEach(async ({ page }) => {
    await mockThemes(page);
    await page.addInitScript(() => localStorage.setItem("rfm.themePack", "blueberry"));
    await page.goto("/");
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "blueberry");
  });

  test("S1 快捷键打开：以当前主题包为起点，草稿立即压过当前主题", async ({ page }) => {
    await page.keyboard.press(TOGGLE);
    const drawer = page.getByTestId("theme-studio-drawer");
    await expect(drawer).toHaveClass(/translate-x-0/);
    await expect(page.getByTestId("theme-studio-name")).toHaveValue("蓝莓");
    await expect(page.getByTestId("theme-studio-id")).toHaveValue("blueberry-custom");
    // 草稿 id 写到 data-theme；全量 23 token 落到内联样式（包里没写的回落深色内置）
    await expect(page.locator("html")).toHaveAttribute("data-theme", "blueberry-custom");
    expect(await htmlVar(page, "--primary")).toBe("oklch(0.68 0.15 275)");
    expect(await htmlVar(page, "--card")).toBe("oklch(0.19 0.012 260)");
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("S2 点色块弹滑杆，拖动即整个界面实时变色；收回墙内草稿保留，再按展开", async ({ page }) => {
    await page.keyboard.press(TOGGLE);
    await page.getByTestId("theme-swatch-primary").click();
    const hue = page.getByRole("slider", { name: "色相", exact: true });
    await expect(hue).toBeVisible();
    await hue.focus();
    await page.keyboard.press("Home");
    expect(await htmlVar(page, "--primary")).toBe("oklch(0.68 0.15 0)");
    await page.waitForTimeout(1400); // 等 splash 淡出再截图
    await page.screenshot({ path: "e2e-shots/theme-studio-popover.png" });
    await page.keyboard.press("Escape");

    // 收回：面板滑出视口、把手出现，草稿仍生效（全宽审视整体配色）
    await page.keyboard.press(TOGGLE);
    await expect(page.getByTestId("theme-studio-drawer")).toHaveClass(/translate-x-full/);
    await expect(page.getByTestId("theme-studio-handle")).toBeVisible();
    expect(await htmlVar(page, "--primary")).toBe("oklch(0.68 0.15 0)");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "blueberry-custom");
    await page.waitForTimeout(300); // 等 200ms 滑出动画结束再截图
    await page.screenshot({ path: "e2e-shots/theme-studio-collapsed.png" });

    // 再按 / 点把手都能拉回，滑杆状态原样
    await page.keyboard.press(TOGGLE);
    await expect(page.getByTestId("theme-studio-drawer")).toHaveClass(/translate-x-0/);
    await page.getByTitle(/收回/).click();
    await expect(page.getByTestId("theme-studio-drawer")).toHaveClass(/translate-x-full/);
    await page.getByTestId("theme-studio-handle").click();
    await expect(page.getByTestId("theme-studio-drawer")).toHaveClass(/translate-x-0/);
    await expect(page.getByTestId("theme-studio-id")).toHaveValue("blueberry-custom");
  });

  test("S3 全局色相联动：主题色整体旋转，文件夹色不动", async ({ page }) => {
    await page.keyboard.press(TOGGLE);
    const hue = page.getByRole("slider", { name: "全局色相" });
    await hue.focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    const primary = await htmlVar(page, "--primary");
    const m = /^oklch\(0\.68 0\.15 ([\d.]+)\)$/.exec(primary);
    expect(m, primary).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(275);
    expect(await htmlVar(page, "--folder")).toBe("oklch(0.8 0.14 75)");
  });

  test("S4 设置 → 主题包 → 调色盘：打开抽屉并关掉设置", async ({ page }) => {
    await page.keyboard.press(`${MOD}+,`);
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByTestId("open-theme-studio").click();
    await expect(page.getByTestId("theme-studio-drawer")).toHaveClass(/translate-x-0/);
    await expect(page.getByTestId("open-theme-studio")).toBeHidden();
  });

  test("S5 存为主题包：全量 token + $schema 落盘并选用；关闭后配色保持", async ({ page }) => {
    await page.keyboard.press(TOGGLE);
    await page.getByTestId("theme-studio-name").fill("我的蓝莓");
    await page.getByTestId("theme-swatch-primary").click();
    await page.getByRole("slider", { name: "色相", exact: true }).focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Escape");
    await page.getByTestId("theme-studio-save").click();

    await expect.poll(async () => (await themeCalls(page)).save.length).toBe(1);
    const saved = (await themeCalls(page)).save[0].pack as {
      $schema: string;
      id: string;
      name: string;
      base: string;
      tokens: Record<string, string>;
    };
    expect(saved.$schema).toBe("rdir-theme/1");
    expect(saved.id).toBe("blueberry-custom");
    expect(saved.name).toBe("我的蓝莓");
    expect(saved.base).toBe("dark");
    expect(Object.keys(saved.tokens)).toHaveLength(23);
    expect(saved.tokens["--primary"]).toBe("oklch(0.68 0.15 0)");
    expect(await page.evaluate(() => localStorage.getItem("rfm.themePack"))).toBe("blueberry-custom");

    // 已保存 = 新起点，关闭不追问；主题包列表已含新包，关闭后仍是这套配色
    await page.getByTestId("theme-studio-close").click();
    await expect(page.getByTestId("theme-studio-drawer")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "blueberry-custom");
    expect(await htmlVar(page, "--primary")).toBe("oklch(0.68 0.15 0)");
  });

  test("S6 导出：经保存对话框取路径，theme_export 收到全量包", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rdirDialogSave: string }).__rdirDialogSave = "/mock/home/my.rdtheme.json";
    });
    await page.reload();
    await expect(page.locator(`[data-path="${HOME}/Notes.txt"]`)).toBeVisible();
    await page.keyboard.press(TOGGLE);
    await page.getByTestId("theme-studio-export").click();
    await expect.poll(async () => (await themeCalls(page)).export.length).toBe(1);
    const call = (await themeCalls(page)).export[0];
    expect(call.path).toBe("/mock/home/my.rdtheme.json");
    expect((call.pack as { $schema: string }).$schema).toBe("rdir-theme/1");
    expect(Object.keys((call.pack as { tokens: object }).tokens)).toHaveLength(23);
  });

  test("S7 关闭放弃草稿：回到原主题包配色", async ({ page }) => {
    await page.keyboard.press(TOGGLE);
    await page.getByTestId("theme-shadow-select").selectOption("none");
    expect(await htmlVar(page, "--shadow")).toBe("none");
    // 有改动 → 应用内确认框 → 点危险按钮"关闭" → 草稿丢弃，回到蓝莓
    await page.getByTestId("theme-studio-close").click();
    const confirmClose = page.getByText("关闭", { exact: true });
    await expect(confirmClose).toBeVisible();
    await confirmClose.click();
    await expect(page.getByTestId("theme-studio-drawer")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "blueberry");
    expect(await htmlVar(page, "--shadow")).toBe("0 16px 40px rgba(0, 0, 0, 0.55)");
  });
});
