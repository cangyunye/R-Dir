import type { ResolutionPlan, TransferConflict } from "./types";

/** 冲突弹窗的一次裁决 */
export type ConflictAction =
  | { type: "overwrite" }
  | { type: "overwriteAll" }
  | { type: "rename"; name: string }
  | { type: "stop" };

export interface DecisionResult {
  plan: ResolutionPlan;
  nextIndex: number;
  finished: boolean;
  stopped: boolean;
}

/**
 * 应用一次冲突裁决，返回累积方案与下一步索引（纯函数）。
 * 「全部覆盖」把当前及之后所有冲突一次性设为覆盖。
 */
export function applyConflictAction(
  conflicts: TransferConflict[],
  index: number,
  plan: ResolutionPlan,
  action: ConflictAction,
): DecisionResult {
  if (index < 0 || index >= conflicts.length) {
    return { plan, nextIndex: index, finished: true, stopped: false };
  }
  if (action.type === "stop") {
    return { plan, nextIndex: index, finished: false, stopped: true };
  }
  const next: ResolutionPlan = { ...plan };
  if (action.type === "overwriteAll") {
    for (const c of conflicts.slice(index)) next[c.dest] = { action: "overwrite" };
    return { plan: next, nextIndex: conflicts.length, finished: true, stopped: false };
  }
  const cur = conflicts[index];
  if (action.type === "overwrite") {
    next[cur.dest] = { action: "overwrite" };
  } else {
    next[cur.dest] = { action: "rename", name: action.name };
  }
  const nextIndex = index + 1;
  return {
    plan: next,
    nextIndex,
    finished: nextIndex >= conflicts.length,
    stopped: false,
  };
}

/**
 * 远程粘贴（目标为 sftp://）冲突扫描结果的分拣（纯函数）：
 * - 顶层条目冲突（conflict.src 就是粘贴清单里的路径）→ 交 ConflictDialog 逐条裁决；
 * - 下钻冲突（同名目录合并内部的同名文件，src 在粘贴清单某条目的子树内）→
 *   按覆盖处理，对齐本地跨目录复制目录「同名内容一律覆盖」的语义。
 * 判定用精确字符串相等：后端扫描对顶层冲突原样返回输入路径，下钻冲突是其子路径。
 */
export function splitRemoteConflicts(
  conflicts: TransferConflict[],
  srcs: string[],
): { topLevel: TransferConflict[]; drilled: TransferConflict[] } {
  const set = new Set(srcs);
  const topLevel: TransferConflict[] = [];
  const drilled: TransferConflict[] = [];
  for (const c of conflicts) {
    (set.has(c.src) ? topLevel : drilled).push(c);
  }
  return { topLevel, drilled };
}

/**
 * 冲突弹窗裁决（plan 以冲突 dest 为 key）折算成每个源条目的落盘名（纯函数）：
 * rename 裁决取用户输入名，其余保持原名。逐条跳过不存在——弹窗只有
 * 覆盖/全部覆盖/改名/停止，「停止」由调用方整体中止，不产生 skip。
 */
export function remoteNamesFromPlan(
  topLevel: TransferConflict[],
  plan: ResolutionPlan,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const c of topLevel) {
    const r = plan[c.dest];
    if (r?.action === "rename") names[c.src] = r.name;
  }
  return names;
}
