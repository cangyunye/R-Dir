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

/** 设置的级别（不含系统偏好折算） */
export function getAnimLevelSetting(): AnimLevel {
  return mirror;
}

/** 系统「减弱动态效果」偏好——雅在其下折算回素（与 index.css reduced-motion
 *  覆盖、tag-hero-sweep 惯例一致）；jsdom 无 matchMedia 视作不减弱。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  } catch {
    return false;
  }
}

/** JS 路径使用的生效级别：雅 + 系统减弱动态 → 素 */
export function getAnimLevel(): AnimLevel {
  return mirror === "elegant" && prefersReducedMotion() ? "plain" : mirror;
}

/** 生效级别是否为雅（常用判定糖） */
export function isElegant(): boolean {
  return getAnimLevel() === "elegant";
}
