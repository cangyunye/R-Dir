import { describe, it, expect } from "vitest";
import {
  collectPaneIds,
  firstPaneId,
  replacePane,
  setSplitRatio,
  removePane,
  countPanes,
  isSinglePane,
  makeSplit,
  resetRatios,
} from "./paneTree";
import type { PaneNode } from "./types";

// 构造测试树：split(1, row) -> pane(1) | split(2, col) -> pane(2) | pane(3)
function makeTree(): PaneNode {
  return {
    type: "split",
    id: 1,
    dir: "row",
    ratio: 0.5,
    a: { type: "pane", paneId: 1 },
    b: {
      type: "split",
      id: 2,
      dir: "col",
      ratio: 0.5,
      a: { type: "pane", paneId: 2 },
      b: { type: "pane", paneId: 3 },
    },
  };
}

describe("collectPaneIds", () => {
  it("收集所有 pane id", () => {
    expect(collectPaneIds(makeTree())).toEqual([1, 2, 3]);
  });
  it("单 pane 返回自身", () => {
    expect(collectPaneIds({ type: "pane", paneId: 5 })).toEqual([5]);
  });
});

describe("firstPaneId", () => {
  it("返回最左 pane", () => {
    expect(firstPaneId(makeTree())).toBe(1);
  });
});

describe("countPanes", () => {
  it("树有 3 个 pane", () => {
    expect(countPanes(makeTree())).toBe(3);
  });
  it("单 pane 返回 1", () => {
    expect(countPanes({ type: "pane", paneId: 1 })).toBe(1);
  });
});

describe("isSinglePane", () => {
  it("单 pane 为 true", () => {
    expect(isSinglePane({ type: "pane", paneId: 1 })).toBe(true);
  });
  it("split 为 false", () => {
    expect(isSinglePane(makeTree())).toBe(false);
  });
});

describe("replacePane", () => {
  it("替换指定 pane 为新 split", () => {
    const tree = makeTree();
    const newSplit = makeSplit(3, "row", { type: "pane", paneId: 4 }, { type: "pane", paneId: 5 });
    const result = replacePane(tree, 2, newSplit);
    expect(collectPaneIds(result)).toEqual([1, 4, 5, 3]);
  });
  it("替换不存在的 pane id 不报错", () => {
    const tree = makeTree();
    const result = replacePane(tree, 99, { type: "pane", paneId: 10 });
    expect(collectPaneIds(result)).toEqual([1, 2, 3]);
  });
});

describe("setSplitRatio", () => {
  it("设置 split 比例", () => {
    const tree = makeTree();
    const result = setSplitRatio(tree, 1, 0.3);
    expect(result.type === "split" ? result.ratio : 0).toBe(0.3);
  });
  it("比例被 clamp 到 [0.1, 0.9]", () => {
    const tree = makeTree();
    const low = setSplitRatio(tree, 1, 0.01);
    const high = setSplitRatio(tree, 1, 0.99);
    expect(low.type === "split" ? low.ratio : 0).toBe(0.1);
    expect(high.type === "split" ? high.ratio : 0).toBe(0.9);
  });
});

describe("removePane", () => {
  it("移除叶子 pane，兄弟提升", () => {
    const tree = makeTree();
    const result = removePane(tree, 3);
    expect(result).not.toBeNull();
    expect(collectPaneIds(result!)).toEqual([1, 2]);
  });
  it("移除 split 分支里的一个 pane", () => {
    const tree = makeTree();
    const result = removePane(tree, 2);
    expect(collectPaneIds(result!)).toEqual([1, 3]);
  });
  it("移除根 pane 返回 null", () => {
    expect(removePane({ type: "pane", paneId: 1 }, 1)).toBeNull();
  });
});

describe("resetRatios", () => {
  it("所有 split 比例重置为 0.5", () => {
    const tree = setSplitRatio(makeTree(), 1, 0.3);
    const result = resetRatios(tree);
    function check(node: PaneNode): boolean {
      if (node.type === "pane") return true;
      return node.ratio === 0.5 && check(node.a) && check(node.b);
    }
    expect(check(result)).toBe(true);
  });
});
