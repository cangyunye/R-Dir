import { describe, it, expect, beforeEach } from "vitest";
import {
  tagById,
  tagLabel,
  loadTagNames,
  saveTagNames,
  loadFileTags,
  saveFileTags,
  loadCustomTags,
  saveCustomTags,
  allTags,
  makeTagId,
  MAX_TAGS,
  TAG_DEFS,
  parentOf,
  remapPrefixedPath,
  loadShareAllowParent,
  loadUiFontFamily,
  saveUiFontFamily,
  saveUiFontFamilyCustom,
  uiFontFamilyStack,
  UI_FONT_FAMILIES,
  saveShareAllowParent,
  loadUiFontSize,
  saveUiFontSize,
  uiFontZoom,
  UI_FONT_MIN,
  autoUiFontSize,
  UI_FONT_MAX,
  loadShowExtensions,
  saveShowExtensions,
  mergeDiskPrefs,
  loadPrefsFromDisk,
  saveCustomQuick,
  loadCustomQuick,
  loadPreviewPrefs,
  savePreviewPrefs,
  loadEntryAliases,
  saveEntryAliases,
  entryDisplayName,
  loadRemoteTempDir,
  saveRemoteTempDir,
} from "./persist";

beforeEach(() => {
  localStorage.clear();
});

describe("entryAliases（v0.31.1 只读后端条目的显示别名）", () => {
  it("保存/读取；空白值与非字符串被过滤", () => {
    saveEntryAliases({ "http://h/docs/": "我的文档", "http://h/x/": "  ", "sftp://u@h:22/a": "A" });
    expect(loadEntryAliases()).toEqual({ "http://h/docs/": "我的文档", "sftp://u@h:22/a": "A" });
    localStorage.setItem("rfm.entry-aliases", JSON.stringify({ a: 1, b: "ok" }));
    expect(loadEntryAliases()).toEqual({ b: "ok" });
    localStorage.setItem("rfm.entry-aliases", "[1,2]");
    expect(loadEntryAliases()).toEqual({});
  });

  it("entryDisplayName：有别名用别名，否则取最后一段（含尾斜杠的 URL 目录）", () => {
    const aliases = { "http://h:8082/docs/": "资料库" };
    expect(entryDisplayName("http://h:8082/docs/", aliases)).toBe("资料库");
    expect(entryDisplayName("http://h:8082/other/", aliases)).toBe("other");
    expect(entryDisplayName("C:\\Users\\me\\图书", {})).toBe("图书");
    expect(entryDisplayName("/", {})).toBe("/");
  });

  it("mergeDiskPrefs 合并别名（磁盘优先）", () => {
    saveEntryAliases({ a: "本地" });
    mergeDiskPrefs({ entryAliases: { a: "磁盘", b: "新" } });
    expect(loadEntryAliases()).toEqual({ a: "磁盘", b: "新" });
  });
});

describe("标签定义", () => {
  it("有 7 个彩色标签", () => {
    expect(tagById("red")).toBeDefined();
    expect(tagById("orange")).toBeDefined();
    expect(tagById("yellow")).toBeDefined();
    expect(tagById("green")).toBeDefined();
    expect(tagById("blue")).toBeDefined();
    expect(tagById("purple")).toBeDefined();
    expect(tagById("gray")).toBeDefined();
  });
  it("未知 id 返回 undefined", () => {
    expect(tagById("unknown")).toBeUndefined();
  });
});

describe("tagLabel", () => {
  it("默认标签名", () => {
    const def = tagById("red")!;
    expect(tagLabel(def, {})).toBe("红色");
  });
  it("用户自定义名覆盖", () => {
    const def = tagById("red")!;
    expect(tagLabel(def, { red: "重要" })).toBe("重要");
  });
});

describe("tagNames 持久化", () => {
  it("保存后能读回", () => {
    saveTagNames({ red: "重要" });
    expect(loadTagNames()).toEqual({ red: "重要" });
  });
});

describe("fileTags 持久化", () => {
  it("保存后能读回", () => {
    saveFileTags({ "/home/kali/file.txt": ["red", "yellow"] });
    const t = loadFileTags();
    expect(t["/home/kali/file.txt"]).toEqual(["red", "yellow"]);
  });
});

describe("parentOf", () => {
  it("Unix 路径", () => {
    expect(parentOf("/home/kali/file.txt")).toBe("/home/kali");
  });
  it("Windows 路径反斜杠", () => {
    expect(parentOf("F:\\pantheon\\Project\\R-Dir")).toBe("F:/pantheon/Project");
  });
  it("根目录返回 /", () => {
    expect(parentOf("/file.txt")).toBe("/");
  });
});

describe("remapPrefixedPath（条目重命名后迁移标签/快捷访问路径）", () => {
  const OLD = "/home/u/旧文件夹";
  const NEW = "/home/u/新文件夹";
  it("本体相等 → 新路径", () => {
    expect(remapPrefixedPath(OLD, OLD, NEW)).toBe(NEW);
  });
  it("子路径 → 前缀重写", () => {
    expect(remapPrefixedPath(`${OLD}/子/文件.txt`, OLD, NEW)).toBe(`${NEW}/子/文件.txt`);
  });
  it("仅前缀字符串不算（同级目录名前缀重叠）", () => {
    expect(remapPrefixedPath(`${OLD}-备份/a.txt`, OLD, NEW)).toBe(`${OLD}-备份/a.txt`);
  });
  it("无关路径原样返回", () => {
    expect(remapPrefixedPath("/home/u/其他.txt", OLD, NEW)).toBe("/home/u/其他.txt");
  });
  it("Windows 反斜杠子路径", () => {
    expect(remapPrefixedPath("F:\\dir\\old\\a.txt", "F:\\dir\\old", "F:\\dir\\new")).toBe(
      "F:\\dir\\new\\a.txt",
    );
  });
});

describe("分享设置", () => {
  it("默认不允许父目录", () => {
    expect(loadShareAllowParent()).toBe(false);
  });
  it("保存 true 后读回", () => {
    saveShareAllowParent(true);
    expect(loadShareAllowParent()).toBe(true);
  });
});

describe("UI 字体", () => {
  it("默认根据屏幕宽度自适应", () => {
    const v = loadUiFontSize();
    expect(v).toBeGreaterThanOrEqual(13);
    expect(v).toBeLessThanOrEqual(16);
  });
  it("保存后读回", () => {
    saveUiFontSize(16);
    expect(loadUiFontSize()).toBe(16);
  });
  it("clamp 到 [10, 18]（先标记已迁移避免升级逻辑）", () => {
    localStorage.setItem("rfm.ui-font-migrated-v080", "1");
    saveUiFontSize(5);
    expect(loadUiFontSize()).toBe(UI_FONT_MIN);
    saveUiFontSize(30);
    expect(loadUiFontSize()).toBe(UI_FONT_MAX);
  });
  it("老用户 13px 自动迁移到自适应大小", () => {
    localStorage.setItem("rfm.ui-font", "13");
    const v = loadUiFontSize();
    expect(v).toBeGreaterThanOrEqual(13);
    expect(v).toBeLessThanOrEqual(16);
  });
  it("uiFontZoom 以 13 为基准", () => {
    expect(uiFontZoom(13)).toBe(1);
    expect(uiFontZoom(15)).toBeCloseTo(15 / 13, 2);
  });
});

// ---- v0.8.1 字体族 ----
describe("字体族配置", () => {
  it("loadUiFontFamily 默认 msyahei（Windows + 中文）", () => {
    localStorage.clear();
    const id = loadUiFontFamily();
    // jsdom 的 navigator.platform 是 Win32；无 rfm.language → loadLanguage 回退 zh
    expect(id).toBe("msyahei");
  });

  it("未自定义时默认字体随界面语言：ja 走日文预设，拉丁语言走 system", () => {
    localStorage.clear();
    localStorage.setItem("rfm.language", "ja");
    expect(loadUiFontFamily()).toBe("yugothic");
    localStorage.setItem("rfm.language", "en");
    expect(loadUiFontFamily()).toBe("system");
    localStorage.setItem("rfm.language", "de");
    expect(loadUiFontFamily()).toBe("system");
    // zh-Hant 归入中文分支
    localStorage.setItem("rfm.language", "zh-Hant");
    expect(loadUiFontFamily()).toBe("msyahei");
  });

  it("已自定义字体的用户不受语言影响", () => {
    localStorage.clear();
    localStorage.setItem("rfm.ui-font-family", "menlo");
    localStorage.setItem("rfm.language", "ja");
    expect(loadUiFontFamily()).toBe("menlo");
  });

  it("saveUiFontFamily 持久化", () => {
    saveUiFontFamily("menlo");
    expect(loadUiFontFamily()).toBe("menlo");
  });

  it("uiFontFamilyStack 返回正确 stack", () => {
    expect(uiFontFamilyStack("msyahei")).toContain("Microsoft YaHei");
    expect(uiFontFamilyStack("pingfang")).toContain("PingFang");
    expect(uiFontFamilyStack("menlo")).toContain("Menlo");
  });

  it("系统默认在 Windows 显式接微软雅黑（否则中文回退宋体）", () => {
    // jsdom 的 navigator.platform 是 Win32 → 走 Windows 分支
    const stack = uiFontFamilyStack("system");
    expect(stack).toContain("Microsoft YaHei");
    // Segoe UI 在前保拉丁观感，中文无字形自然落到雅黑
    expect(stack.indexOf("Segoe UI")).toBeLessThan(stack.indexOf("Microsoft YaHei"));
  });

  it("自定义字体返回 custom stack", () => {
    localStorage.setItem("rfm.ui-font-family-custom", "Consolas");
    expect(uiFontFamilyStack("custom")).toContain("Consolas");
  });

  it("UI_FONT_FAMILIES 包含 8 种预设 + 自定义（含日文预设 Yu Gothic/Meiryo）", () => {
    expect(UI_FONT_FAMILIES.length).toBe(9);
    expect(UI_FONT_FAMILIES.map((f) => f.id)).toContain("msyahei");
    expect(UI_FONT_FAMILIES.map((f) => f.id)).toContain("yugothic");
    expect(UI_FONT_FAMILIES.map((f) => f.id)).toContain("meiryo");
    expect(UI_FONT_FAMILIES.map((f) => f.id)).toContain("custom");
  });

  it("日文预设的字体栈：Windows 日文字体在前，mac 回退 + 雅黑兜底", () => {
    const yu = uiFontFamilyStack("yugothic");
    expect(yu).toContain("Yu Gothic UI");
    expect(yu).toContain("Hiragino");
    // 日文字体在雅黑之前，保证汉字走日文字形
    expect(yu.indexOf("Yu Gothic UI")).toBeLessThan(yu.indexOf("Microsoft YaHei"));
    expect(uiFontFamilyStack("meiryo")).toContain("Meiryo");
  });

  it("宋体/黑体的字体栈带 mac 回退（SimSun/SimHei 是 Windows 字体名）", () => {
    expect(uiFontFamilyStack("simsun")).toContain("Songti SC");
    expect(uiFontFamilyStack("simhei")).toContain("Heiti SC");
  });

  it("未知 id 回落到 system", () => {
    expect(uiFontFamilyStack("unknown")).toContain("system-ui");
  });

  it("saveUiFontFamilyCustom 写入的字体名被 uiFontFamilyStack 读到", () => {
    saveUiFontFamilyCustom("JetBrains Mono");
    expect(uiFontFamilyStack("custom")).toContain("JetBrains Mono");
  });
});

// ---- v0.14 显示文件扩展名 ----
describe("显示文件扩展名开关", () => {
  it("默认显示", () => {
    expect(loadShowExtensions()).toBe(true);
  });
  it("保存 false 后读回 false", () => {
    saveShowExtensions(false);
    expect(loadShowExtensions()).toBe(false);
  });
  it("保存 true 后读回 true", () => {
    saveShowExtensions(false);
    saveShowExtensions(true);
    expect(loadShowExtensions()).toBe(true);
  });
});

// ---- v0.14 磁盘偏好合并 ----
describe("mergeDiskPrefs（磁盘备份恢复）", () => {
  it("磁盘缺失键回落本地，磁盘存在键覆盖", () => {
    saveTagNames({ red: "本地名" });
    mergeDiskPrefs({ tagNames: { red: "磁盘名", blue: "新名" } });
    const n = loadTagNames();
    expect(n.red).toBe("磁盘名");
    expect(n.blue).toBe("新名");
  });
  it("空磁盘快照不覆盖本地", () => {
    saveTagNames({ red: "重要" });
    mergeDiskPrefs({});
    expect(loadTagNames()).toEqual({ red: "重要" });
  });
  it("fileTags 按路径合并", () => {
    saveFileTags({ "/a.txt": ["red"] });
    mergeDiskPrefs({ fileTags: { "/a.txt": ["red", "blue"], "/b.txt": ["green"] } });
    const t = loadFileTags();
    expect(t["/a.txt"]).toEqual(["red", "blue"]);
    expect(t["/b.txt"]).toEqual(["green"]);
  });
  it("customQuick 并集去重", () => {
    saveCustomQuick(["/home/u/x", "/home/u/y"]);
    mergeDiskPrefs({ customQuick: ["/home/u/y", "/home/u/z"] });
    expect(loadCustomQuick()).toEqual(["/home/u/x", "/home/u/y", "/home/u/z"]);
  });
});

describe("loadPrefsFromDisk（非 Tauri 环境）", () => {
  it("invoke 不可用时返回 null（不抛错）", async () => {
    await expect(loadPrefsFromDisk()).resolves.toBeNull();
  });
});

// ---- v0.8.1 自适应字体大小 ----
describe("autoUiFontSize", () => {
  it("小屏 (<1280) 返回 13", () => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    expect(autoUiFontSize()).toBe(13);
  });
  it("中屏 (1280-1600) 返回 14", () => {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    expect(autoUiFontSize()).toBe(14);
  });
  it("大屏 (1600-2000) 返回 15", () => {
    Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
    expect(autoUiFontSize()).toBe(15);
  });
  it("超大屏 (>2000) 返回 16", () => {
    Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true });
    expect(autoUiFontSize()).toBe(16);
  });
});

// ---- v0.28 预览栏偏好 ----
describe("preview prefs（rfm.preview）", () => {
  it("默认：关闭 + 展开 + 360px", () => {
    const p = loadPreviewPrefs();
    expect(p.enabled).toBe(false);
    expect(p.expanded).toBe(true);
    expect(p.width).toBe(360);
  });
  it("保存后读回一致", () => {
    savePreviewPrefs({ enabled: true, expanded: false, width: 480 });
    const p = loadPreviewPrefs();
    expect(p.enabled).toBe(true);
    expect(p.expanded).toBe(false);
    expect(p.width).toBe(480);
  });
  it("宽度越界收敛到 280–720", () => {
    savePreviewPrefs({ enabled: true, expanded: true, width: 100 });
    expect(loadPreviewPrefs().width).toBe(280);
    savePreviewPrefs({ enabled: true, expanded: true, width: 9999 });
    expect(loadPreviewPrefs().width).toBe(720);
  });
  it("损坏数据回落默认", () => {
    localStorage.setItem("rfm.preview", "{oops");
    const p = loadPreviewPrefs();
    expect(p.enabled).toBe(false);
    expect(p.width).toBe(360);
  });
});

// ---- v0.28.0 自定义标签 ----
describe("自定义标签（v0.28.0）", () => {
  it("默认无自定义标签；allTags = 预设 + 自定义", () => {
    expect(loadCustomTags()).toEqual([]);
    expect(allTags([])).toHaveLength(TAG_DEFS.length);
    const custom = [{ id: "c1", label: "紧急", color: "#00c7be" }];
    expect(allTags(custom)).toHaveLength(TAG_DEFS.length + 1);
    expect(allTags(custom).slice(-1)[0].label).toBe("紧急");
  });
  it("保存后读回一致", () => {
    saveCustomTags([{ id: "c1", label: "工作", color: "#ff2d55" }]);
    expect(loadCustomTags()).toEqual([{ id: "c1", label: "工作", color: "#ff2d55" }]);
  });
  it("越界收敛到 MAX_TAGS - 预设数", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      label: `标签${i}`,
      color: "#888888",
    }));
    saveCustomTags(many);
    expect(loadCustomTags()).toHaveLength(MAX_TAGS - TAG_DEFS.length);
  });
  it("损坏数据过滤非法条目", () => {
    localStorage.setItem("rfm.custom-tags", JSON.stringify([{ id: "ok", label: "好", color: "#111111" }, { id: 3 }, "x", null]));
    const tags = loadCustomTags();
    expect(tags).toHaveLength(1);
    expect(tags[0].id).toBe("ok");
  });
  it("makeTagId 唯一", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeTagId()));
    expect(ids.size).toBe(50);
  });
  it("mergeDiskPrefs 自定义标签按 id 去重合并并收敛上限", () => {
    saveCustomTags([{ id: "c1", label: "本地", color: "#111111" }]);
    mergeDiskPrefs({
      customTags: [
        { id: "c1", label: "磁盘", color: "#222222" },
        { id: "c2", label: "新增", color: "#333333" },
      ],
    });
    const tags = loadCustomTags();
    expect(tags.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(tags[0].label).toBe("磁盘");
  });
});

describe("remoteTempDir（v0.37 远程打开临时目录）", () => {
  it("默认空串（后端回退默认目录）", () => {
    expect(loadRemoteTempDir()).toBe("");
  });
  it("保存后读回一致；两端空白被去除", () => {
    saveRemoteTempDir("  /tmp/rdir-cache  ");
    expect(loadRemoteTempDir()).toBe("/tmp/rdir-cache");
  });
  it("保存空串/纯空白 = 恢复默认（移除 key）", () => {
    saveRemoteTempDir("/tmp/rdir-cache");
    saveRemoteTempDir("");
    expect(loadRemoteTempDir()).toBe("");
    saveRemoteTempDir("/tmp/rdir-cache");
    saveRemoteTempDir("   ");
    expect(loadRemoteTempDir()).toBe("");
  });
});
