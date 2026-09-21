/**
 * GitHub 仓库 / 更新检测（v0.12）。
 * 只依赖公开的 GitHub Releases API，无需签名密钥或后台服务：
 * 拉到最新 release 后与当前版本比对，有新版则引导用户前往下载页。
 */

export const REPO = "cangyunye/R-Dir";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface UpdateInfo {
  version: string;
  url: string;
}

/** 语义化版本比较：a>b 正数，a<b 负数，相等 0（忽略 v 前缀与 -pre/+build 后缀） */
export function compareVersions(a: string, b: string): number {
  const parse = (s: string) =>
    s
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((x) => parseInt(x, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 查询最新 release；有新版本返回信息，否则返回 null（含已是最新 / 无 tag） */
export async function fetchLatestRelease(current: string): Promise<UpdateInfo | null> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const rel = (await res.json()) as { tag_name?: string; html_url?: string };
  const latest = String(rel.tag_name ?? "").replace(/^v/i, "");
  if (!latest) return null;
  if (compareVersions(latest, current) <= 0) return null;
  return { version: latest, url: rel.html_url || RELEASES_URL };
}
