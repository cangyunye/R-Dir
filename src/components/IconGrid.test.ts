import { describe, it, expect } from "vitest";
import { layoutSlots } from "@/components/IconGrid";

const names = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

describe("layoutSlots（v0.27 图标自由摆放布局）", () => {
  it("无记录：按序行主序铺满", () => {
    const m = layoutSlots(names(5), 3, {});
    expect(m.get("f0")).toEqual({ c: 0, r: 0 });
    expect(m.get("f1")).toEqual({ c: 1, r: 0 });
    expect(m.get("f2")).toEqual({ c: 2, r: 0 });
    expect(m.get("f3")).toEqual({ c: 0, r: 1 });
    expect(m.get("f4")).toEqual({ c: 1, r: 1 });
  });

  it("有记录：记录槽位优先，其余补首个空槽", () => {
    const m = layoutSlots(names(4), 3, { f3: [0, 0] });
    expect(m.get("f3")).toEqual({ c: 0, r: 0 });
    expect(m.get("f0")).toEqual({ c: 1, r: 0 }); // 记录占用后顺延
    expect(m.get("f2")).toEqual({ c: 0, r: 1 });
  });

  it("记录越界（窗口变窄）：该条目退回自动补位", () => {
    const m = layoutSlots(names(2), 2, { f1: [5, 0] });
    expect(m.get("f0")).toEqual({ c: 0, r: 0 });
    expect(m.get("f1")).toEqual({ c: 1, r: 0 });
  });

  it("记录冲突（两条目同槽）：先到先得，后者补位", () => {
    const m = layoutSlots(["a", "b"], 3, { a: [1, 1], b: [1, 1] });
    expect(m.get("a")).toEqual({ c: 1, r: 1 });
    expect(m.get("b")).not.toEqual({ c: 1, r: 1 });
  });

  it("空目录：空布局", () => {
    expect(layoutSlots([], 4, {}).size).toBe(0);
  });
});
