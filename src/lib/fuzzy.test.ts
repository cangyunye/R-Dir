import { describe, it, expect } from "vitest";
import { fuzzyMatch, rank } from "./fuzzy";

describe("fuzzyMatch 模糊匹配", () => {
  it("空 query 匹配一切且无高亮", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("返回命中位置（升序，用于高亮）", () => {
    // main.rs -> m(0) … n(3)
    expect(fuzzyMatch("mn", "main.rs")!.positions).toEqual([0, 3]);
  });

  it("大小写不敏感", () => {
    // main.rs -> m(0) … r(5)
    expect(fuzzyMatch("MR", "main.rs")!.positions).toEqual([0, 5]);
  });

  it("顺序不匹配时返回 null", () => {
    expect(fuzzyMatch("zz", "main.rs")).toBeNull();
    expect(fuzzyMatch("na", "main.rs")).toBeNull();
  });

  it("整段前缀优于间断命中", () => {
    const prefix = fuzzyMatch("main", "main.rs")!;
    const gap = fuzzyMatch("main", "m_a_i_n.rs")!;
    expect(prefix.score).toBeGreaterThan(gap.score);
  });

  it("连续命中优于断开命中", () => {
    const cont = fuzzyMatch("ab", "xxab")!;
    const broken = fuzzyMatch("ab", "axxb")!;
    expect(cont.score).toBeGreaterThan(broken.score);
  });

  it("分隔符后的命中获得词首奖励", () => {
    const boundary = fuzzyMatch("b", "a_b")!;
    const inner = fuzzyMatch("b", "ab_")!;
    expect(boundary.score).toBeGreaterThan(inner.score);
  });

  it("驼峰边界获得词首奖励并返回位置", () => {
    expect(fuzzyMatch("mh", "mainHandle")!.positions).toEqual([0, 4]);
  });

  it("支持中文子序列", () => {
    // 我的文档.txt -> 文(2) 档(3)
    expect(fuzzyMatch("文档", "我的文档.txt")!.positions).toEqual([2, 3]);
  });
});

describe("rank 排名", () => {
  const items = ["main.rs", "lib.rs", "mod.rs"];

  it("空 query 保持输入顺序、无高亮", () => {
    const r = rank(items, "", (s) => s);
    expect(r.map((x) => x.item)).toEqual(items);
    expect(r.every((x) => x.positions.length === 0)).toBe(true);
  });

  it("按分数降序，短名在前（同结构时）", () => {
    // "rs" 在 lib.rs / mod.rs / main.rs 均为 .rs 段连续命中，短名分高
    expect(rank(items, "rs", (s) => s).map((x) => x.item)).toEqual([
      "lib.rs",
      "mod.rs",
      "main.rs",
    ]);
  });

  it("不匹配的条目被剔除", () => {
    expect(rank(["a.txt", "b.rs"], "b", (s) => s).map((x) => x.item)).toEqual(["b.rs"]);
  });

  it("同分保持输入顺序（稳定）", () => {
    const r = rank(["ab", "ab"], "ab", (s) => s);
    expect(r.map((x) => x.item)).toEqual(["ab", "ab"]);
    expect(r[0].positions).toEqual([0, 1]);
  });
});
