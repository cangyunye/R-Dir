/**
 * 主题调色盘（v0.39）：主题包的编辑态逻辑，纯函数、不碰 DOM。
 *
 * - 草稿 = 解析后的全量调色板（base 内置色 + 覆盖项），所见即所得，导出写全部 token
 * - 滑杆只编辑 oklch 的 L/C/H(/A)；hex / rgb 等合法 CSS 颜色先归一化成 oklch 再编辑，
 *   解析不了的值由界面退化为只读 + 原文输入
 * - 全局色相联动：识别调色板主导色相，整体旋转"主题色系" token 的色相；
 *   功能语义色（destructive / ok / folder）不跟随，避免红绿黄跑偏
 */

import { THEME_TOKEN_KEYS, resolvePalette, type ThemePack } from "./themePacks";

export type TokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeBase = ThemePack["base"];

export interface Oklch {
  /** 明度 0–1 */
  l: number;
  /** 彩度 0–CHROMA_MAX（sRGB 可达上限随色相浮动，0.4 已覆盖） */
  c: number;
  /** 色相 0–360 */
  h: number;
  /** 不透明度 0–1 */
  alpha: number;
}

export const CHROMA_MAX = 0.4;
export const THEME_SCHEMA = "rdir-theme/1";
export const THEME_NAME_MAX = 40;
export const THEME_ID_MAX = 64;

export interface TokenGroup {
  id: string;
  /** 分组名（界面层再过 t()） */
  label: string;
  keys: TokenKey[];
}

/** 23 个 token 的语义分组；顺序即界面顺序，必须恰好覆盖 THEME_TOKEN_KEYS（有单测兜底） */
export const TOKEN_GROUPS: TokenGroup[] = [
  { id: "surface", label: "表面 / 底色", keys: ["--background", "--card", "--popover", "--sidebar"] },
  {
    id: "text",
    label: "文字 / 前景",
    keys: [
      "--foreground",
      "--card-foreground",
      "--popover-foreground",
      "--primary-foreground",
      "--secondary-foreground",
      "--muted-foreground",
      "--accent-foreground",
    ],
  },
  { id: "primary", label: "主色 / 强调", keys: ["--primary", "--ring", "--accent"] },
  { id: "secondary", label: "次级 / 弱化", keys: ["--secondary", "--muted"] },
  { id: "state", label: "选中 / 状态", keys: ["--selected", "--destructive", "--ok", "--folder"] },
  { id: "border", label: "边框 / 输入", keys: ["--border", "--input"] },
  { id: "shadow", label: "阴影", keys: ["--shadow"] },
];

/** 功能语义色：不参与全局色相联动 */
export const FUNCTIONAL_KEYS: ReadonlySet<string> = new Set(["--destructive", "--ok", "--folder"]);

/** 默认就带透明度的 token：编辑器常驻 A 滑杆（其余 token 只在当前值含透明度时显示） */
export const ALPHA_KEYS: ReadonlySet<string> = new Set(["--border", "--input"]);

/** --shadow 不是颜色，用预设代替滑杆；label 在界面层过 t() */
export const SHADOW_PRESETS: { id: string; label: string; value: string }[] = [
  { id: "none", label: "无", value: "none" },
  { id: "light", label: "轻", value: "0 12px 32px rgba(15, 23, 42, 0.16)" },
  { id: "medium", label: "中", value: "0 16px 40px rgba(0, 0, 0, 0.35)" },
  { id: "heavy", label: "重", value: "0 16px 40px rgba(0, 0, 0, 0.55)" },
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mod360 = (h: number) => ((h % 360) + 360) % 360;

function num(s: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "0.5" → 0.5；"50%" → 0.5（相对 scale=1）；百分比按 scale 换算（彩度 100% = CHROMA_MAX） */
function numOrPercent(s: string, scale = 1): number | null {
  if (s.endsWith("%")) {
    const p = num(s.slice(0, -1));
    return p === null ? null : (p / 100) * scale;
  }
  return num(s);
}

function parseHue(s: string): number | null {
  if (s === "none") return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  switch ((m[2] ?? "deg").toLowerCase()) {
    case "rad":
      return (v * 180) / Math.PI;
    case "grad":
      return v * 0.9;
    case "turn":
      return v * 360;
    default:
      return v;
  }
}

/** 解析 oklch(L C H [/ A])；L/A 支持百分比，H 支持角度单位与 none；其余格式返回 null */
export function parseOklch(value: string): Oklch | null {
  const m = /^oklch\((.*)\)$/i.exec(value.trim());
  if (!m) return null;
  const segments = m[1].split("/");
  if (segments.length > 2) return null;
  const parts = segments[0].trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const l = numOrPercent(parts[0]);
  const c = numOrPercent(parts[1], CHROMA_MAX);
  const h = parseHue(parts[2]);
  if (l === null || c === null || h === null) return null;
  let alpha = 1;
  if (segments.length === 2) {
    const a = numOrPercent(segments[1].trim());
    if (a === null) return null;
    alpha = a;
  }
  return {
    l: clamp(l, 0, 1),
    c: clamp(c, 0, CHROMA_MAX),
    h: mod360(h),
    alpha: clamp(alpha, 0, 1),
  };
}

/** 去尾零的定点格式："0.500" → "0.5"、"275.0" → "275" */
const fixed = (n: number, digits: number) => Number(n.toFixed(digits)).toString();

/** 序列化为项目既有写法：oklch(0.185 0.035 275) / oklch(1 0 0 / 12%) */
export function formatOklch({ l, c, h, alpha }: Oklch): string {
  const body = `${fixed(clamp(l, 0, 1), 3)} ${fixed(clamp(c, 0, CHROMA_MAX), 3)} ${fixed(mod360(h), 1)}`;
  return alpha >= 1 ? `oklch(${body})` : `oklch(${body} / ${fixed(clamp(alpha, 0, 1) * 100, 0)}%)`;
}

const srgbToLinear = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);

/** sRGB（分量 0–1）→ OKLCH；Björn Ottosson 标准矩阵。消色差时色相取 0 */
export function rgbToOklch(r: number, g: number, b: number, alpha = 1): Oklch {
  const lr = srgbToLinear(clamp(r, 0, 1));
  const lg = srgbToLinear(clamp(g, 0, 1));
  const lb = srgbToLinear(clamp(b, 0, 1));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  const H = C < 1e-4 ? 0 : mod360((Math.atan2(bb, a) * 180) / Math.PI);
  return { l: clamp(L, 0, 1), c: clamp(C, 0, CHROMA_MAX), h: H, alpha: clamp(alpha, 0, 1) };
}

function parseHex(value: string): Oklch | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (!m) return null;
  let hex = m[1];
  if (hex.length <= 4) hex = [...hex].map((ch) => ch + ch).join("");
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return rgbToOklch(n(0), n(2), n(4), hex.length === 8 ? n(6) : 1);
}

/** rgb()/rgba()：逗号或空格语法，分量 0–255 或百分比，alpha 0–1 或百分比 */
function parseRgb(value: string): Oklch | null {
  const m = /^rgba?\((.*)\)$/i.exec(value);
  if (!m) return null;
  const [main, alphaPart, ...rest] = m[1].split("/");
  if (rest.length) return null;
  let parts = main.trim().split(/\s*,\s*|\s+/);
  let alphaStr: string | undefined = alphaPart?.trim();
  if (parts.length === 4 && alphaStr === undefined) {
    alphaStr = parts[3];
    parts = parts.slice(0, 3);
  }
  if (parts.length !== 3) return null;
  const ch = parts.map((p) => {
    if (p.endsWith("%")) return numOrPercent(p);
    const n = num(p);
    return n === null ? null : n / 255;
  });
  if (ch.some((v) => v === null)) return null;
  const alpha = alphaStr === undefined ? 1 : numOrPercent(alphaStr);
  if (alpha === null) return null;
  return rgbToOklch(ch[0]!, ch[1]!, ch[2]!, alpha);
}

/** 其它写法（命名色、hsl、color() …）交给浏览器解析成 rgb 再转；非 DOM 环境返回 null */
function resolveViaDom(value: string): Oklch | null {
  if (typeof document === "undefined" || !document.body) return null;
  const probe = document.createElement("span");
  probe.style.color = value;
  if (!probe.style.color) return null;
  document.body.appendChild(probe);
  try {
    const computed = getComputedStyle(probe).color;
    return parseRgb(computed) ?? parseOklch(computed);
  } finally {
    probe.remove();
  }
}

/** 任意 CSS 颜色 → OKLCH（oklch 原样解析，hex/rgb 数学换算，其余借浏览器） */
export function parseColor(value: string): Oklch | null {
  const v = value.trim();
  if (!v) return null;
  return parseOklch(v) ?? parseHex(v) ?? parseRgb(v) ?? resolveViaDom(v);
}

/** 与 Rust valid_id 一致：小写字母/数字开头，仅小写字母/数字/连字符，≤64 */
export function isValidThemeId(id: string): boolean {
  return id.length > 0 && id.length <= THEME_ID_MAX && /^[a-z0-9][a-z0-9-]*$/.test(id);
}

/** 把任意文本整理成合法 id（非法字符→连字符、折叠、去首尾连字符、截长）；空则回落 fallback */
export function suggestThemeId(raw: string, fallback = "custom-theme"): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, THEME_ID_MAX)
    .replace(/-+$/, "");
  return isValidThemeId(id) ? id : fallback;
}

/** 编辑起点：已安装主题包，或内置浅色 / 深色 */
export type DraftSource = ThemePack | ThemeBase;

/**
 * 由起点生成草稿：tokens 为解析后的全量调色板（缺省项已回落到 base 内置色）。
 * 起点为主题包时 id 后缀 -custom（避免直接覆盖原包），名称沿用；内置起点用 custom-<base>。
 */
export function createDraft(source: DraftSource, overrides: { id?: string; name?: string } = {}): ThemePack {
  if (typeof source === "string") {
    const palette = resolvePalette({ id: source, name: source, base: source, tokens: {} });
    return {
      schema: THEME_SCHEMA,
      id: overrides.id ?? `custom-${source}`,
      name: overrides.name ?? (source === "dark" ? "自定义深色" : "自定义浅色"),
      author: "",
      version: "1.0.0",
      base: source,
      tokens: { ...palette },
    };
  }
  const palette = resolvePalette(source);
  return {
    schema: THEME_SCHEMA,
    id: overrides.id ?? suggestThemeId(`${source.id}-custom`),
    name: (overrides.name ?? source.name).slice(0, THEME_NAME_MAX),
    author: source.author ?? "",
    version: source.version ?? "1.0.0",
    base: source.base,
    tokens: { ...palette },
  };
}

export function setDraftToken(draft: ThemePack, key: TokenKey, value: string): ThemePack {
  return { ...draft, tokens: { ...draft.tokens, [key]: value } };
}

/** 两份草稿是否相同（脏检查：切换起点 / 关闭前提示） */
export function isSameDraft(a: ThemePack, b: ThemePack): boolean {
  if (a.id !== b.id || a.name !== b.name || (a.author ?? "") !== (b.author ?? "") || a.base !== b.base) return false;
  return THEME_TOKEN_KEYS.every((k) => a.tokens[k] === b.tokens[k]);
}

/** 色相联动候选：非功能色、非阴影、可解析且带彩度（c > 0）；灰阶旋转色相无意义，跳过 */
function linkable(tokens: Record<string, string>, minChroma: number): { key: TokenKey; color: Oklch }[] {
  const out: { key: TokenKey; color: Oklch }[] = [];
  for (const key of THEME_TOKEN_KEYS) {
    if (key === "--shadow" || FUNCTIONAL_KEYS.has(key)) continue;
    const color = tokens[key] ? parseColor(tokens[key]) : null;
    if (color && color.c > minChroma) out.push({ key, color });
  }
  return out;
}

/** 环形均值（度） */
function circularMean(hues: number[]): number {
  let x = 0;
  let y = 0;
  for (const h of hues) {
    x += Math.cos((h * Math.PI) / 180);
    y += Math.sin((h * Math.PI) / 180);
  }
  return mod360((Math.atan2(y, x) * 180) / Math.PI);
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(mod360(a) - mod360(b));
  return Math.min(d, 360 - d);
};

/**
 * 主导色相：在彩度 ≥ 0.02 的主题色 token 中找 ±25° 内成员最多的簇，取簇的环形均值。
 * 全是灰阶（没有可联动 token）时返回 null，界面据此禁用联动滑杆。
 */
export function dominantHue(tokens: Record<string, string>): number | null {
  const hues = linkable(tokens, 0.02).map((t) => t.color.h);
  if (hues.length === 0) return null;
  let best: number[] = [];
  for (const center of hues) {
    const cluster = hues.filter((h) => hueDist(h, center) <= 25);
    if (cluster.length > best.length) best = cluster;
  }
  return Math.round(circularMean(best) * 10) / 10;
}

/** 整体旋转主题色系的色相（功能色与灰阶不动），保留各自 L/C/透明度 */
export function rotateHues(tokens: Record<string, string>, deltaDeg: number): Record<string, string> {
  if (!deltaDeg) return tokens;
  const next = { ...tokens };
  for (const { key, color } of linkable(tokens, 0)) {
    next[key] = formatOklch({ ...color, h: color.h + deltaDeg });
  }
  return next;
}

/** 导出为 .rdtheme.json 文本：全量 token、按白名单顺序；author 为空则省略 */
export function serializeThemePack(draft: ThemePack): string {
  return JSON.stringify(toPackJson(draft), null, 2) + "\n";
}

/** 与 Rust ThemePack 对齐的 JSON 对象（"$schema" 键名；给 invoke / 导出共用） */
export function toPackJson(draft: ThemePack): Record<string, unknown> {
  const tokens: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) {
    const v = draft.tokens[key];
    if (typeof v === "string" && v.trim()) tokens[key] = v.trim();
  }
  const out: Record<string, unknown> = {
    $schema: THEME_SCHEMA,
    id: draft.id,
    name: draft.name.trim(),
  };
  if (draft.author?.trim()) out.author = draft.author.trim();
  out.version = draft.version?.trim() || "1.0.0";
  out.base = draft.base;
  out.tokens = tokens;
  return out;
}

/** 草稿能否保存：id / 名称合法；返回错误文案 key（界面层过 t()），null = 合法 */
export function validateDraft(draft: ThemePack): string | null {
  if (!isValidThemeId(draft.id)) return "主题包 id 无效（小写字母/数字/连字符，≤64 字符）";
  const name = draft.name.trim();
  if (!name) return "主题包缺少名称";
  if ([...name].length > THEME_NAME_MAX) return "主题包名称超过 40 字";
  return null;
}
