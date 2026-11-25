/**
 * v0.52 导航诊断环形缓冲（快速连钻卡死排查）：原始输入事件（按下/抬起/单击/
 * 双击/按键，含目标行路径与连击序号）+ 导航/加载触发流程 全留痕。
 * - DEBUG 版自动启用（import.meta.env.DEV），正式包可用 localStorage rfm.debug-nav=1 打开
 * - 环形 80 条，window.__navLog 同步镜像（自动化可 evaluate 读取）
 */

export interface NavDebugEntry {
  t: number;
  kind: string;
  detail: string;
}

const ring: NavDebugEntry[] = [];
let seq = 0;
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
  ring.push({ t, kind, detail: detail.slice(0, 140) });
  if (ring.length > 80) ring.shift();
  seq += 1;
  try {
    const w = window as unknown as { __navLog?: string[] };
    if (!Array.isArray(w.__navLog)) w.__navLog = [];
    w.__navLog.push(`${t} ${kind} ${ring[ring.length - 1].detail}`);
    if (w.__navLog.length > 80) w.__navLog.shift();
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export interface NavDebugSnapshot {
  seq: number;
  entries: NavDebugEntry[];
}

export function navDebugSnapshot(): NavDebugSnapshot {
  return { seq, entries: [...ring] };
}

export function navDebugSubscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
