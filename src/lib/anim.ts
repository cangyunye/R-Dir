/** 动画级别（素/雅）的 JS 读取口：window 级监听器/命令式路径（拖拽引擎、
 *  位移动画等）拿不到 React 状态，经模块级镜像读取。
 *  App 挂载与设置变更时调 setAnimLevelRef 同步镜像。
 *
 *  CSS 侧由 [data-anim=elegant] + --rdir-anim-dur/--rdir-anim-ease 驱动
 *  （见 index.css「素/雅动画级别」段），两侧务必同源（App 同一个 state 写两边）。 */
import { loadAnimLevel, type AnimLevel } from "./persist";

let mirror: AnimLevel = loadAnimLevel();

export function setAnimLevelRef(v: AnimLevel): void {
  mirror = v;
}

/** 设置的级别（即生效级别）。**雅不受系统「减弱动态效果」影响**（v0.49.1 产品
 *  拍板）：Windows 关闭窗口动画/RDP 会话会向 WebView2 报告 prefers-reduced-motion:
 *  reduce，此前按无障碍惯例折算回素，导致这类机器上雅被静默压制成素、任何构建
 *  都无动效（用户实测）。关闭动效的唯一途径 = 素（设置面板「外观」区开关）。 */
export function getAnimLevelSetting(): AnimLevel {
  return mirror;
}

/** JS 路径使用的生效级别（与设置同值） */
export function getAnimLevel(): AnimLevel {
  return mirror;
}

/** 生效级别是否为雅（常用判定糖） */
export function isElegant(): boolean {
  return getAnimLevel() === "elegant";
}
