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
 * - 顶层条目冲突（conflict.src 就是粘贴清单里的路径，含同名目录的目录行）→
 *   交 ConflictDialog 逐条裁决（目录行「覆盖」= 递归合并）；
 * - 下钻冲突（同名目录合并内部的同名文件，src 在粘贴清单某条目的子树内）→
 *   按覆盖处理（类型冲突在落盘前预删除，见 drilledTypeClashes）。
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

/** src 是否落在 owner 子树内：sftp URL 按 / 判定；本地路径兼容 / 与 \ 分隔符 */
function underSrcTree(src: string, owner: string): boolean {
  if (owner.startsWith("sftp://")) return src.startsWith(`${owner}/`);
  return src.startsWith(`${owner}/`) || src.startsWith(`${owner}\\`);
}

/**
 * 下钻类型冲突按顶层目录行的裁决收敛（纯函数）：
 * 后端对顶层同名目录报一条目录冲突行（「覆盖」= 递归合并），并继续下钻报文件级
 * 冲突；其中类型冲突（文件 vs 目录）合并落盘前需先删目标侧条目。但顶层目录行被
 * 「改名」时子树落到新名下（不再有冲突），该目录的下钻行全部作废——预删除不得
 * 动手，否则会误删用户选择不覆盖的原目录内容。非类型冲突的下钻行（文件 vs 文件）
 * 由中转/上传按覆盖自然落盘，无需处理，这里一并过滤。
 * owner 取包含 d.src 的最长顶层 src；无顶层行（防御，正常不会发生）或顶层未被
 * 「改名」时维持覆盖行为。
 */
export function drilledTypeClashes(
  drilled: TransferConflict[],
  topLevel: TransferConflict[],
  plan: ResolutionPlan,
): TransferConflict[] {
  return drilled.filter((c) => {
    if (c.srcKind === c.destKind) return false;
    let owner: TransferConflict | undefined;
    for (const t of topLevel) {
      if (underSrcTree(c.src, t.src) && (!owner || t.src.length > owner.src.length)) {
        owner = t;
      }
    }
    return plan[owner?.dest ?? ""]?.action !== "rename";
  });
}
