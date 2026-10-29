/**
 * 弹层层级仲裁（v0.34.1）
 *
 * 背景：各弹层独立挂 window 级 Esc/Enter 监听，互不知晓——一次 Esc 会关掉多层，
 * 低 z-index 的确认框还可能在高层弹层（z-85 比对模态）后面「隐形」替用户按 Enter。
 * 本模块给弹层提供统一的打开顺序登记：只有栈顶弹层才响应 Esc/Enter。
 *
 * 用法：弹层挂载/打开时 `useModalLayer(id, z, active)`；按键处理前 `isTopModalLayer(id)`。
 * 同 z-index 时后打开者在上（与 CSS 同 z 后者覆盖的绘制规则一致）。
 *
 * z 档位与各弹层的 z-index class 保持一致（z-40 browse / z-50 settings·search /
 * z-60 deleteConfirm / z-65 conflict / z-70 appConfirm·quit / z-85 diff 系）。
 */

interface ModalLayer {
  id: string;
  z: number;
  /** 打开顺序（后打开者更大），用于同 z 的栈顶判定 */
  seq: number;
}

const stack: ModalLayer[] = [];
let seqCounter = 0;

/** 登记弹层打开（幂等：重复登记同一 id 会刷新其顺序） */
export function pushModalLayer(id: string, z: number): void {
  popModalLayer(id);
  stack.push({ id, z, seq: seqCounter++ });
}

/** 弹层关闭/卸载时移除登记 */
export function popModalLayer(id: string): void {
  const i = stack.findIndex((l) => l.id === id);
  if (i >= 0) stack.splice(i, 1);
}

/** 该弹层是否为栈顶：不存在 z 更高的弹层，也不存在同 z 但更晚打开的弹层
 *  （视觉层级由 z-index 决定，后打开只在同 z 时覆盖前者——与 CSS 绘制规则一致） */
export function isTopModalLayer(id: string): boolean {
  const self = stack.find((l) => l.id === id);
  if (!self) return false;
  return !stack.some(
    (l) => l.id !== id && (l.z > self.z || (l.z === self.z && l.seq > self.seq)),
  );
}

/** 仅测试用：清空登记 */
export function resetModalLayers(): void {
  stack.length = 0;
  seqCounter = 0;
}
