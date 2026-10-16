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

/** 树中是否存在指定 pane 叶子 */
export function hasPaneId(node: PaneNode, paneId: number): boolean {
  if (node.type === "pane") return node.paneId === paneId;
  return hasPaneId(node.a, paneId) || hasPaneId(node.b, paneId);
}

/** 互换树中两个 pane 叶子的位置（内容跟随各自 paneId 不变，仅布局对调）。
 *  单趟遍历完成——先 replacePane(a→b) 再 replacePane(b→a) 会命中两处同名叶子，
 *  把两个位置都换成同一个 pane。任一 id 不在树中（或 a===b）时原样返回。 */
export function swapPanes(node: PaneNode, a: number, b: number): PaneNode {
  if (a === b || !hasPaneId(node, a) || !hasPaneId(node, b)) return node;
  const walk = (n: PaneNode): PaneNode => {
    if (n.type === "pane") {
      if (n.paneId === a) return { ...n, paneId: b };
      if (n.paneId === b) return { ...n, paneId: a };
      return n;
    }
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(node);
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
