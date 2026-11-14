/** 槽位插入推移（v0.49 特性5 雅·挤开）：拖拽单项目标槽位插入时,被越过的占用项
 *  沿行主序链整体推移一位——预览（拖拽悬停时的实时位移）与落位（slotDrop）共用
 *  本函数,保证「预览即终态」,松手零跳动。
 *
 *  语义（行主序索引 idx = r*cols + c）：
 *  - 目标在后方（idxTo > idxFrom）：idxFrom+1..idxTo 的占用项各前移一位,拖拽项落 idxTo；
 *  - 目标在前方（idxTo < idxFrom）：idxTo..idxFrom-1 的占用项各后移一位,拖拽项落 idxTo；
 *  - 同槽 → null（原位,无推移）。
 *  被拖项自身不参与推移（拖拽中它由拖影代表）；空槽照常参与链（推移项填入空洞,
 *  与资源管理器/iOS 图标插入的视觉预期一致）。 */
export interface ShiftSlot {
  c: number;
  r: number;
}

export function computeSlotShift(
  from: ShiftSlot,
  to: ShiftSlot,
  cols: number,
  /** name → 当前槽位 */
  slotsByName: ReadonlyMap<string, ShiftSlot>,
  /** 被拖项名集合（不参与推移） */
  draggedNames: ReadonlySet<string>,
): Map<string, ShiftSlot> | null {
  const idxFrom = from.r * cols + from.c;
  const idxTo = Math.max(0, to.r * cols + to.c);
  if (idxTo === idxFrom) return null;
  // 槽位 key ↔ 行主序索引
  const occupantAt = new Map<number, string>();
  for (const [name, s] of slotsByName) occupantAt.set(s.r * cols + s.c, name);
  const dir = idxTo > idxFrom ? -1 : 1; // 推移方向：目标在后方则前移,在前方则后移
  const result = new Map<string, ShiftSlot>();
  // 链上除起点（被拖项原槽）外的每个占用项沿方向移一位
  const start = idxTo > idxFrom ? idxFrom + 1 : idxTo;
  const end = idxTo > idxFrom ? idxTo : idxFrom - 1;
  for (let i = start; i <= end; i++) {
    const name = occupantAt.get(i);
    if (!name || draggedNames.has(name)) continue;
    const nextIdx = i + dir;
    result.set(name, {
      c: nextIdx % cols,
      r: Math.floor(nextIdx / cols),
    });
  }
  return result.size > 0 ? result : null;
}

/** 预览态等价判定（避免 mousemove 高频 setState 重渲染） */
export function shiftKey(shift: Map<string, ShiftSlot> | null): string {
  if (!shift) return "";
  return [...shift.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([n, s]) => `${n}@${s.c}:${s.r}`)
    .join("|");
}
