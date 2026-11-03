import { describe, expect, it } from "vitest";
import { THEME_TOKEN_KEYS, type ThemePack } from "./themePacks";
import {
  ALPHA_KEYS,
  FUNCTIONAL_KEYS,
  SHADOW_PRESETS,
  TOKEN_GROUPS,
  createDraft,
  dominantHue,
  formatOklch,
  isSameDraft,
  isValidThemeId,
  parseColor,
  parseOklch,
  rgbToOklch,
  rotateHues,
  serializeThemePack,
  setDraftToken,
  suggestThemeId,
  toPackJson,
  validateDraft,
} from "./themeEditor";

/** examples/themes/blueberry.rdtheme.json 的节选：主色系全在 275°，功能色各占一角 */
const blueberry: ThemePack = {
  id: "blueberry",
  name: "蓝莓",
  author: "cangyunye",
  version: "1.0.0",
  base: "dark",
  tokens: {
    "--background": "oklch(0.185 0.035 275)",
    "--foreground": "oklch(0.94 0.012 275)",
    "--primary": "oklch(0.68 0.15 275)",
    "--accent": "oklch(0.33 0.07 278)",
    "--border": "oklch(1 0 0 / 12%)",
    "--folder": "oklch(0.8 0.14 75)",
    "--ok": "oklch(0.72 0.13 155)",
    "--destructive": "oklch(0.65 0.2 25)",
    "--shadow": "0 16px 40px rgb(0 0 0 / 0.6)",
  },
};

describe("parseOklch / formatOklch", () => {
  it("解析项目既有写法并原样回写", () => {
    expect(parseOklch("oklch(0.185 0.035 275)")).toEqual({ l: 0.185, c: 0.035, h: 275, alpha: 1 });
    expect(formatOklch({ l: 0.185, c: 0.035, h: 275, alpha: 1 })).toBe("oklch(0.185 0.035 275)");
  });

  it("透明度：百分比与小数都认，回写为整数百分比", () => {
    expect(parseOklch("oklch(1 0 0 / 12%)")).toEqual({ l: 1, c: 0, h: 0, alpha: 0.12 });
    expect(parseOklch("oklch(1 0 0 / 0.5)")?.alpha).toBe(0.5);
    expect(formatOklch({ l: 1, c: 0, h: 0, alpha: 0.12 })).toBe("oklch(1 0 0 / 12%)");
  });

  it("L 百分比、C 百分比（相对 0.4）、色相单位与 none", () => {
    expect(parseOklch("oklch(50% 25% 0.5turn)")).toEqual({ l: 0.5, c: 0.1, h: 180, alpha: 1 });
    expect(parseOklch("oklch(0.5 0.1 none)")?.h).toBe(0);
    expect(parseOklch("OKLCH( 0.5  0.1  90deg )")?.h).toBe(90);
    expect(parseOklch("oklch(0.5 0.1 -90)")?.h).toBe(270);
  });

  it("越界值夹紧，非法写法返回 null", () => {
    expect(parseOklch("oklch(1.5 0.9 400)")).toEqual({ l: 1, c: 0.4, h: 40, alpha: 1 });
    expect(parseOklch("oklch(0.5 0.1)")).toBeNull();
    expect(parseOklch("oklch(0.5 0.1 20 / 1 / 2)")).toBeNull();
    expect(parseOklch("oklch(a b c)")).toBeNull();
    expect(parseOklch("#fff")).toBeNull();
  });

  it("格式化去尾零并保留 3/3/1 位精度", () => {
    expect(formatOklch({ l: 0.5, c: 0.123456, h: 275.04, alpha: 1 })).toBe("oklch(0.5 0.123 275)");
    expect(formatOklch({ l: 0.5, c: 0.1, h: 275.56, alpha: 1 })).toBe("oklch(0.5 0.1 275.6)");
    expect(formatOklch({ l: 0.5, c: 0.1, h: 365, alpha: 1 })).toBe("oklch(0.5 0.1 5)");
  });
});

describe("parseColor（归一化为 oklch）", () => {
  it("sRGB 极值与标准红色落在已知 OKLCH 附近", () => {
    const white = rgbToOklch(1, 1, 1);
    expect(white.l).toBeCloseTo(1, 2);
    expect(white.c).toBeCloseTo(0, 2);
    const black = rgbToOklch(0, 0, 0);
    expect(black.l).toBeCloseTo(0, 3);
    const red = parseColor("#ff0000")!;
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.258, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
  });

  it("hex 短写 / 带透明度，rgb 的逗号与斜杠语法", () => {
    expect(parseColor("#fff")?.l).toBeCloseTo(1, 2);
    expect(parseColor("#ff000080")?.alpha).toBeCloseTo(0.502, 2);
    expect(parseColor("rgb(255, 0, 0)")?.h).toBeCloseTo(29.2, 0);
    expect(parseColor("rgba(255, 0, 0, 0.5)")?.alpha).toBe(0.5);
    expect(parseColor("rgb(255 0 0 / 50%)")?.alpha).toBe(0.5);
    expect(parseColor("rgb(100% 0% 0%)")?.h).toBeCloseTo(29.2, 0);
  });

  it("oklch 直接透传，空串与乱码返回 null", () => {
    expect(parseColor("  oklch(0.5 0.1 20)  ")).toEqual({ l: 0.5, c: 0.1, h: 20, alpha: 1 });
    expect(parseColor("")).toBeNull();
    expect(parseColor("not-a-color-at-all")).toBeNull();
  });
});

describe("TOKEN_GROUPS", () => {
  it("恰好覆盖全部 23 个白名单 token，无重复无遗漏", () => {
    const all = TOKEN_GROUPS.flatMap((g) => g.keys);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...THEME_TOKEN_KEYS].sort());
  });

  it("功能色 / 透明度 token 都在白名单内", () => {
    for (const k of [...FUNCTIONAL_KEYS, ...ALPHA_KEYS]) {
      expect(THEME_TOKEN_KEYS).toContain(k);
    }
    expect(SHADOW_PRESETS.map((p) => p.id)).toEqual(["none", "light", "medium", "heavy"]);
  });
});

describe("id 规则", () => {
  it("isValidThemeId 与 Rust valid_id 一致", () => {
    expect(isValidThemeId("autumn-gold")).toBe(true);
    expect(isValidThemeId("a1")).toBe(true);
    expect(isValidThemeId("")).toBe(false);
    expect(isValidThemeId("-a")).toBe(false);
    expect(isValidThemeId("Autumn")).toBe(false);
    expect(isValidThemeId("a/b")).toBe(false);
    expect(isValidThemeId("a".repeat(65))).toBe(false);
  });

  it("suggestThemeId 清洗任意文本", () => {
    expect(suggestThemeId("My Theme!!")).toBe("my-theme");
    expect(suggestThemeId("--蓝莓--")).toBe("custom-theme");
    expect(suggestThemeId("blueberry-custom")).toBe("blueberry-custom");
    expect(suggestThemeId("x".repeat(80))).toHaveLength(64);
  });
});

describe("createDraft", () => {
  it("内置起点：全量 23 token + custom-<base>", () => {
    const d = createDraft("dark");
    expect(d.id).toBe("custom-dark");
    expect(d.base).toBe("dark");
    expect(Object.keys(d.tokens).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
    expect(d.tokens["--background"]).toBe("oklch(0.145 0.01 260)");
    expect(createDraft("light", { name: "Custom Light" }).name).toBe("Custom Light");
  });

  it("主题包起点：覆盖项优先、缺省项回落 base、id 加 -custom 后缀", () => {
    const d = createDraft(blueberry);
    expect(d.id).toBe("blueberry-custom");
    expect(d.name).toBe("蓝莓");
    expect(d.author).toBe("cangyunye");
    expect(d.tokens["--primary"]).toBe("oklch(0.68 0.15 275)");
    // 包里没写 --card → 深色内置
    expect(d.tokens["--card"]).toBe("oklch(0.19 0.012 260)");
    expect(Object.keys(d.tokens)).toHaveLength(THEME_TOKEN_KEYS.length);
  });

  it("setDraftToken 不可变更新；isSameDraft 脏检查", () => {
    const a = createDraft(blueberry);
    const b = setDraftToken(a, "--primary", "oklch(0.7 0.1 30)");
    expect(a.tokens["--primary"]).toBe("oklch(0.68 0.15 275)");
    expect(b.tokens["--primary"]).toBe("oklch(0.7 0.1 30)");
    expect(isSameDraft(a, a)).toBe(true);
    expect(isSameDraft(a, b)).toBe(false);
    expect(isSameDraft(a, { ...a, base: "light" })).toBe(false);
  });
});

describe("全局色相联动", () => {
  it("dominantHue 识别蓝莓的 275° 主色系，忽略功能色与灰阶", () => {
    const d = createDraft(blueberry);
    const hue = dominantHue(d.tokens)!;
    expect(hue).toBeGreaterThan(260);
    expect(hue).toBeLessThan(290);
  });

  it("全灰阶调色板返回 null", () => {
    const grey: Record<string, string> = {};
    for (const k of THEME_TOKEN_KEYS) grey[k] = k === "--shadow" ? "none" : "oklch(0.5 0 0)";
    expect(dominantHue(grey)).toBeNull();
  });

  it("rotateHues 旋转主题色、跳过功能色与灰阶、保留透明度", () => {
    const d = createDraft(blueberry);
    const rotated = rotateHues(d.tokens, 60);
    expect(parseOklch(rotated["--primary"])!.h).toBeCloseTo(335, 0);
    expect(parseOklch(rotated["--primary"])!.l).toBeCloseTo(0.68, 3);
    expect(parseOklch(rotated["--primary"])!.c).toBeCloseTo(0.15, 3);
    // 功能色原样
    expect(rotated["--folder"]).toBe("oklch(0.8 0.14 75)");
    expect(rotated["--ok"]).toBe("oklch(0.72 0.13 155)");
    expect(rotated["--destructive"]).toBe("oklch(0.65 0.2 25)");
    // 灰阶带透明度：不动
    expect(rotated["--border"]).toBe("oklch(1 0 0 / 12%)");
    // 阴影不是颜色
    expect(rotated["--shadow"]).toBe(d.tokens["--shadow"]);
    // 弱彩度前景也跟着转（保持整体协调）
    expect(parseOklch(rotated["--foreground"])!.h).toBeCloseTo(335, 0);
    // delta 0 原样返回
    expect(rotateHues(d.tokens, 0)).toBe(d.tokens);
  });

  it("旋转跨越 360 回绕", () => {
    const tokens = { ...createDraft("light").tokens, "--primary": "oklch(0.6 0.15 350)" };
    expect(parseOklch(rotateHues(tokens, 30)["--primary"])!.h).toBeCloseTo(20, 0);
  });
});

describe("序列化与校验", () => {
  it("toPackJson 用 $schema 键名、按白名单顺序写全量 token、空 author 省略", () => {
    const d = createDraft("light");
    const json = toPackJson(d);
    expect(json.$schema).toBe("rdir-theme/1");
    expect(json.author).toBeUndefined();
    expect(json.version).toBe("1.0.0");
    expect(Object.keys(json.tokens as object)).toEqual([...THEME_TOKEN_KEYS]);
    const text = serializeThemePack({ ...d, author: "  me  " });
    const parsed = JSON.parse(text);
    expect(parsed.author).toBe("me");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("validateDraft：id / 名称规则", () => {
    const d = createDraft("light");
    expect(validateDraft(d)).toBeNull();
    expect(validateDraft({ ...d, id: "Bad Id" })).toMatch(/id/);
    expect(validateDraft({ ...d, name: "   " })).toMatch(/名称/);
    expect(validateDraft({ ...d, name: "字".repeat(41) })).toMatch(/40/);
  });
});
