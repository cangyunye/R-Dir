// E2E 视觉验证：标签视图 Hero 横幅 + 标签色渗透 + 卡片墙 + 标签页芯片本色
// 用法：node e2e-shots/verify-tagview.mjs（需 vite dev 已跑在 1420）
import { chromium } from "@playwright/test";

const BASE = "http://localhost:1420";
const OUT = "e2e-shots";

/** 假数据：复刻演示截图的「工程」标签（红）+ 两个橙色双标签 + 黄色「素材」标签。
 *  路径无需真实存在——stat_paths mock 按「末段带点=文件」返回 kind。 */
const TAG_NAMES = { red: "工程", yellow: "素材" };
const PATHS = [
  "F:\\pantheon\\Project\\Project",
  "F:\\pantheon\\Project\\skills",
  "F:\\pantheon\\Project\\webautomation",
  "F:\\pantheon\\Project\\opencode_guide",
  "F:\\pantheon\\Work\\gcsp",
  "F:\\pantheon\\Work\\gitstar",
  "F:\\pantheon\\Work\\go-owl",
  "F:\\pantheon\\Work\\mewmew",
  "F:\\pantheon\\Work\\ruakdown",
  "F:\\pantheon\\Project\\R-Dir",
  "F:\\pantheon\\Sandbox\\dbcompare",
  "F:\\pantheon\\Sandbox\\spec2test",
  "F:\\pantheon\\Sandbox\\yamIQ",
  "F:\\pantheon\\Sandbox\\go-owl-migrate",
  "F:\\pantheon\\Work\\notes.txt",
];
const fileTags = {};
PATHS.forEach((p) => (fileTags[p] = ["red"]));
fileTags["F:\\pantheon\\Project\\webautomation"].push("orange");
fileTags["F:\\pantheon\\Work\\go-owl"].push("orange");
fileTags["F:\\pantheon\\Work\\gcsp"] = ["yellow", "red"];
fileTags["F:\\pantheon\\Work\\gitstar"] = ["yellow", "red"];
fileTags["F:\\pantheon\\Work\\notes.txt"] = ["yellow", "red"];

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(
    ([tags, names]) => {
      const ARRAY_CMDS = /list|quick_access|volumes|complete|read_files|suggest/;
      let cbId = 0;
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: () => ++cbId,
        invoke: (cmd, args) => {
          if (cmd === "get_home_dir") return Promise.resolve("C:\\Users\\Admin");
          if (cmd === "session_load" || cmd === "prefs_load") return Promise.resolve(null);
          if (cmd === "diff_dirs") return Promise.resolve({ cancelled: false, entries: [] });
          if (cmd === "sftp_master_key_status")
            return Promise.resolve({ configured: false, active: false });
          if (cmd === "plugin:app|name") return Promise.resolve("R-Dir");
          if (cmd === "plugin:app|version") return Promise.resolve("0.39.0");
          if (cmd === "plugin:window|is_maximized") return Promise.resolve(false);
          if (cmd.startsWith("plugin:event|")) return Promise.resolve(1);
          if (cmd === "drag_out_files") return Promise.resolve(0);
          if (cmd === "stat_paths")
            return Promise.resolve(
              (args?.paths ?? []).map((p) =>
                (p.split(/[\\/]/).pop() || "").includes(".") ? "file" : "dir",
              ),
            );
          if (ARRAY_CMDS.test(cmd)) return Promise.resolve([]);
          return Promise.resolve(null);
        },
      };
      localStorage.setItem("rfm.tags", JSON.stringify(tags));
      localStorage.setItem("rfm.tag-names", JSON.stringify(names));
    },
    [fileTags, TAG_NAMES],
  );

  await page.goto(BASE);
  await page.waitForSelector("[data-tab-idx]");
  await page.waitForTimeout(1300); // splash 1100ms 后隐藏

  // ===== 1. 打开「工程」标签 → Hero 横幅 + 列表 =====
  await page.locator('button[title^="查看「工程」"]').click();
  await page.waitForSelector("[data-tag-path]");
  await page.waitForTimeout(600); // 等 stat_paths 回来出统计行 + 流光扫过
  await page.screenshot({ path: `${OUT}/tagview-hero-list.png` });

  // ===== 2. 悬停一行：标签色底 + 左色标（色彩渗透）=====
  await page.locator("[data-tag-path]").nth(4).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/tagview-percolate-hover.png` });

  // ===== 3. 切卡片墙 =====
  await page.locator('button[title="网格视图"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/tagview-grid.png` });
  // 悬停一张卡片：上浮 + 标签色描边光晕
  await page.locator("[data-tag-path]").nth(1).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/tagview-grid-hover.png` });

  // ===== 4. 黄色标签（浅色 → 徽章/芯片深字对比度）=====
  await page.locator('button[title^="查看「素材」"]').click();
  await page.waitForSelector("[data-tag-path]");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/tagview-yellow-grid.png` });
  await page.locator('button[title="列表视图"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/tagview-yellow-list.png` });

  // ===== 5. 暗色主题（重开「工程」，网格偏好应已持久化？——上面切回了 list）=====
  await page.evaluate(() => localStorage.setItem("rfm.theme", "dark"));
  await page.reload();
  await page.waitForSelector("[data-tab-idx]");
  await page.waitForTimeout(1300);
  await page.locator('button[title^="查看「工程」"]').click();
  await page.waitForSelector("[data-tag-path]");
  await page.waitForTimeout(700);
  await page.locator('button[title="网格视图"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/tagview-dark-grid.png` });
  // 标签页芯片特写：实色填充 + 亮度自适应文字
  await page.screenshot({
    path: `${OUT}/tagview-chip-dark.png`,
    clip: { x: 0, y: 0, width: 640, height: 40 },
  });
  await page.evaluate(() => localStorage.setItem("rfm.theme", "light"));

  await browser.close();
  console.log("OK: 8 张截图已写入 e2e-shots/");
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
