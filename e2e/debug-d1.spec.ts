import { test, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";
const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("debug D1", async ({ page }) => {
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("txtdiff") || t.includes("invoke") || t.includes("Escape")) {
      console.log("[console]", m.type(), t.slice(0, 200));
    }
  });
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.locator("[data-path]").first()).toBeVisible();
  await page.locator(`[data-path="${HOME}/Notes.txt"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "比较" }).click();
  await page.getByRole("menuitem", { name: "设为比较基准" }).click();
  await page.locator(`[data-path="${HOME}/photo.png"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "比较" }).click();
  await page.getByRole("menuitem", { name: "与基准比较" }).click();
  const dialog = page.locator("[data-text-diff]");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    // 猴补丁：记录谁对 Escape 调了 stopPropagation / stopImmediatePropagation
    const origStop = Event.prototype.stopPropagation;
    const origStopImm = Event.prototype.stopImmediatePropagation;
    (window as unknown as Record<string, unknown>).__escLog = [] as string[];
    Event.prototype.stopPropagation = function (this: Event) {
      if (this.type === "keydown" && (this as KeyboardEvent).key === "Escape") {
        ((window as unknown as Record<string, unknown>).__escLog as string[]).push(
          `stopPropagation by ${new Error("stack").stack?.split("\n")[2]?.trim()}`,
        );
      }
      return origStop.call(this);
    };
    Event.prototype.stopImmediatePropagation = function (this: Event) {
      if (this.type === "keydown" && (this as KeyboardEvent).key === "Escape") {
        ((window as unknown as Record<string, unknown>).__escLog as string[]).push(
          `stopImmediate by ${new Error("stack").stack?.split("\n")[2]?.trim()}`,
        );
      }
      return origStopImm.call(this);
    };
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") {
          ((window as unknown as Record<string, unknown>).__escLog as string[]).push(
            `cap0 trusted=${e.isTrusted} prevented=${e.defaultPrevented}`,
          );
        }
      },
      true,
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        ((window as unknown as Record<string, unknown>).__escLog as string[]).push(
          `bubble-last trusted=${e.isTrusted} prevented=${e.defaultPrevented}`,
        );
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        ((window as unknown as Record<string, unknown>).__escLog as string[]).push(
          `doc-bubble trusted=${e.isTrusted} prevented=${e.defaultPrevented}`,
        );
      }
    });
  });
  console.log("[dbg] opened, text:", (await dialog.innerText()).slice(0, 120));
  console.log(
    "[dbg] dialog width style =",
    await dialog.locator("> div").first().getAttribute("style"),
  );
  // 检查有没有重复挂载的 TextDiffDialog / 多个 root
  console.log(
    "[dbg] roots =",
    await page.evaluate(() => document.querySelectorAll("#root, [data-react-root]").length),
  );
  console.log(
    "[dbg] overlays =",
    await page.evaluate(() => document.querySelectorAll("div.fixed.inset-0").length),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  console.log("[dbg] after Esc, count =", await page.locator("[data-text-diff]").count());
  console.log("[dbg] subLog =", await page.evaluate(() => (window as unknown as Record<string, unknown>).__subLog));
  console.log("[dbg] escLog =", await page.evaluate(() => (window as unknown as Record<string, unknown>).__escLog));
  console.log("[dbg] active element:", await page.evaluate(() => document.activeElement?.tagName));
  // 二次尝试：合成事件（非受信）直接派发
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await page.waitForTimeout(500);
  console.log("[dbg] after synthetic Esc, count =", await page.locator("[data-text-diff]").count());
});
