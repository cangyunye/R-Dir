/** 根 CSS zoom（界面字体缩放）：App 根内 fixed 浮层的 translate/left px 渲染时
 *  会被它放大——视口 CSS 像素写进这类浮层前须 ÷ 本值折回布局像素（v0.49 拖影
 *  跟手修复；未折算时偏移量随光标距窗口原点增大）。
 *  v0.50 feat/search-drag 从 App.tsx 提为公共工具：搜索拖拽的 body 级 portal 拖影
 *  （documentElement.zoom 对 body 子树同样生效）走同款折算。 */
export const rootZoomFactor = () =>
  parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
