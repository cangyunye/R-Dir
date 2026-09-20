import { describe, it, expect } from "vitest";
import { applyConflictAction } from "./transfer";
import type { TransferConflict } from "./types";

const c = (dest: string): TransferConflict => ({
  src: `/src/${dest}`,
  dest: `/dst/${dest}`,
  srcKind: "file",
  destKind: "file",
  suggest: `${dest}_1`,
});

const three = [c("a.txt"), c("b.txt"), c("c.txt")];

describe("applyConflictAction", () => {
  it("覆盖单条并前进", () => {
    const r = applyConflictAction(three, 0, {}, { type: "overwrite" });
    expect(r.plan["/dst/a.txt"]).toEqual({ action: "overwrite" });
    expect(r.nextIndex).toBe(1);
    expect(r.finished).toBe(false);
    expect(r.stopped).toBe(false);
  });

  it("最后一条裁决后 finished", () => {
    const r = applyConflictAction(three, 2, {}, { type: "overwrite" });
    expect(r.finished).toBe(true);
    expect(r.nextIndex).toBe(3);
  });

  it("改名写入 name", () => {
    const r = applyConflictAction(three, 0, {}, { type: "rename", name: "a_1.txt" });
    expect(r.plan["/dst/a.txt"]).toEqual({ action: "rename", name: "a_1.txt" });
  });

  it("全部覆盖把当前及之后都设为覆盖", () => {
    const r = applyConflictAction(three, 1, { "/dst/a.txt": { action: "skip" } }, {
      type: "overwriteAll",
    });
    expect(r.plan["/dst/a.txt"]).toEqual({ action: "skip" });
    expect(r.plan["/dst/b.txt"]).toEqual({ action: "overwrite" });
    expect(r.plan["/dst/c.txt"]).toEqual({ action: "overwrite" });
    expect(r.finished).toBe(true);
  });

  it("停止返回 stopped 且不改方案", () => {
    const base = { "/dst/a.txt": { action: "overwrite" as const } };
    const r = applyConflictAction(three, 1, base, { type: "stop" });
    expect(r.stopped).toBe(true);
    expect(r.plan).toEqual(base);
  });
});
