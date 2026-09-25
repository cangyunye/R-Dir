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
