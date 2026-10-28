/**
 * 详情列表「名称」列宽（v0.34）：全局共享状态（所有窗格一致，改动即时同步），
 * localStorage 持久化。0 = 自动（占满剩余空间，默认）；拖动表头分隔线后变为固定像素宽。
 * 用 useSyncExternalStore 订阅：多个窗格的 FileList 实例拖一处、处处生效。
 */
export const NAME_COL_MIN = 120;
export const NAME_COL_MAX = 1200;

const KEY = "rdir.nameColW";

let value = 0;
let loaded = false;
const listeners = new Set<() => void>();

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const n = Number(localStorage.getItem(KEY));
    if (Number.isFinite(n) && n >= NAME_COL_MIN) {
      value = Math.min(NAME_COL_MAX, Math.round(n));
    }
  } catch {
    // localStorage 不可用（隐私模式等）：仅内存态
  }
}

export function getNameColumnWidth(): number {
  ensureLoaded();
  return value;
}

/** 拖动时设置（夹在 MIN–MAX）；0 表示恢复自动宽度 */
export function setNameColumnWidth(w: number) {
  const next = Math.min(NAME_COL_MAX, Math.max(NAME_COL_MIN, Math.round(w)));
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // 同上：仅内存态
  }
  listeners.forEach((l) => l());
}

/** 双击分隔线恢复自动宽度 */
export function resetNameColumnWidth() {
  if (value === 0) return;
  value = 0;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 同上
  }
  listeners.forEach((l) => l());
}

export function subscribeNameColumnWidth(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
