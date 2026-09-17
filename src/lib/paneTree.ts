import type { PaneNode, SplitNode } from "./types";

/** 收集树中所有 pane id（先序遍历） */
export function collectPaneIds(node: PaneNode): number[] {
  if (node.type === "pane") return [node.paneId];
  return [...collectPaneIds(node.a), ...collectPaneIds(node.b)];
}

/** 树中第一个 pane id */
export function firstPaneId(node: PaneNode): number {
  if (node.type === "pane") return node.paneId;
  return firstPaneId(node.a);
}

/** 将根节点下指定的 pane 叶子替换为新节点，返回新根 */
export function replacePane(
  node: PaneNode,
  paneId: number,
  replacement: PaneNode,
): PaneNode {
  if (node.type === "pane") {
    return node.paneId === paneId ? replacement : node;
  }
  return {
    ...node,
    a: replacePane(node.a, paneId, replacement),
    b: replacePane(node.b, paneId, replacement),
  };
}

/** 按 split id 更新分割比例，返回新根 */
export function setSplitRatio(
  node: PaneNode,
  splitId: number,
  ratio: number,
): PaneNode {
  if (node.type === "pane") return node;
  const clamp = Math.min(0.9, Math.max(0.1, ratio));
  if (node.id === splitId) {
    return { ...node, ratio: clamp };
  }
  return {
    ...node,
    a: setSplitRatio(node.a, splitId, clamp),
    b: setSplitRatio(node.b, splitId, clamp),
  };
}

/** 移除指定 pane，兄弟提升；返回 null 表示整个树被移除（不应发生） */
export function removePane(node: PaneNode, paneId: number): PaneNode | null {
  if (node.type === "pane") {
    return node.paneId === paneId ? null : node;
  }
  const a = removePane(node.a, paneId);
  const b = removePane(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/** 统计 pane 数量 */
export function countPanes(node: PaneNode): number {
  if (node.type === "pane") return 1;
  return countPanes(node.a) + countPanes(node.b);
}

/** 判断根节点是否就是单个 pane */
export function isSinglePane(node: PaneNode): boolean {
  return node.type === "pane";
}

/** 创建新的分割节点 */
export function makeSplit(
  id: number,
  dir: SplitNode["dir"],
  a: PaneNode,
  b: PaneNode,
): SplitNode {
  return { type: "split", id, dir, ratio: 0.5, a, b };
}

/** 将所有分割比例重置为 0.5 */
export function resetRatios(node: PaneNode): PaneNode {
  if (node.type === "pane") return node;
  return { ...node, ratio: 0.5, a: resetRatios(node.a), b: resetRatios(node.b) };
}
