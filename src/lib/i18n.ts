/**
 * i18n 核心：中文原文作 key 的极简翻译层（方案见仓库根 i18n-language-pack-plan.md）。
 * - t(key)：查当前语言包 strings，查不到回退 key 本身（即中文原文）——zh 无需语言包。
 * - t(key, params)：替换 {name} 占位符（如 "共 {n} 项"）。
 * - terr(msg)：错误串按 "CODE|中文详情" 格式识别，码查 errors 表，详情原样保留；
 *   无码（纯中文，过渡期）或 "CODE: 详情" 冒号格式（如 NEED_MASTER_KEY，前端按前缀
 *   拦截弹主密码框）原样透传。
 * 语言状态在 React 层（LanguageProvider）持有；非 React 调用方走 setPack 注入的
 * 模块级默认包。
 */

export type Language = "zh" | "en";

/** 语言包（@rdir/l10n/packs/*.json 的形状，见 R-Dir-L10n/schema/pack.schema.json） */
export type Pack = {
  meta: { id: string; name?: string; version?: string; minAppVersion?: string };
  strings: Record<string, string>;
  errors: Record<string, string>;
};

export const LANG_STORAGE_KEY = "rfm.language";

let current: Pack | null = null; // null = 中文（key 即原文）

/** 注入模块级当前包；React 树外的 t/terr 调用走这里 */
export function setPack(pack: Pack | null) {
  current = pack;
}

export function getPack(): Pack | null {
  return current;
}

export function t(
  key: string,
  params?: Record<string, string | number>,
  pack: Pack | null = current,
): string {
  let s = pack?.strings[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // split/join 等效 replaceAll（tsconfig target ES2020 无 String.replaceAll）
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** "CODE|详情" / 纯 "CODE" 识别（"CODE: 详情" 冒号格式不匹配，透传） */
const CODE_RE = /^[A-Z][A-Z0-9_]*(\||$)/;

export function terr(msg: string, pack: Pack | null = current): string {
  if (!CODE_RE.test(msg)) return msg;
  const [code, ...rest] = msg.split("|");
  const translated = pack?.errors[code];
  if (translated) {
    return rest.length > 0 ? `${translated}：${rest.join("|")}` : translated;
  }
  // 无包（zh）或未知码：有详情时剥掉码前缀只留详情（zh 显示与码化前逐字一致），纯码原样透传
  return rest.length > 0 ? rest.join("|") : msg;
}

/** 取消错误码（Rust 各取消路径统一产出；前端据此把取消与真错误区分开） */
export const ERR_CANCELLED = "CANCELLED";

/** 判定错误串是否为取消（码或码|详情）——替代旧的 msg.includes("取消") 中文匹配 */
export function isCancelledError(msg: string): boolean {
  return msg === ERR_CANCELLED || msg.startsWith(`${ERR_CANCELLED}|`);
}

/** 读取持久化语言（rfm.language），缺省/非法值回退 zh */
export function loadLanguage(): Language {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    /* localStorage 不可用（隐私模式等），用默认中文 */
  }
  return "zh";
}

/** 预留：未来"运行时下载语言包"在此异步加载注入；当前语言包均为构建期内置 */
export async function loadPack(_id: string): Promise<Pack | null> {
  return null;
}
