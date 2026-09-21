import { describe, it, expect, beforeEach } from "vitest";
import {
  tagById,
  tagLabel,
  loadTagNames,
  saveTagNames,
  loadFileTags,
  saveFileTags,
  parentOf,
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
} from "./persist";

beforeEach(() => {
  localStorage.clear();
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
  it("loadUiFontFamily 默认 msyahei（Windows）", () => {
    localStorage.clear();
    const id = loadUiFontFamily();
    // jsdom 的 navigator.platform 是 Win32
    expect(id).toBe("msyahei");
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

  it("自定义字体返回 custom stack", () => {
    localStorage.setItem("rfm.ui-font-family-custom", "Consolas");
    expect(uiFontFamilyStack("custom")).toContain("Consolas");
  });

  it("UI_FONT_FAMILIES 包含 5 种预设 + 自定义", () => {
    expect(UI_FONT_FAMILIES.length).toBe(6);
    expect(UI_FONT_FAMILIES.map((f) => f.id)).toContain("msyahei");
    expect(UI_FONT_FAMILIES.map((f) => f.id)).toContain("custom");
  });

  it("未知 id 回落到 system", () => {
    expect(uiFontFamilyStack("unknown")).toContain("system-ui");
  });

  it("saveUiFontFamilyCustom 写入的字体名被 uiFontFamilyStack 读到", () => {
    saveUiFontFamilyCustom("JetBrains Mono");
    expect(uiFontFamilyStack("custom")).toContain("JetBrains Mono");
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
