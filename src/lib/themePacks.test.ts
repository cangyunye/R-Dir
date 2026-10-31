import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePack,
  loadActiveThemePackId,
  saveActiveThemePackId,
  themeSwatch,
  type ThemePack,
} from "./themePacks";

const autumn: ThemePack = {
  id: "autumn-gold",
  name: "金秋",
  base: "light",
  tokens: {
    "--background": "oklch(0.975 0.018 85)",
    "--primary": "oklch(0.55 0.14 68)",
  },
};

const root = () => document.documentElement;

beforeEach(() => {
  // jsdom 没有 CSS.supports：默认放行，需要断言"非法值被跳过"的用例再替换实现
  if (typeof CSS.supports !== "function") {
    Object.defineProperty(CSS, "supports", { value: () => true, configurable: true });
  }
});

afterEach(() => {
  applyThemePack(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("applyThemePack", () => {
  it("写入白名单 token 与 data-theme", () => {
    applyThemePack(autumn);
    expect(root().style.getPropertyValue("--background")).toBe("oklch(0.975 0.018 85)");
    expect(root().style.getPropertyValue("--primary")).toBe("oklch(0.55 0.14 68)");
    expect(root().dataset.theme).toBe("autumn-gold");
  });

  it("缺省 token 回落到 base 内置色", () => {
    applyThemePack(autumn);
    expect(root().style.getPropertyValue("--foreground")).toBe("oklch(0.21 0.02 260)");
  });

  it("深色 base 回落深色内置色", () => {
    applyThemePack({ ...autumn, id: "maple-red", base: "dark", tokens: {} });
    expect(root().style.getPropertyValue("--background")).toBe("oklch(0.145 0.01 260)");
    expect(root().style.getPropertyValue("--foreground")).toBe("oklch(0.96 0.005 260)");
  });

  it("清除后移除全部内联变量与 data-theme", () => {
    applyThemePack(autumn);
    applyThemePack(null);
    expect(root().style.getPropertyValue("--background")).toBe("");
    expect(root().style.getPropertyValue("--glass-bg")).toBe("");
    expect(root().dataset.theme).toBeUndefined();
  });

  it("白名单外的 key 一律忽略", () => {
    applyThemePack({
      ...autumn,
      tokens: { ...autumn.tokens, "--radius": "2rem", "font-family": "serif" },
    });
    expect(root().style.getPropertyValue("--radius")).toBe("");
    expect(root().style.getPropertyValue("font-family")).toBe("");
  });

  it("非法颜色跳过，其余 token 照常生效", () => {
    vi.spyOn(CSS, "supports").mockImplementation(((
      _prop: string,
      value: string,
    ) => typeof value === "string" && value.includes("oklch")) as typeof CSS.supports);
    applyThemePack({
      ...autumn,
      tokens: { "--background": "oklch(0.9 0 0)", "--primary": "not-a-color" },
    });
    expect(root().style.getPropertyValue("--background")).toBe("oklch(0.9 0 0)");
    // 非法项回落 base 内置主色
    expect(root().style.getPropertyValue("--primary")).toBe("oklch(0.55 0.14 235)");
  });

  it("派生设置面板皮肤变量", () => {
    applyThemePack(autumn);
    expect(root().style.getPropertyValue("--glass-bg")).toBe("oklch(0.975 0.018 85)");
    expect(root().style.getPropertyValue("--glass-primary")).toBe("oklch(0.55 0.14 68)");
    expect(root().style.getPropertyValue("--glass-primary-grad")).toContain(
      "oklch(0.55 0.14 68)",
    );
    expect(root().style.getPropertyValue("--glass-deco")).toContain("radial-gradient");
  });
});

describe("active theme pack id", () => {
  it("默认无选中", () => {
    expect(loadActiveThemePackId()).toBeNull();
  });

  it("保存与清除往返", () => {
    saveActiveThemePackId("autumn-gold");
    expect(loadActiveThemePackId()).toBe("autumn-gold");
    saveActiveThemePackId(null);
    expect(loadActiveThemePackId()).toBeNull();
  });
});

describe("themeSwatch", () => {
  it("取包内颜色，缺失回落 base", () => {
    expect(themeSwatch(autumn)).toEqual({
      bg: "oklch(0.975 0.018 85)",
      sidebar: "oklch(0.975 0.004 260)",
      primary: "oklch(0.55 0.14 68)",
    });
  });
});
