/**
 * 版本号同步测试（v0.14 起）：
 * - 三个发布版本文件（package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml）
 *   必须彼此一致；
 * - 且都必须等于仓库里最新（最高）的 git tag（去 v 前缀）。
 * 防止只打 tag、不同步版本文件的旧问题再次发生。
 */
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

/**
 * semver 比较（数字段逐位比，平局时无预发布段 > 有预发布段——semver 规范：
 * 1.2.3 > 1.2.3-pre；预发布段之间按字典序）。不能用 `git tag --sort=-version:refname`：
 * git 的 version 排序不懂预发布语义，「0.51.0-pre」会排在「0.51.0」之后
 * （降序即首位），导致转正发布时「最新 tag」断言取到 -pre 而失败。
 */
function semverCompare(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core, pre] = v.replace(/^v/, "").split("-");
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // 无预发布段更高（1.2.3 > 1.2.3-pre）
  if (pb.pre === null) return -1;
  return pa.pre.localeCompare(pb.pre);
}

/** 仓库内最高 semver git tag（如 v0.14.0 → "0.14.0"）；无 tag 返回 null */
function latestVersionTag(): string | null {
  try {
    const out = execSync("git tag", {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((t) => /^v\d/.test(t))
      .map((t) => t.replace(/^v/, ""));
    if (out.length === 0) return null;
    return out.sort(semverCompare).at(-1) ?? null;
  } catch {
    return null;
  }
}

/** 三个发布版本文件的 version 字段 */
function readReleaseVersions(): { pkg: string; conf: string; cargo: string } {
  const pkg: string = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
  const conf: string = JSON.parse(
    readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  const cargoToml = readFileSync(resolve(ROOT, "src-tauri/Cargo.toml"), "utf8");
  const m = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  return { pkg, conf, cargo: m ? m[1] : "" };
}

describe("版本号同步（v0.14）", () => {
  it("三个版本文件彼此一致", () => {
    const v = readReleaseVersions();
    expect(v.pkg).toBe(v.conf);
    expect(v.conf).toBe(v.cargo);
  });

  it("与最新 git tag 一致（先创建对应 tag 才能通过）", () => {
    const tag = latestVersionTag();
    expect(tag, "仓库缺少 git tag：先 git tag v<版本> 再发布").not.toBeNull();
    const v = readReleaseVersions();
    expect(v.pkg).toBe(tag);
    expect(v.conf).toBe(tag);
    expect(v.cargo).toBe(tag);
  });
});