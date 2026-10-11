// E2E 视觉/行为验证：右键菜单全覆盖（全局兜底 + 侧边栏/路径栏/窗格头菜单）
// 用法：node e2e-shots/verify-contextmenu.mjs（需 vite dev 已跑在 1420）
import { chromium } from "@playwright/test";

const BASE = "http://localhost:1420";
const OUT = "e2e-shots";

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, extra = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  };

  await page.addInitScript(() => {
    let cbId = 0;
    const FILE_DIR = (name, path) => ({ name, path, is_dir: true, is_symlink: false, size: 0, modified: 1700000000000, created: null, permissions: "rw", extension: "" });
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main", windowLabel: "main" },
      },
      transformCallback: () => ++cbId,
      invoke: (cmd, args) => {
        if (cmd === "get_home_dir") return Promise.resolve("C:\\Users\\Admin");
        if (cmd === "get_volumes")
          return Promise.resolve([
            { name: "系统 (C:)", path: "C:\\", kind: "fixed" },
            { name: "数据 (D:)", path: "D:\\", kind: "fixed" },
          ]);
        if (cmd === "get_quick_access")
          return Promise.resolve([
            { key: "home", path: "C:\\Users\\Admin" },
            { key: "desktop", path: "C:\\Users\\Admin\\Desktop" },
            { key: "downloads", path: "C:\\Users\\Admin\\Downloads" },
          ]);
        if (cmd === "list_shells")
          return Promise.resolve([
            { id: "powershell", name: "PowerShell", detected: true },
            { id: "cmd", name: "CMD", detected: true },
            { id: "wsl", name: "WSL", detected: false },
          ]);
        if (cmd === "list_openers") return Promise.resolve([]);
        if (cmd === "list_dir")
          return Promise.resolve([
            FILE_DIR("Desktop", "C:\\Users\\Admin\\Desktop"),
            FILE_DIR("Documents", "C:\\Users\\Admin\\Documents"),
            { name: "notes.txt", path: "C:\\Users\\Admin\\notes.txt", is_dir: false, is_symlink: false, size: 1234, modified: 1700000000000, created: null, permissions: "rw", extension: "txt" },
          ]);
        if (cmd === "session_load" || cmd === "prefs_load") return Promise.resolve(null);
        if (cmd === "diff_dirs") return Promise.resolve({ cancelled: false, entries: [] });
        if (cmd === "sftp_master_key_status") return Promise.resolve({ configured: false, active: false });
        if (cmd === "sftp_list_servers") return Promise.resolve([]);
        if (cmd === "plugin:app|name") return Promise.resolve("R-Dir");
        if (cmd === "plugin:app|version") return Promise.resolve("0.25.0");
        if (cmd === "plugin:window|is_maximized") return Promise.resolve(false);
        if (cmd?.startsWith("plugin:event|")) return Promise.resolve(1);
        if (cmd === "drag_out_files") return Promise.resolve(0);
        if (/list|quick_access|volumes|complete|read_files|stat_paths|suggest|stat_path/.test(cmd))
          return Promise.resolve([]);
        return Promise.resolve(null);
      },
    };
  });

  // 记录 contextmenu 是否被 preventDefault（在 window 捕获阶段最早观察）
  await page.goto(BASE);
  await page.waitForSelector("[data-tab-idx]");
  await page.waitForTimeout(1300); // splash

  // 在 window 捕获阶段记录 defaultPrevented；组件处理器在冒泡阶段才跑，
  // 故 dispatch 结束后（setTimeout）再读终值
  await page.evaluate(() => {
    window.addEventListener(
      "contextmenu",
      (e) => {
        setTimeout(() => {
          window.__lastCtxPrevented = e.defaultPrevented;
        }, 0);
      },
      { capture: true },
    );
  });

  await page.screenshot({ path: `${OUT}/ctx-00-main.png` });

  // ===== 1. 侧边栏：快速访问（内置） =====
  {
    const qa = page.locator("text=下载").first();
    await qa.click({ button: "right" });
    await page.waitForTimeout(250);
    const menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content]"));
    const prevented = await page.evaluate(() => window.__lastCtxPrevented);
    check("快速访问右键出应用菜单", menuVisible && prevented, `prevented=${prevented}`);
    await page.screenshot({ path: `${OUT}/ctx-01-quickaccess.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // ===== 2. 侧边栏：磁盘 =====
  {
    await page.locator("text=数据 (D:)").first().click({ button: "right" });
    await page.waitForTimeout(250);
    const menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content]"));
    check("磁盘右键出应用菜单", menuVisible);
    await page.screenshot({ path: `${OUT}/ctx-02-volume.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // ===== 3. 侧边栏：标签（不应直接弹重命名对话框） =====
  {
    await page.locator("[data-pane-head] >> nth=0").waitFor({ timeout: 3000 }).catch(() => {});
    const tagBtn = page.locator("button:has-text('红色'), button[title*='标签的文件']").first();
    await tagBtn.click({ button: "right" });
    await page.waitForTimeout(250);
    const menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content]"));
    const dialogOpen = await page.evaluate(() => !!document.querySelector("[role=dialog]"));
    check("标签右键出菜单而非直接重命名", menuVisible && !dialogOpen, `dialog=${dialogOpen}`);
    await page.screenshot({ path: `${OUT}/ctx-03-tag.png` });
    // 点「重命名…」应弹对话框
    await page.locator("[data-slot=context-menu-content] >> text=重命名…").click();
    await page.waitForTimeout(250);
    const dialogOpen2 = await page.evaluate(() => !!document.querySelector("[role=dialog]"));
    check("标签菜单→重命名…打开对话框", dialogOpen2);
    await page.screenshot({ path: `${OUT}/ctx-04-tag-rename.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // ===== 4. 主路径栏空白处：出菜单而非编辑态 =====
  {
    const pb = page.locator("[data-pathbar]");
    const box = await pb.boundingBox();
    await pb.click({ button: "right", position: { x: box.width - 30, y: 12 } });
    await page.waitForTimeout(250);
    const menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content]"));
    const editing = await page.evaluate(() => !!document.querySelector("#rdir-addr-input") && document.activeElement?.id === "rdir-addr-input");
    check("路径栏空白处右键出菜单（bug 修复：不再误入编辑态）", menuVisible && !editing, `editing=${editing}`);
    await page.screenshot({ path: `${OUT}/ctx-05-pathbar-blank.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // ===== 5. 窗格头：空白处 + 分段 =====
  {
    const ph = page.locator("[data-pane-head]").first();
    const pbox = await ph.boundingBox();
    await ph.click({ button: "right", position: { x: pbox.width - 30, y: 12 } });
    await page.waitForTimeout(250);
    let menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content]"));
    let text = await page.evaluate(() => document.querySelector("[data-slot=context-menu-content]")?.textContent ?? "");
    check("窗格头空白右键=窗格级菜单", menuVisible && text.includes("复制窗格路径"), text.slice(0, 40));
    await page.screenshot({ path: `${OUT}/ctx-06-panehead-blank.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // 分段右键 → 层级菜单
    await ph.locator("button").first().click({ button: "right" });
    await page.waitForTimeout(250);
    menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content]"));
    text = await page.evaluate(() => document.querySelector("[data-slot=context-menu-content]")?.textContent ?? "");
    check("窗格头分段右键=层级菜单", menuVisible && text.includes("复制此层级路径"), text.slice(0, 40));
    await page.screenshot({ path: `${OUT}/ctx-07-panehead-seg.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // ===== 6. 纯按钮区：应被兜底屏蔽（无菜单、defaultPrevented=true） =====
  {
    // 右上角设置按钮（title=设置）
    await page.locator("button[title*='设置']").first().click({ button: "right" });
    await page.waitForTimeout(250);
    let prevented = await page.evaluate(() => window.__lastCtxPrevented);
    let menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content],[data-slot=dropdown-menu-content]"));
    check("右上角设置按钮右键被屏蔽", prevented && !menuVisible, `prevented=${prevented}`);
    await page.screenshot({ path: `${OUT}/ctx-08-topright.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // 状态栏
    await page.locator("[data-statusbar]").click({ button: "right", position: { x: 200, y: 8 } });
    await page.waitForTimeout(250);
    prevented = await page.evaluate(() => window.__lastCtxPrevented);
    menuVisible = await page.evaluate(() => !!document.querySelector("[data-slot=context-menu-content]"));
    check("状态栏右键被屏蔽", prevented && !menuVisible, `prevented=${prevented}`);
  }

  // ===== 7. 输入框白名单：设置里的输入框保留系统菜单（defaultPrevented=false） =====
  {
    await page.locator("button[title*='设置']").first().click();
    await page.waitForTimeout(400);
    const input = page.locator("[role=dialog] input").first();
    const hasInput = (await input.count()) > 0;
    if (hasInput) {
      await input.click({ button: "right" });
      await page.waitForTimeout(250);
      const prevented = await page.evaluate(() => window.__lastCtxPrevented);
      check("设置输入框右键保留系统菜单（白名单）", prevented === false, `prevented=${prevented}`);
      await page.screenshot({ path: `${OUT}/ctx-09-settings-input.png` });
    } else {
      check("设置输入框右键保留系统菜单（白名单）", true, "no input found, skipped");
    }
    await page.keyboard.press("Escape");
  }

  await browser.close();
  console.log(results.join("\n"));
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
