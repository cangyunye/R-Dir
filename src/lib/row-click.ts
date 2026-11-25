/**
 * 行单击意图判定（v0.52：双击不再依赖浏览器 dblclick 事件）。
 *
 * 背景：桌面端 WKWebView 只在连击序号（MouseEvent.detail，即 NSEvent.clickCount）
 * 等于 2 时派发 dblclick。连续快速点击时序号一路递增 3/4/5…，之后的第 4、6… 次
 * 单击再也不触发 dblclick——「快速连钻卡在下一层，等一会儿才进」的根因（等的是
 * 系统双击间隔过去、序号复位成 1）。自动化工具每次都从序号 2 起算，所以 Playwright
 * 里永远复现不出来。现由单击事件自行判定，各内核下语义一致：
 *
 * - open   连击序号为偶数（同一连击序列的第 2/4/6… 次）；或序号已复位为 1、但距同
 *          一条目上一次无修饰单击 ≤450ms（系统双击间隔短于 450ms、或两次点击间鼠标
 *          位移超出系统双击范围时，系统会把一对快速点击判成两个新序列）
 * - rename 慢速双击（Finder 风格）：序号为 1 且距同一条目上次单击 450ms–3s
 * - select 其余（首次单击、连击序列里的奇数击、带修饰键的快速点击、合成事件）
 */

export type RowClickIntent = "open" | "rename" | "select";

/** 快速双击上限：距同一条目上次单击 ≤ 此值判为双击 */
export const FAST_DOUBLE_CLICK_MS = 450;
/** 慢速双击（重命名）上限 */
export const SLOW_DOUBLE_CLICK_MS = 3000;

/**
 * @param detail  连击序号（MouseEvent.detail）
 * @param gapMs   距同一条目上一次单击的毫秒数；无上次单击传 Infinity
 * @param plain   无修饰键（Shift / Meta / Ctrl / Alt 均未按下）
 */
export function rowClickIntent(detail: number, gapMs: number, plain: boolean): RowClickIntent {
  if (detail >= 2) return detail % 2 === 0 ? "open" : "select";
  if (detail !== 1) return "select";
  if (gapMs <= FAST_DOUBLE_CLICK_MS) return plain ? "open" : "select";
  return gapMs < SLOW_DOUBLE_CLICK_MS ? "rename" : "select";
}
