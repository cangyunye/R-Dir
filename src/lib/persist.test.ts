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
  saveShareAllowParent,
  loadUiFontSize,
  saveUiFontSize,
  uiFontZoom,
  UI_FONT_DEFAULT,
  UI_FONT_MIN,
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
  it("默认 15px", () => {
    expect(loadUiFontSize()).toBe(UI_FONT_DEFAULT);
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
  it("老用户 13px 自动迁移到 15px", () => {
    localStorage.setItem("rfm.ui-font", "13");
    expect(loadUiFontSize()).toBe(15);
  });
  it("uiFontZoom 以 13 为基准", () => {
    expect(uiFontZoom(13)).toBe(1);
    expect(uiFontZoom(15)).toBeCloseTo(15 / 13, 2);
  });
});
