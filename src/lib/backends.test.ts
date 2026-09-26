import { describe, expect, it } from "vitest";
import { backendKind, backendCaps, maxDiffLevelFor, pathScheme } from "./backends";

describe("backendKind", () => {
  it("按前缀分类", () => {
    expect(backendKind("F:\\data")).toBe("local");
    expect(backendKind("/home/u")).toBe("local");
    expect(backendKind("sftp://u@h:22/remote")).toBe("sftp");
    expect(backendKind("http://x/")).toBe("http");
    expect(backendKind("https://x/")).toBe("http");
    expect(backendKind("tags://work")).toBe("tags");
  });
});

describe("backendCaps", () => {
  it("能力表与后端约定一致", () => {
    expect(backendCaps("local")).toEqual({ maxDiffLevel: 3, canMkdir: true });
    expect(backendCaps("sftp")).toEqual({ maxDiffLevel: 2, canMkdir: true });
    expect(backendCaps("http")).toEqual({ maxDiffLevel: 1, canMkdir: false });
    expect(backendCaps("tags").canMkdir).toBe(false);
  });

  it("两侧取较弱后端的层级上限", () => {
    expect(maxDiffLevelFor("C:\\a", "D:\\b")).toBe(3);
    expect(maxDiffLevelFor("C:\\a", "sftp://u@h:22/r")).toBe(2);
    expect(maxDiffLevelFor("sftp://u@h:22/r", "sftp://u@h:22/r")).toBe(2);
  });
});

describe("pathScheme.under", () => {
  it("posix：sftp 与 posix 本地", () => {
    const s = pathScheme("sftp://u@h:22/remote");
    expect(s.under("sftp://u@h:22/remote", "sftp://u@h:22/remote")).toBe("");
    expect(s.under("sftp://u@h:22/remote/a/b", "sftp://u@h:22/remote")).toBe("a/b");
    expect(s.under("sftp://u@h:22/other", "sftp://u@h:22/remote")).toBeNull();
    // 无尾随路径的 sftp 根（家目录/根目录形态）
    expect(s.under("sftp://u@h:22", "sftp://u@h:22")).toBe("");
    expect(s.under("sftp://u@h:22/logs", "sftp://u@h:22")).toBe("logs");
    expect(pathScheme("/mock/home").under("/mock/home/x", "/mock/home")).toBe("x");
    expect(pathScheme("/mock/home").under("/mock/home2", "/mock/home")).toBeNull();
  });

  it("windows：大小写不敏感且容忍 / 与 \\ 混用", () => {
    const s = pathScheme("F:\\Data");
    expect(s.separator).toBe("\\");
    expect(s.caseSensitive).toBe(false);
    expect(s.under("F:\\Data\\sub\\file.txt", "F:\\Data")).toBe("sub\\file.txt");
    expect(s.under("f:/data/sub", "F:\\DATA")).toBe("sub");
    expect(s.under("F:\\Other", "F:\\Data")).toBeNull();
    expect(s.under("F:\\Data", "F:\\Data")).toBe("");
    // 前缀不能是兄弟目录（Data2 不是 Data 的子路径）
    expect(s.under("F:\\Data2", "F:\\Data")).toBeNull();
  });

  it("join 转换回协议分隔符", () => {
    expect(pathScheme("F:\\Data").join("F:\\Data", "a\\b")).toBe("F:\\Data\\a\\b");
    expect(pathScheme("/h").join("/h", "a/b")).toBe("/h/a/b");
    expect(pathScheme("sftp://u@h:22").join("sftp://u@h:22", "a/b")).toBe("sftp://u@h:22/a/b");
    expect(pathScheme("/h").join("/h", "")).toBe("/h");
  });
});
