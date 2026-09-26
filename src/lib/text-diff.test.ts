import { describe, expect, it } from "vitest";
import {
  buildDisplayItems,
  parseUnifiedDiff,
  rowsFromSegments,
  rowsStats,
  type TextSegment,
} from "./text-diff";

const seg = (
  kind: TextSegment["kind"],
  leftStart: number | null,
  rightStart: number | null,
  lines: string[],
): TextSegment => ({ kind, leftStart, rightStart, lines });

describe("rowsFromSegments", () => {
  it("eq 段展开为双侧行", () => {
    const rows = rowsFromSegments([seg("eq", 1, 1, ["a", "b"])]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      kind: "eq",
      left: { no: 1, text: "a" },
      right: { no: 1, text: "a" },
    });
  });

  it("相邻 del+add 段 zip 成对", () => {
    const rows = rowsFromSegments([
      seg("eq", 1, 1, ["ctx"]),
      seg("del", 2, null, ["old1", "old2", "old3"]),
      seg("add", null, 2, ["new1", "new2"]),
      seg("eq", 4, 4, ["after"]),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["eq", "pair", "pair", "del", "eq"]);
    expect(rows[1].left).toEqual({ no: 2, text: "old1" });
    expect(rows[1].right).toEqual({ no: 2, text: "new1" });
    // 多出的一侧保持纯删
    expect(rows[3].kind).toBe("del");
    expect(rows[3].left?.text).toBe("old3");
  });

  it("孤立 del/add 段不配对", () => {
    const rows = rowsFromSegments([seg("add", null, 1, ["x"])]);
    expect(rows.map((r) => r.kind)).toEqual(["add"]);
  });
});

describe("parseUnifiedDiff", () => {
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 83db48f..bf269f4 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-old line",
    "+new line",
    " line3",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+added",
    "+lines",
  ].join("\n");

  it("解析多文件 patch 与 hunk 行号", () => {
    const sections = parseUnifiedDiff(patch);
    expect(sections).toHaveLength(2);
    expect(sections[0].leftName).toBe("src/app.ts");
    expect(sections[0].rightName).toBe("src/app.ts");
    expect(sections[0].rows.map((r) => r.kind)).toEqual(["eq", "pair", "eq"]);
    expect(sections[0].rows[1].left?.no).toBe(2);
    expect(sections[0].rows[1].right?.no).toBe(2);
    // 新文件：/dev/null + 纯 add
    expect(sections[1].leftName).toBe("/dev/null");
    expect(sections[1].rows.map((r) => r.kind)).toEqual(["add", "add"]);
    expect(sections[1].rows[0].right?.no).toBe(1);
  });

  it("无 hunk 头的纯 unified diff 也能解析", () => {
    const sections = parseUnifiedDiff(["--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
    expect(sections).toHaveLength(1);
    expect(rowsStats(sections[0].rows)).toEqual({ additions: 1, deletions: 1 });
  });

  it("容忍 CI 日志前后文噪音", () => {
    const noisy = ["推送日志...", "some CI output", ...patch.split("\n")].join("\n");
    const sections = parseUnifiedDiff(noisy);
    expect(sections).toHaveLength(2);
  });

  it("无 diff 内容时返回空", () => {
    expect(parseUnifiedDiff("随便一段日志\n没有 diff")).toHaveLength(0);
  });
});

describe("buildDisplayItems", () => {
  const manyEq = (n: number, start = 1) =>
    seg("eq", start, start, Array.from({ length: n }, (_, i) => `same${start + i}`));

  it("长相同段折叠为间隙，保留上下文", () => {
    const rows = rowsFromSegments([
      manyEq(20),
      seg("del", 21, null, ["gone"]),
      seg("add", null, 21, ["here"]),
      manyEq(20, 22),
    ]);
    const items = buildDisplayItems(rows, { ctx: 3 });
    // 头部 3 行 + gap + 1 对 + 尾部 3 行
    const gaps = items.filter((i) => i.type === "gap") as Extract<typeof items[number], { type: "gap" }>[];
    expect(gaps).toHaveLength(2);
    expect(gaps[0].count).toBe(17);
    const rowCount = items.filter((i) => i.type === "row").length;
    expect(rowCount).toBe(3 + 1 + 3);
  });

  it("展开的间隙还原全部行", () => {
    const rows = rowsFromSegments([manyEq(20), seg("del", 21, null, ["gone"]), seg("add", null, 21, ["here"])]);
    const collapsed = buildDisplayItems(rows, { ctx: 3 });
    const gap = collapsed.find((i) => i.type === "gap") as Extract<
      typeof collapsed[number],
      { type: "gap" }
    >;
    const expandedSet = new Set([gap.id]);
    const expanded = buildDisplayItems(rows, { ctx: 3, expanded: expandedSet });
    expect(expanded.some((i) => i.type === "gap")).toBe(false);
    expect(expanded.filter((i) => i.type === "row")).toHaveLength(20 + 1);
  });

  it("onlyDiff 折叠全部相同行", () => {
    const rows = rowsFromSegments([
      manyEq(5),
      seg("del", 6, null, ["x"]),
      seg("add", null, 6, ["y"]),
      manyEq(2, 7),
    ]);
    const items = buildDisplayItems(rows, { onlyDiff: true });
    expect(items.filter((i) => i.type === "row")).toHaveLength(1);
    expect(items.filter((i) => i.type === "gap")).toHaveLength(2);
  });
});
