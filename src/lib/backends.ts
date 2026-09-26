/**
 * 后端能力抽象（v0.18 同步比对）：与 Rust 端 BackendKind/BackendCaps 同构。
 * 新后端（S3/网盘等）接入 = 这里加一个 kind 的能力条目与 PathScheme；
 * 后端 diff_dirs 仍做权威钳制，本表只驱动按钮显隐、层级预期与路径规则。
 */
import { isSftpPath, isHttpPath } from "./sftp-path";

export type BackendKind = "local" | "sftp" | "http" | "tags";

export interface BackendCaps {
  /** 参与比对的最大层级：1 名称 / 2 +大小 / 3 +hash（hash 仅本地可执行） */
  maxDiffLevel: 1 | 2 | 3;
  /** 是否支持创建目录（「在对侧新建并进入」按钮门控） */
  canMkdir: boolean;
}

export function backendKind(path: string): BackendKind {
  if (path.startsWith("tags://")) return "tags";
  if (isSftpPath(path)) return "sftp";
  if (isHttpPath(path)) return "http";
  return "local";
}

const CAPS: Record<BackendKind, BackendCaps> = {
  local: { maxDiffLevel: 3, canMkdir: true },
  sftp: { maxDiffLevel: 2, canMkdir: true },
  http: { maxDiffLevel: 1, canMkdir: false },
  tags: { maxDiffLevel: 1, canMkdir: false },
};

export function backendCaps(kind: BackendKind): BackendCaps {
  return CAPS[kind];
}

/** 两侧后端允许的最大比对层级（取较弱一侧） */
export function maxDiffLevelFor(pathA: string, pathB: string): 1 | 2 | 3 {
  const l = CAPS[backendKind(pathA)].maxDiffLevel;
  const r = CAPS[backendKind(pathB)].maxDiffLevel;
  return (l < r ? l : r) as 1 | 2 | 3;
}

// ---- PathScheme：相对路径规则按协议注册（relUnder/joinRoot 的驱动器） ----

export interface PathScheme {
  separator: "/" | "\\";
  caseSensitive: boolean;
  /** p 在 root 子树内时返回相对路径（原生分隔符），否则 null；等于 root 时返回 "" */
  under(p: string, root: string): string | null;
  join(root: string, rel: string): string;
}

const posixScheme: PathScheme = {
  separator: "/",
  caseSensitive: true,
  under(p, root) {
    if (p === root) return "";
    const prefix = root.endsWith("/") ? root : root + "/";
    return p.startsWith(prefix) ? p.slice(prefix.length) : null;
  },
  join(root, rel) {
    if (!rel) return root;
    return root.endsWith("/") ? root + rel : root + "/" + rel;
  },
};

/** Windows 本地：大小写不敏感、/ 与 \ 归一；返回的相对段保留原路径写法 */
const winScheme: PathScheme = {
  separator: "\\",
  caseSensitive: false,
  under(p, root) {
    const norm = (s: string) => s.replace(/\//g, "\\").toLowerCase();
    const np = norm(p);
    const nr = norm(root);
    if (np === nr) return "";
    const prefix = nr.endsWith("\\") ? nr : nr + "\\";
    if (!np.startsWith(prefix)) return null;
    // 归一化不改变长度，可从原路径尾部截出原写法的相对段
    return p.slice(p.length - (np.length - prefix.length));
  },
  join(root, rel) {
    if (!rel) return root;
    return /\\$/.test(root) ? root + rel : root + "\\" + rel;
  },
};

/**
 * 本地路径的分隔符按 root 形状探测（Windows 后端返回反斜杠路径，
 * mac/linux 与 e2e mock 为正斜杠），不依赖运行平台。
 */
export function pathScheme(root: string): PathScheme {
  if (backendKind(root) === "local" && root.includes("\\")) return winScheme;
  // sftp/http/tags 的路径部分恒为 "/"
  return posixScheme;
}
