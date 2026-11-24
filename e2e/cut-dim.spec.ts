import { test, expect } from "@playwright/test";
import { disablePreview, installTauriMock } from "./tauri-mock";

const HOME = "/mock/home";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

/**
 * v0.52 剪切置灰（Windows 语义）回归：Ctrl+X 剪贴板 op=cut → 行半透明（opacity-50）；
 * 随后 Ctrl+C 复制覆盖剪贴板 → 置灰解除。置灰派生自剪贴板状态，无独立开关。
 */
test("剪切置灰（Windows 语义）：cut 半透明，copy 解除", async ({ page }) => {
  await disablePreview(page);
  await installTauriMock(page);
  await page.goto("/");
  const notes = page.locator(`[data-path="${HOME}/Notes.txt"]`);
  await expect(notes).toBeVisible();

  const opacity = () => notes.evaluate((el) => getComputedStyle(el).opacity);

  // 剪切 → 行半透明（多选同理：剪贴板整批置灰）
  await notes.click();
  await page.keyboard.press(`${MOD}+x`);
  await expect(opacity()).resolves.toBe("0.5");

  // 再直接复制 → 剪贴板被 copy 覆盖，置灰解除
  await page.keyboard.press(`${MOD}+c`);
  await expect(opacity()).resolves.toBe("1");
});
