import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 标签色实色块上的文字色：黄色等高亮度色 → 深暖字压住底色，其余白字 */
export function fgOnTagColor(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#ffffff";
  const v = parseInt(m[1], 16);
  const lum =
    (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  return lum > 0.62 ? "oklch(0.3 0.06 95)" : "#ffffff";
}
