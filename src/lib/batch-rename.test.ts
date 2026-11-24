import { describe, expect, it } from "vitest";
import {
  applyRules,
  DEFAULT_RULES,
  globToRegExp,
  matchEntries,
  splitStemExt,
  summarize,
  targetPlatformFor,
  validateRows,
} from "./batch-rename";
import type { FileEntry } from "./types";

function entry(name: string, isDir = false): FileEntry {
  return {
    name,
    path: `/mock/home/${name}`,
    is_dir: isDir,
    is_symlink: false,
    size: 1,
    modified: null,
    created: null,
    permissions: "",
    extension: "",
  } as FileEntry;
}

describe("splitStemExt", () => {
  it("文件拆主名与扩展名", () => {
    expect(splitStemExt("a.txt", false)).toEqual({ stem: "a", ext: "txt" });
    expect(splitStemExt("a.b.c", false)).toEqual({ stem: "a.b", ext: "c" });
  });
  it("dotfile 与目录整名为主名", () => {
    expect(splitStemExt(".bashrc", false)).toEqual({ stem: ".bashrc", ext: "" });
    expect(splitStemExt("folder", true)).toEqual({ stem: "folder", ext: "" });
    expect(splitStemExt("folder.d", true)).toEqual({ stem: "folder.d", ext: "" });
  });
});

describe("applyRules", () => {
  it("查找替换作用于主名并保留扩展名", () => {
    const rows = applyRules([entry("说明_副本.txt")], { ...DEFAULT_RULES, find: "_副本", replace: "" });
    expect(rows[0].newName).toBe("说明.txt");
  });
  it("前后缀夹主名，编号追加在后缀后扩展名前", () => {
    const rows = applyRules([entry("a.txt"), entry("b.txt")], {
      ...DEFAULT_RULES,
      prefix: "p_",
      suffix: "_s",
      numbering: true,
      numberStart: 1,
      numberMinDigits: 3,
    });
    expect(rows[0].newName).toBe("p_a_s001.txt");
    expect(rows[1].newName).toBe("p_b_s002.txt");
  });
  it("关闭保留主名 = 前缀+序号+扩展名", () => {
    const rows = applyRules([entry("old.txt")], { ...DEFAULT_RULES, prefix: "img_", numbering: true, numberStart: 7, numberMinDigits: 2, keepStem: false });
    expect(rows[0].newName).toBe("img_07.txt");
  });
  it("目录整名为主名（无扩展名）", () => {
    const rows = applyRules([entry("docs", true)], { ...DEFAULT_RULES, find: "docs", replace: "文档" });
    expect(rows[0].newName).toBe("文档");
  });
});

describe("validateRows", () => {
  const disk = new Set(["keep.txt", "same.txt"]);

  it("unchanged / ready 基础态", () => {
    const rows = validateRows(
      [
        { entry: entry("keep.txt"), newName: "keep.txt" },
        { entry: entry("a.txt"), newName: "b.txt" },
      ],
      "linux",
      disk,
    );
    expect(rows[0].status).toBe("unchanged");
    expect(rows[1].status).toBe("ready");
  });

  it("windows：非法字符 / 结尾点 / 保留名 / 大小写冲突", () => {
    const rows = validateRows(
      [
        { entry: entry("a.txt"), newName: "bad<name>.txt" },
        { entry: entry("b.txt"), newName: "trail. " },
        { entry: entry("c.txt"), newName: "con.txt" },
        { entry: entry("d.txt"), newName: "Keep.txt" },
      ],
      "windows",
      disk,
    );
    expect(rows[0].status).toBe("invalid");
    expect(rows[1].status).toBe("invalid");
    expect(rows[2].status).toBe("invalid");
    // 大小写不敏感平台上与磁盘 keep.txt 冲突
    expect(rows[3].status).toBe("conflict");
  });

  it("linux：区分大小写，同一新名不算冲突", () => {
    const rows = validateRows([{ entry: entry("d.txt"), newName: "Keep.txt" }], "linux", disk);
    expect(rows[0].status).toBe("ready");
  });

  it("批内重名（大小写不敏感平台）双方都标冲突", () => {
    const rows = validateRows(
      [
        { entry: entry("a.txt"), newName: "x.txt" },
        { entry: entry("b.txt"), newName: "X.txt" },
      ],
      "windows",
      new Set(),
    );
    expect(rows[0].status).toBe("conflict");
    expect(rows[1].status).toBe("conflict");
  });

  it("旧行让位：本批改走的旧名不再构成磁盘冲突（链式腾名）", () => {
    // keep.txt→other.txt 腾出名字，same.txt→keep.txt 即不再冲突
    const rows = validateRows(
      [
        { entry: entry("keep.txt"), newName: "other.txt" },
        { entry: entry("same.txt"), newName: "keep.txt" },
      ],
      "linux",
      disk,
    );
    expect(rows[0].status).toBe("ready");
    expect(rows[1].status).toBe("ready");
    // 反例：没人腾名时改入 keep.txt 仍是冲突
    const solo = validateRows([{ entry: entry("same.txt"), newName: "keep.txt" }], "linux", disk);
    expect(solo[0].status).toBe("conflict");
  });

  it("summarize 三数字", () => {
    const rows = validateRows(
      [
        { entry: entry("a.txt"), newName: "a.txt" },
        { entry: entry("b.txt"), newName: "b2.txt" },
        { entry: entry("c.txt"), newName: "keep.txt" },
      ],
      "linux",
      disk,
    );
    expect(summarize(rows)).toEqual({ total: 3, ready: 1, conflict: 1 });
  });
});

describe("matchEntries", () => {
  const list = [entry("a.txt"), entry("b.md"), entry(".hidden"), entry("notes", true)];
  it("glob 整名匹配", () => {
    expect(matchEntries(list, { mode: "glob", pattern: "*.txt", includeHidden: false }).map((e) => e.name)).toEqual(["a.txt"]);
  });
  it("regex 与 substr，正则非法回落子串", () => {
    expect(matchEntries(list, { mode: "regex", pattern: "^a\\.", includeHidden: false }).map((e) => e.name)).toEqual(["a.txt"]);
    expect(matchEntries(list, { mode: "substr", pattern: "NOTE", includeHidden: false }).map((e) => e.name)).toEqual(["notes"]);
    // 非法正则回落字面子串："a.(" 不在任何名字里 → 空
    expect(matchEntries(list, { mode: "regex", pattern: "a.(", includeHidden: false }).length).toBe(0);
    expect(matchEntries(list, { mode: "regex", pattern: ".txt", includeHidden: false }).map((e) => e.name)).toEqual(["a.txt"]);
  });
  it("隐藏文件过滤与放行", () => {
    expect(matchEntries(list, { mode: "substr", pattern: "", includeHidden: false }).length).toBe(3);
    expect(matchEntries(list, { mode: "substr", pattern: "", includeHidden: true }).length).toBe(4);
  });
});

describe("globToRegExp", () => {
  it("等价于 SearchPanel 原实现", () => {
    expect(globToRegExp("*.txt", false).test("A.TXT")).toBe(true);
    expect(globToRegExp("a?c", true).test("abc")).toBe(true);
    expect(globToRegExp("a?c", true).test("abbc")).toBe(false);
  });
});

describe("targetPlatformFor", () => {
  it("sftp/nfs 恒为 linux，本地按宿主", () => {
    expect(targetPlatformFor("sftp://u@h:22/a")).toBe("linux");
    expect(targetPlatformFor("nfs://x")).toBe("linux");
    const p = targetPlatformFor("/tmp");
    expect(["windows", "macos", "linux"]).toContain(p);
  });
});
