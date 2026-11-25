/**
 * v0.52 导航诊断环形缓冲（快速连钻卡死排查）：原始输入事件（按下/单击/双击/按键，
 * 含目标行路径与连击序号）+ 导航/加载触发流程 全留痕。
 * - dev 构建自动启用（import.meta.env.DEV），正式包用 localStorage rfm.debug-nav=1 打开
 * - 环形 80 条，window.__navLog 同步镜像（自动化可 evaluate 读取）
 */

export interface NavDebugEntry {
  t: number;
  kind: string;
  detail: string;
}

export interface NavDebugSnapshot {
  seq: number;
  entries: NavDebugEntry[];
}

const MAX_ENTRIES = 80;
const ring: NavDebugEntry[] = [];
let seq = 0;
/** 缓存快照：useSyncExternalStore 的 getSnapshot 在无变化时必须返回同一引用——
 *  每次新建对象会被 React 判为「快照永远在变」→ 无限重渲染 → 整棵树卸载白屏 */
let snapshot: NavDebugSnapshot = { seq: 0, entries: [] };
const listeners = new Set<() => void>();

export function navDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem("rfm.debug-nav") === "1";
  } catch {
    return false;
  }
}

export function navDebugPush(kind: string, detail = ""): void {
  if (!navDebugEnabled()) return;
  const t = Date.now() % 1_000_000;
  ring.push({ t, kind, detail: detail.slice(0, 160) });
  if (ring.length > MAX_ENTRIES) ring.shift();
  seq += 1;
  snapshot = { seq, entries: [...ring] };
  try {
    const w = window as unknown as { __navLog?: string[] };
    if (!Array.isArray(w.__navLog)) w.__navLog = [];
    w.__navLog.push(`${t} ${kind} ${detail.slice(0, 160)}`);
    if (w.__navLog.length > MAX_ENTRIES) w.__navLog.shift();
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function navDebugSnapshot(): NavDebugSnapshot {
  return snapshot;
}

export function navDebugSubscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
