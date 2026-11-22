/** 根 CSS zoom（界面字体缩放）：App 根内 fixed 浮层的 translate/left px 渲染时
 *  会被它放大——视口 CSS 像素写进这类浮层前须 ÷ 本值折回布局像素（v0.49 拖影
 *  跟手修复；未折算时偏移量随光标距窗口原点增大）。
 *  v0.50 feat/search-drag 从 App.tsx 提为公共工具：搜索拖拽的 body 级 portal 拖影
 *  （documentElement.zoom 对 body 子树同样生效）走同款折算。 */
export const rootZoomFactor = () =>
  parseFloat(getComputedStyle(document.documentElement).zoom) || 1;


/** 子树有效缩放比（根 zoom × 窗格 zoom 等乘积）：往 el 里塞 1000px 探针子元素
 *  量 rect.width/1000——探针自身无 zoom，量到的正是该子树的放大倍数。
 *  jsdom 等无布局环境量到 0 → 回退 1（不折算，单测桩全走布局=视觉）。
 *  v0.50 评审归口：此前住在 hooks/useDragRubberBand.ts（纯 DOM 工具错放 hook
 *  文件），IconGrid.slotAt 等同族换算跨文件复用。调用方按手势/zoom·iconSize
 *  变更缓存结果，不要逐事件量测。 */
export function measureZoomRatio(el: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;width:1000px;height:0;visibility:hidden;pointer-events:none;";
  el.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  el.removeChild(probe);
  const ratio = w / 1000;
  return ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
}
