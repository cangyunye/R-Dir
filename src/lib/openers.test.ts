import { describe, it, expect } from "vitest";
import { normalizeExt, normalizeExts, openersForEntry } from "./openers";
import type { OpenerItem } from "@/lib/openerApi";

const mk = (id: string, extensions: string[]): OpenerItem => ({
  id,
  name: id,
  kind: "custom",
  detected: true,
  exec: `/x/${id}`,
  cli: false,
  extensions,
});

describe("normalizeExt / normalizeExts", () => {
  it("去空白、去前导点、小写", () => {
    expect(normalizeExt(" .JSON ")).toBe("json");
    expect(normalizeExt("Yaml")).toBe("yaml");
  });

  it("去重保序、丢弃空值", () => {
    expect(normalizeExts(["json", ".JSON", "json", "", "  ", "yaml"])).toEqual([
      "json",
      "yaml",
    ]);
  });

  it("保留通配 *", () => {
    expect(normalizeExts(["*"])).toEqual(["*"]);
  });
});

describe("openersForEntry", () => {
  const zed = mk("zed", ["json", "yaml"]);
  const code = mk("code", ["ts", "tsx"]);
  const universal = mk("uni", ["*"]);
  const none = mk("none", []);

  it("按扩展名命中", () => {
    expect(openersForEntry([zed, code], "json")).toEqual([zed]);
    expect(openersForEntry([zed, code], "ts")).toEqual([code]);
  });

  it("大小写与前导点归一化后仍命中", () => {
    expect(openersForEntry([zed], ".JSON")).toEqual([zed]);
  });

  it("通配 * 对所有类型生效", () => {
    expect(openersForEntry([zed, universal], "png")).toEqual([universal]);
    expect(openersForEntry([universal], "")).toEqual([universal]);
  });

  it("空 extensions 不出现在任何类型", () => {
    expect(openersForEntry([none], "json")).toEqual([]);
    expect(openersForEntry([none], "")).toEqual([]);
  });

  it("无扩展名文件只有通配可匹配", () => {
    expect(openersForEntry([zed, universal], "")).toEqual([universal]);
  });

  it("非 custom 类型被过滤", () => {
    const builtin = { ...mk("b", ["json"]), kind: "builtin" };
    expect(openersForEntry([builtin, zed], "json")).toEqual([zed]);
  });
});
