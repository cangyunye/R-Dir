/**
 * v0.52 批量改名纯逻辑：规则应用 / 目标平台命名校验 / 目录特征匹配。
 * 无 React 依赖，全部纯函数（vitest 覆盖见 batch-rename.test.ts）。
 *
 * 平台语义（校验按「目标盘」而非运行宿主）：
 * - windows：禁 <>:"/\|?* 与控制字符、结尾点/空格、保留设备名（CON/PRN/AUX/NUL/
 *   COM1-9/LPT1-9，主名忽略大小写）、≤255；批内与磁盘冲突均大小写不敏感
 * - macos：禁 "/" 与空名；冲突大小写不敏感（APFS/HFS+ 默认不敏感）
 * - linux（SFTP/NFS 远端恒为 linux）：仅禁 "/" 与空名；冲突区分大小写
 */
import { isMac } from "@/lib/keymap";
import { t } from "@/lib/i18n";
import { isNfsPath, isSftpPath } from "@/lib/sftp-path";
import type { FileEntry } from "@/lib/types";

// ───────────────── 平台判定 ─────────────────

/** 运行宿主是否 Windows（与 keymap.isMac 同源写法：UA/platform） */
export const isWindowsHost: boolean =
  typeof navigator !== "undefined" &&
  (/windows/i.test(navigator.userAgent) || /^win/i.test(navigator.platform || ""));

export type NamePlatform = "windows" | "macos" | "linux";

/** 改名目标所在盘的平台：SFTP/NFS 远端恒为 linux，本地按宿主 OS */
export function targetPlatformFor(path: string): NamePlatform {
  if (isSftpPath(path) || isNfsPath(path)) return "linux";
  if (isWindowsHost) return "windows";
  return isMac ? "macos" : "linux";
}

/** 该平台上同名比较是否忽略大小写 */
export function caseInsensitive(platform: NamePlatform): boolean {
  return platform !== "linux";
}

// ───────────────── 主名/扩展名分离（与 hideExtension 同源语义） ─────────────────

export function splitStemExt(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: "" };
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return { stem: name, ext: "" }; // dotfile（.bashrc）整名为主名
  return { stem: name.slice(0, idx), ext: name.slice(idx + 1) };
}

// ───────────────── 规则应用 ─────────────────

export interface RenameRules {
  /** 查找文本（字面量，全量替换） */
  find: string;
  replace: string;
  prefix: string;
  suffix: string;
  /** 连续编号（追加在后缀后、扩展名前） */
  numbering: boolean;
  numberStart: number;
  /** 最少位数（1-6，不足补零） */
  numberMinDigits: number;
  /** 保留原文件主名：关闭时丢弃 stem，结果 = 前缀+序号+扩展名 */
  keepStem: boolean;
}

export const DEFAULT_RULES: RenameRules = {
  find: "",
  replace: "",
  prefix: "",
  suffix: "",
  numbering: false,
  numberStart: 1,
  numberMinDigits: 3,
  keepStem: true,
};

export interface RenamePair {
  entry: FileEntry;
  newName: string;
}

function padNum(n: number, minDigits: number): string {
  const digits = Math.min(6, Math.max(1, Math.trunc(minDigits) || 1));
  return String(n).padStart(digits, "0");
}

/** 规则管线：stem 过查找替换 → 前缀+stem+后缀 → 编号 → .扩展名 */
export function applyRules(entries: FileEntry[], rules: RenameRules): RenamePair[] {
  let seq = Math.max(0, Math.trunc(rules.numberStart) || 0);
  return entries.map((entry) => {
    const { stem, ext } = splitStemExt(entry.name, entry.is_dir);
    let base = rules.keepStem ? stem : "";
    if (rules.find) base = base.split(rules.find).join(rules.replace);
    let name = rules.prefix + base + rules.suffix;
    if (rules.numbering) name += padNum(seq, rules.numberMinDigits);
    seq += 1;
    return { entry, newName: ext ? `${name}.${ext}` : name };
  });
}

// ───────────────── 目标校验 ─────────────────

export type RowStatus = "unchanged" | "ready" | "conflict" | "invalid";

export interface RenameRow extends RenamePair {
  status: RowStatus;
  /** conflict/invalid 时的人类可读原因（已本地化的键由调用方翻译） */
  reason: string;
}

const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const CONTROL_CHARS = /[\u0000-\u001f]/;
/** 保留设备名（主名，忽略大小写）：CON/PRN/AUX/NUL/COM1-9/LPT1-9（对齐 remote_temp.rs） */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

function windowsInvalidReason(name: string): string | null {
  if (name.length === 0) return t("名称为空");
  if (name === "." || name === "..") return t("非法名称");
  if (WINDOWS_FORBIDDEN.test(name)) return t("包含 Windows 非法字符 <>:\"/\\|?*");
  if (CONTROL_CHARS.test(name)) return t("包含控制字符");
  if (/[/\\]/.test(name)) return t("名称不能包含路径分隔符");
  if (/[. ]$/.test(name)) return t("Windows 名称不能以点或空格结尾");
  const stem = name.split(".")[0];
  if (WINDOWS_RESERVED.test(stem)) return t("Windows 保留设备名");
  if (name.length > 255) return t("超过 255 字符");
  return null;
}

function posixInvalidReason(name: string): string | null {
  if (name.length === 0) return t("名称为空");
  if (name === "." || name === "..") return t("非法名称");
  if (name.includes("/")) return "名称不能包含 /";
  if (name.length > 255) return t("超过 255 字符");
  return null;
}

/**
 * 校验并标注每行状态。diskNames = 目标目录当前盘上已有完整名单（本批改走的旧名
 * 由本函数内部剔除让位；调用方传全量即可）。
 * 状态优先级：invalid > unchanged（自身旧名恒不冲突）> conflict > ready。
 */
export function validateRows(
  rows: RenamePair[],
  platform: NamePlatform,
  diskNames: ReadonlySet<string>,
): RenameRow[] {
  const fold = caseInsensitive(platform);
  const key = (n: string) => (fold ? n.toLowerCase() : n);
  const invalidReason = platform === "windows" ? windowsInvalidReason : posixInvalidReason;

  // 批内冲突：同名（按平台大小写规则）出现 ≥2 次则全部标冲突
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r.newName);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // 旧行让位：本批真正改走的旧名从磁盘名单中剔除（保持不变的旧名仍占用）
  const vacated = new Set(rows.filter((r) => r.newName !== r.entry.name).map((r) => key(r.entry.name)));
  const disk = new Set([...diskNames].filter((n) => !vacated.has(key(n))));

  return rows.map((r) => {
    const bad = invalidReason(r.newName);
    if (bad) return { ...r, status: "invalid" as const, reason: bad };
    if (r.newName === r.entry.name) return { ...r, status: "unchanged" as const, reason: "" };
    const k = key(r.newName);
    if ((counts.get(k) ?? 0) > 1) return { ...r, status: "conflict" as const, reason: t("批内重名") };
    if (disk.has(k)) return { ...r, status: "conflict" as const, reason: t("目标已存在") };
    return { ...r, status: "ready" as const, reason: "" };
  });
}

/** 统计：参与 N / 将改名 M / 冲突 C（invalid 计入冲突口径，参考 RenameLite 三数字） */
export function summarize(rows: RenameRow[]): { total: number; ready: number; conflict: number } {
  let ready = 0;
  let conflict = 0;
  for (const r of rows) {
    if (r.status === "ready") ready += 1;
    else if (r.status === "conflict" || r.status === "invalid") conflict += 1;
  }
  return { total: rows.length, ready, conflict };
}

// ───────────────── 目录特征匹配 ─────────────────

export type MatchMode = "glob" | "regex" | "substr";

export interface MatchOptions {
  mode: MatchMode;
  pattern: string;
  includeHidden: boolean;
}

/** 通配符转整名匹配正则：* → .*、? → .，其余转义（自 SearchPanel 提取共享） */
export function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  let src = "";
  for (const ch of glob) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  return new RegExp(`^${src}$`, caseSensitive ? "" : "i");
}

/** 按特征圈定目录内条目（当前层，含目录本身；pattern 空 = 全部） */
export function matchEntries(entries: FileEntry[], opts: MatchOptions): FileEntry[] {
  const p = opts.pattern.trim();
  return entries.filter((e) => {
    if (!opts.includeHidden && e.name.startsWith(".")) return false;
    if (!p) return true;
    if (opts.mode === "substr") {
      return e.name.toLowerCase().includes(p.toLowerCase());
    }
    if (opts.mode === "glob") {
      try {
        return globToRegExp(p, false).test(e.name);
      } catch {
        return e.name.includes(p);
      }
    }
    try {
      return new RegExp(p, "i").test(e.name);
    } catch {
      return e.name.includes(p);
    }
  });
}
