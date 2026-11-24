import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@/lib/ipc";
import { isElegant } from "@/lib/anim";
import { isMac } from "@/lib/keymap";

/**
 * 最大化/向下还原的平台分发（WindowControls 按钮 + TabBar 双击标题栏共用）：
 *
 * macOS 无边框窗口（decorations:false，无 Titled styleMask）的 toggleMaximize
 * 在 tao 里走 `setFrame:display:animate:` 且 animate=YES——AppKit 自带动画
 * ~0.4s（「太慢」），animate=NO 又生硬。改走 Rust 侧 window_toggle_maximize：
 * - 素：animate=false 瞬时一步到位；
 * - 雅：animate=true 150ms easeOutCubic 步进动画（随素/雅开关）。
 *
 * Windows/Linux 原生 maximize 本就瞬时（SetWindowPlacement），保持 Tauri API。
 */
export function toggleWindowMaximize(): void {
  if (isMac) void invoke("window_toggle_maximize", { animate: isElegant() }).catch(() => {});
  else void getCurrentWindow().toggleMaximize().catch(() => {});
}
