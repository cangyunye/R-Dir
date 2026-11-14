import { describe, it, expect } from "vitest";
import { computeSlotShift, shiftKey } from "./slot-shift";

/** 4 列网格,name@idx 排布 */
function grid4(entries: [string, number][]): Map<string, { c: number; r: number }> {
  return new Map(
    entries.map(([name, idx]) => [name, { c: idx % 4, r: Math.floor(idx / 4) }]),
  );
}

describe("computeSlotShift（v0.49 特性5 雅·挤开插入推移）", () => {
  it("目标在后方：链上占用项前移一位", () => {
    // a(0) b(1) c(2) d(3)：把 a 拖到 idx2 → b→0, c→1, a→2
    const slots = grid4([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ]);
    const shift = computeSlotShift({ c: 0, r: 0 }, { c: 2, r: 0 }, 4, slots, new Set(["a"]));
    expect(shift?.get("b")).toEqual({ c: 0, r: 0 });
    expect(shift?.get("c")).toEqual({ c: 1, r: 0 });
    expect(shift?.has("d")).toBe(false); // 链外不动
  });

  it("目标在前方：链上占用项后移一位", () => {
    // 把 d(3) 拖到 idx0 → a→1, b→2, c→3, d→0
    const slots = grid4([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ]);
    const shift = computeSlotShift({ c: 3, r: 0 }, { c: 0, r: 0 }, 4, slots, new Set(["d"]));
    expect(shift?.get("a")).toEqual({ c: 1, r: 0 });
    expect(shift?.get("b")).toEqual({ c: 2, r: 0 });
    expect(shift?.get("c")).toEqual({ c: 3, r: 0 });
  });

  it("跨行推移（行主序索引换算）", () => {
    // 4 列：a(0,0)=idx0, e(0,1)=idx4；把 a 拖到 idx4 → b→0, c→1, d→2, e→3
    const slots = grid4([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
      ["e", 4],
    ]);
    const shift = computeSlotShift({ c: 0, r: 0 }, { c: 0, r: 1 }, 4, slots, new Set(["a"]));
    expect(shift?.get("e")).toEqual({ c: 3, r: 0 });
    expect(shift?.get("d")).toEqual({ c: 2, r: 0 });
  });

  it("空洞照常参与链（推移项填入空洞）", () => {
    // a(0) c(2)：b 缺席。a 拖到 idx2 → 空槽1被 c 填,c→1, a→2
    const slots = grid4([
      ["a", 0],
      ["c", 2],
    ]);
    const shift = computeSlotShift({ c: 0, r: 0 }, { c: 2, r: 0 }, 4, slots, new Set(["a"]));
    expect(shift?.get("c")).toEqual({ c: 1, r: 0 });
  });

  it("同槽 → null（原位无推移）；负索引钳到 0", () => {
    const slots = grid4([
      ["a", 0],
      ["b", 1],
    ]);
    expect(computeSlotShift({ c: 1, r: 0 }, { c: 1, r: 0 }, 4, slots, new Set(["a"]))).toBeNull();
    // 指针越界到负槽位（slotAt 可回负值）→ 钳到 idx0
    const shift = computeSlotShift({ c: 1, r: 0 }, { c: -3, r: 0 }, 4, slots, new Set(["a"]));
    expect(shift?.get("a")).toBeUndefined();
    expect(shiftKey(shift)).toBe("");
  });

  it("shiftKey 稳定序列化（预览态去重用）", () => {
    const slots = grid4([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const s1 = computeSlotShift({ c: 0, r: 0 }, { c: 2, r: 0 }, 4, slots, new Set(["a"]));
    const s2 = computeSlotShift({ c: 0, r: 0 }, { c: 2, r: 0 }, 4, slots, new Set(["a"]));
    expect(shiftKey(s1)).toBe(shiftKey(s2));
    expect(shiftKey(s1)).not.toBe("");
    expect(shiftKey(null)).toBe("");
  });
});
