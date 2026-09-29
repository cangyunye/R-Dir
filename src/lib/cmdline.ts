/**
 * 地址栏输入的命令判定（v0.22.0）：
 * 地址栏是「路径优先、命令兜底」——输入先按路径解析，不是路径且首 token
 * 是裸词（无分隔符）时才按命令处理。此模块只做纯判定，不发起后端调用。
 */

const SCHEME_RE = /^(sftp|https?|tags):\/\//i;

/** 输入串带远程/虚拟 scheme 前缀（这类输入只走导航，不可能是命令） */
export function hasScheme(s: string): boolean {
  return SCHEME_RE.test(s.trim());
}

/**
 * 单裸词判定：无空白、无路径分隔符 / \、无盘符冒号、无 ~、非 scheme。
 * 只有这种输入才请求 PATH 命令补全（输参数后不再弹命令组）。
 */
export function isCommandToken(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false;
  if (hasScheme(t)) return false;
  return !/[\/\\:~]/.test(t);
}

/**
 * 输入可作为命令执行的判定：返回首 token（裸词），不可执行返回 null。
 * 首 token 含路径分隔符 / 盘符冒号、整串带 scheme 或以 ~ 开头 → null（交回路径流程）。
 */
export function firstCommandToken(s: string): string | null {
  const input = s.trim();
  if (!input || hasScheme(input) || input.startsWith("~")) return null;
  const cmd = input.split(/\s+/)[0] ?? "";
  if (!cmd || /[\/\\:]/.test(cmd)) return null;
  return cmd;
}
