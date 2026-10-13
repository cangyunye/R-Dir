import { describe, it, expect } from "vitest";
import { isPreviewable, isRemotePath, previewKindOf } from "./preview";
import type { FileEntry } from "./types";

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: "a.png",
    path: "/mock/home/a.png",
    is_dir: false,
    is_symlink: false,
    size: 100,
    modified: 1700000000000,
    created: 1700000000000,
    permissions: "-rw-r--r--",
    extension: "png",
    ...over,
  };
}

describe("previewKindOf", () => {
  it("图片 → image", () => {
    expect(previewKindOf(entry())).toBe("image");
    expect(previewKindOf(entry({ name: "a.jpg", extension: "jpg" }))).toBe("image");
    expect(previewKindOf(entry({ name: "a.svg", extension: "svg" }))).toBe("image");
  });

  it("文本类 → text", () => {
    for (const ext of ["txt", "md", "log", "ini", "conf", "env", "gitignore"]) {
      expect(previewKindOf(entry({ name: `a.${ext}`, extension: ext }))).toBe("text");
    }
  });

  it("PDF/Office → doc", () => {
    expect(previewKindOf(entry({ name: "a.pdf", extension: "pdf" }))).toBe("doc");
    expect(previewKindOf(entry({ name: "a.docx", extension: "docx" }))).toBe("doc");
    expect(previewKindOf(entry({ name: "a.xlsx", extension: "xlsx" }))).toBe("doc");
    expect(previewKindOf(entry({ name: "a.pptx", extension: "pptx" }))).toBe("doc");
  });

  it("目录 → info（不预览内容）", () => {
    expect(previewKindOf(entry({ is_dir: true, extension: "" }))).toBe("info");
  });

  it("不支持的类型 → info", () => {
    expect(previewKindOf(entry({ name: "a.zip", extension: "zip" }))).toBe("info");
    expect(previewKindOf(entry({ name: "a.mp4", extension: "mp4" }))).toBe("info");
  });

  it("远程路径一律 info（本地暂只）", () => {
    expect(previewKindOf(entry({ path: "sftp://u@h:22/a.png" }))).toBe("info");
    expect(previewKindOf(entry({ path: "http://x/a.png" }))).toBe("info");
    expect(previewKindOf(entry({ path: "tags://red/a.png" }))).toBe("info");
  });
});

describe("isPreviewable / isRemotePath", () => {
  it("isPreviewable 排除 info 类", () => {
    expect(isPreviewable(entry())).toBe(true);
    expect(isPreviewable(entry({ name: "a.zip", extension: "zip" }))).toBe(false);
    expect(isPreviewable(entry({ is_dir: true, extension: "" }))).toBe(false);
  });

  it("isRemotePath 识别 sftp/http/tags", () => {
    expect(isRemotePath("sftp://u@h:22/a")).toBe(true);
    expect(isRemotePath("https://x/a")).toBe(true);
    expect(isRemotePath("tags://red")).toBe(true);
    expect(isRemotePath("/local/a.png")).toBe(false);
  });
});
