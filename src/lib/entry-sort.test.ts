import { describe, it, expect } from "vitest";
import { sortEntries } from "./entry-sort";
import type { FileEntry } from "./types";

function e(name: string, opts: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/x/${name}`,
    is_dir: false,
    is_symlink: false,
    size: 100,
    modified: 1_700_000_000_000,
    created: null,
    permissions: "",
    extension: "",
    ...opts,
  };
}

const D1 = e("D1", { is_dir: true, modified: 1_700_000_100_000, size: 4096 });
const D2 = e("D2", { is_dir: true, modified: 1_700_000_300_000, size: 4096 });
const F1 = e("a.txt", { modified: 1_700_000_400_000, size: 3 });
const F2 = e("b.log", { modified: 1_700_000_200_000, size: 1 });
const F3 = e("c.md", { modified: 1_700_000_050_000, size: 2 });

describe("sortEntries 名称/类型排序:目录恒在前", () => {
  it("名称升序:目录在前、组内按名、文件组按名", () => {
    const out = sortEntries([F1, D1, F2, D2], "name", "asc", true);
    expect(out.map((x) => x.name)).toEqual(["D1", "D2", "a.txt", "b.log"]);
  });

  it("名称降序:目录仍在前(仅组内反转)", () => {
    const out = sortEntries([F1, D1, F2, D2], "name", "desc", true);
    expect(out.map((x) => x.name)).toEqual(["D2", "D1", "b.log", "a.txt"]);
  });

  it("类型排序目录恒在前", () => {
    const out = sortEntries([F1, D1, D2], "type", "asc", true);
    expect(out.slice(0, 2).map((x) => x.is_dir)).toEqual([true, true]);
  });
});

describe("sortEntries 修改时间排序:目录按键值混排", () => {
  it("降序:最新在前,目录与文件混排(不再恒占顶部)", () => {
    const out = sortEntries([D2, F3, D1, F1, F2], "modified", "desc", true);
    expect(out.map((x) => x.name)).toEqual(["a.txt", "D2", "b.log", "D1", "c.md"]);
  });

  it("升序:最旧在前,目录同样混排", () => {
    const out = sortEntries([D2, F3, D1, F1, F2], "modified", "asc", true);
    expect(out.map((x) => x.name)).toEqual(["c.md", "D1", "b.log", "D2", "a.txt"]);
  });

  it("modified 为 null 视为最旧(?? 0),降序时沉底", () => {
    const n = e("null-mtime", { modified: null });
    const out = sortEntries([n, F1], "modified", "desc", true);
    expect(out.map((x) => x.name)).toEqual(["a.txt", "null-mtime"]);
  });
});

describe("sortEntries 大小排序:目录按键值混排", () => {
  it("降序:大在前,目录(4096)排在 3 字节文件之后", () => {
    const out = sortEntries([F1, D1, F2], "size", "desc", true);
    expect(out.map((x) => x.name)).toEqual(["D1", "a.txt", "b.log"]);
  });
});

describe("sortEntries 隐藏文件过滤", () => {
  it("showHidden=false 时过滤点文件", () => {
    const dot = e(".hidden", { is_dir: true });
    const out = sortEntries([dot, F1], "name", "asc", false);
    expect(out.map((x) => x.name)).toEqual(["a.txt"]);
    expect(sortEntries([dot, F1], "name", "asc", true).length).toBe(2);
  });
});
