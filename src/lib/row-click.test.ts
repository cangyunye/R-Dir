import { describe, expect, it } from "vitest";
import { rowClickIntent } from "./row-click";

describe("rowClickIntent", () => {
  it("连续快速点击（桌面端实测序列 10…15，全程无 dblclick 事件）：偶数击都是双击", () => {
    for (const d of [2, 4, 6, 8, 10, 12, 14]) expect(rowClickIntent(d, 80, true)).toBe("open");
    for (const d of [3, 5, 7, 9, 11, 13, 15]) expect(rowClickIntent(d, 80, true)).toBe("select");
  });

  it("序号复位为 1：首次单击只选中；同一条目 450ms 内再次单击判为双击", () => {
    expect(rowClickIntent(1, Infinity, true)).toBe("select");
    expect(rowClickIntent(1, 450, true)).toBe("open");
    expect(rowClickIntent(1, 120, true)).toBe("open");
  });

  it("带修饰键的两次快速单击不算双击（Cmd 连点是加选/减选）", () => {
    expect(rowClickIntent(1, 120, false)).toBe("select");
  });

  it("慢速双击仍是重命名：序号 1 且距同一条目上次单击 450ms–3s", () => {
    expect(rowClickIntent(1, 451, true)).toBe("rename");
    expect(rowClickIntent(1, 2999, true)).toBe("rename");
    expect(rowClickIntent(1, 600, false)).toBe("rename"); // 与原行为一致：不区分修饰键
    expect(rowClickIntent(1, 3000, true)).toBe("select");
    expect(rowClickIntent(1, Infinity, true)).toBe("select");
  });

  it("合成事件（detail 为 0）一律只选中，不打开也不重命名", () => {
    expect(rowClickIntent(0, 50, true)).toBe("select");
    expect(rowClickIntent(0, 1000, true)).toBe("select");
  });
});
