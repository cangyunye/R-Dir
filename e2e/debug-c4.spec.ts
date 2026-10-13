import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("debug C4", async ({ page }) => {
  page.on("console", (m) => {
    if (m.type() !== "warning") console.log("[console]", m.text());
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await installTauriMock(page);
  await page.addInitScript(() => {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__;
    if (internals) {
      const orig = internals.invoke.bind(internals);
      internals.invoke = (cmd: string, args?: unknown) => {
        if (!String(cmd).includes("event|") && !String(cmd).includes("fs_watch") && !String(cmd).includes("list_dir")) {
          console.info("[invoke]", cmd);
        }
        return orig(cmd, args);
      };
    }
  });
  await page.addInitScript(() => {
    const orig = console.info;
    console.info = (...a) => orig("[info]", ...a);
  });
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__rdirConflicts = (a: { dest: string }) =>
      a.dest === `${HOME}/Documents`
        ? [
            {
              src: `${HOME}/Notes.txt`,
              dest: `${HOME}/Documents/Notes.txt`,
              srcKind: "file",
              destKind: "file",
              suggest: "Notes_1.txt",
            },
          ]
        : [];
  });
  console.log("[step] split");
  await page.locator(`[data-path="${HOME}/Documents"]`).click();
  await page.keyboard.press(`${MOD}+Backslash`);
  await expect(page.locator(`[data-path="${HOME}/Documents"]`)).toHaveCount(2);
  await page.keyboard.press(`${MOD}+KeyL`);
  await page.locator("#rdir-addr-input").fill(`${HOME}/Documents`);
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-path="${HOME}/Documents/readme.md"]`)).toBeVisible();
  console.log("[step] copy Notes from left");
  await page.locator(`[data-path="${HOME}/Notes.txt"]`).first().click();
  await page.keyboard.press(`${MOD}+KeyC`);
  console.log("[step] activate right + paste");
  await page.locator(`[data-path="${HOME}/Documents/readme.md"]`).first().click();
  await page.keyboard.press(`${MOD}+KeyV`);
  await page.waitForTimeout(2500);
  console.log("[step] conflict dialog count =", await page.locator("[data-conflict-dialog]").count());
  console.log("[step] Notes in Documents count =", await page.locator(`[data-path="${HOME}/Documents/Notes.txt"]`).count());
  console.log("[step] statusbar =", (await page.locator("[data-statusbar]").innerText()).slice(0, 300));
  expect(true).toBe(true);
});
