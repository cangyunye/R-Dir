/**
 * 行单击意图判定（v0.52：双击不再依赖浏览器 dblclick 事件）。
 *
 * 背景：桌面端 WKWebView 只在连击序号（MouseEvent.detail，即 NSEvent.clickCount）
 * 等于 2 时派发 dblclick。连续快速点击时序号一路递增 3/4/5…，之后的第 4、6… 次
 * 单击再也不触发 dblclick——「快速连钻卡在下一层，等一会儿才进」的根因（等的是
 * 系统双击间隔过去、序号复位成 1）。自动化工具每个动作都从序号 1 重新计数，所以
 * Playwright 里永远复现不出来。
 *
 * 与原行为的唯一差别：双击改由连击序号判定，不再监听 dblclick 事件。
 * - open   连击序号为偶数（同一连击序列的第 2/4/6… 次）——原先是浏览器在偶数击时
 *          补发 dblclick，桌面端过了 2 之后不再补发
 * - rename 慢速双击（Finder 风格）：序号为 1 且距同一条目上次单击 450ms–3s（原行为不变）
 * - select 其余（首次单击、连击序列里的奇数击、序号 1 且间隔 ≤450ms、合成事件）
 */

export type RowClickIntent = "open" | "rename" | "select";

/** 快速双击上限：距同一条目上次单击 ≤ 此值既不打开也不重命名 */
export const FAST_DOUBLE_CLICK_MS = 450;
/** 慢速双击（重命名）上限 */
export const SLOW_DOUBLE_CLICK_MS = 3000;

/**
 * @param detail  连击序号（MouseEvent.detail）
 * @param gapMs   距同一条目上一次单击的毫秒数；无上次单击传 Infinity
 */
export function rowClickIntent(detail: number, gapMs: number): RowClickIntent {
  if (detail >= 2) return detail % 2 === 0 ? "open" : "select";
  if (detail !== 1) return "select";
  return gapMs > FAST_DOUBLE_CLICK_MS && gapMs < SLOW_DOUBLE_CLICK_MS ? "rename" : "select";
}
