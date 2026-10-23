/**
 * 文件拖拽的落点解析（App 的 window 级 dragover / drop / dragend 共用）。
 *
 * 目标分两级：
 * - **文件夹**：命中带 `data-drop-dir` 的条目（详情列表的目录行 / 图标网格的文件夹图标），
 *   投放 = 移入 / 复制进该目录，同窗格与跨窗格都成立。被拖的路径自身不能作为目标
 *   （把文件夹拖到自己身上 = 无文件夹目标，回落到窗格级）。
 * - **窗格**：命中 FileList / IconGrid 根（`data-pane-id`）或 PaneView 根
 *   （`data-pane-swap-root`，窗格头区域），投放 = 进目标窗格当前目录；同窗格由调用方忽略。
 */
export interface DropTarget {
  paneId: number;
  /** 命中文件夹条目时的目录路径；否则 null（窗格级目标） */
  dirPath: string | null;
}

export function resolveDropTarget(
  el: Element | null,
  excludePaths: readonly string[],
): DropTarget | null {
  if (!el) return null;
  const paneEl = el.closest("[data-pane-id],[data-pane-swap-root]") as HTMLElement | null;
  if (!paneEl) return null;
  const paneId = Number(paneEl.dataset.paneId ?? paneEl.dataset.paneSwapRoot);
  if (Number.isNaN(paneId)) return null;
  const dirEl = el.closest("[data-drop-dir][data-path]") as HTMLElement | null;
  const dirPath = dirEl?.dataset.path ?? null;
  return { paneId, dirPath: dirPath && !excludePaths.includes(dirPath) ? dirPath : null };
}

export const dropTargetAt = (x: number, y: number, excludePaths: readonly string[]) =>
  resolveDropTarget(document.elementFromPoint(x, y), excludePaths);
