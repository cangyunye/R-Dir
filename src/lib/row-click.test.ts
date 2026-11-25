import { describe, expect, it } from "vitest";
import { rowClickIntent } from "./row-click";

describe("rowClickIntent", () => {
  it("连续快速点击（桌面端实测序列 10…15，全程无 dblclick 事件）：偶数击都是双击", () => {
    for (const d of [2, 4, 6, 8, 10, 12, 14]) expect(rowClickIntent(d, 80)).toBe("open");
    for (const d of [3, 5, 7, 9, 11, 13, 15]) expect(rowClickIntent(d, 80)).toBe("select");
  });

  it("常规双击（序号 1 → 2）：第 2 次单击打开", () => {
    expect(rowClickIntent(1, Infinity)).toBe("select");
    expect(rowClickIntent(2, 120)).toBe("open");
  });

  it("序号 1 且间隔 ≤450ms：既不打开也不重命名（原行为；加选/减选的快速连点不受影响）", () => {
    expect(rowClickIntent(1, 0)).toBe("select");
    expect(rowClickIntent(1, 450)).toBe("select");
  });

  it("慢速双击仍是重命名：序号 1 且距同一条目上次单击 450ms–3s", () => {
    expect(rowClickIntent(1, 451)).toBe("rename");
    expect(rowClickIntent(1, 2999)).toBe("rename");
    expect(rowClickIntent(1, 3000)).toBe("select");
    expect(rowClickIntent(1, Infinity)).toBe("select");
  });

  it("合成事件（detail 为 0）一律只选中，不打开也不重命名", () => {
    expect(rowClickIntent(0, 50)).toBe("select");
    expect(rowClickIntent(0, 1000)).toBe("select");
  });
});
