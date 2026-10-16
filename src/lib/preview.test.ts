import { describe, it, expect } from "vitest";
import { isPreviewable, isRemotePath, isTextLike, previewKindOf } from "./preview";
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
    for (const ext of ["txt", "md", "log", "ini", "conf"]) {
      expect(previewKindOf(entry({ name: `a.${ext}`, extension: ext }))).toBe("text");
    }
  });

  it("v0.30 代码类（json/yaml/toml/xml/sh/py…）同为纯文本 → text", () => {
    for (const ext of ["json", "yaml", "yml", "toml", "xml", "html", "css", "sh", "py", "rs", "ts", "sql"]) {
      expect(previewKindOf(entry({ name: `a.${ext}`, extension: ext }))).toBe("text");
    }
  });

  it("v0.30 补充的纯文本扩展名（ini 同族配置 / csv / 脚本 / 字幕 / 工程文件）→ text", () => {
    for (const ext of ["cfg", "properties", "reg", "csv", "tsv", "bat", "ps1", "srt", "lock", "patch", "csproj", "jsonc"]) {
      expect(previewKindOf(entry({ name: `a.${ext}`, extension: ext }))).toBe("text");
    }
  });

  it("v0.30 点文件 / 无扩展名约定文件按文件名匹配（后端对点文件给空扩展名）", () => {
    for (const name of [".gitignore", ".env", ".env.local", ".editorconfig", ".bashrc", "Makefile", "Dockerfile", "LICENSE", "README"]) {
      expect(previewKindOf(entry({ name, extension: "" }))).toBe("text");
    }
    // .env.production：后端扩展名为 production，仍按 .env 前缀命中
    expect(previewKindOf(entry({ name: ".env.production", extension: "production" }))).toBe("text");
    // 未知点文件 / 无扩展名文件不猜：仍 info（二进制点文件如 .DS_Store 不该进文本读取）
    expect(previewKindOf(entry({ name: ".DS_Store", extension: "" }))).toBe("info");
    expect(previewKindOf(entry({ name: "somebinary", extension: "" }))).toBe("info");
  });

  it("isTextLike 对目录为 false；图片/Office 不被文本判定抢走", () => {
    expect(isTextLike(entry({ is_dir: true, extension: "" }))).toBe(false);
    expect(isTextLike(entry({ name: "a.svg", extension: "svg" }))).toBe(false);
    expect(isTextLike(entry({ name: "a.xlsx", extension: "xlsx" }))).toBe(false);
    expect(previewKindOf(entry({ name: "a.svg", extension: "svg" }))).toBe("image");
    expect(previewKindOf(entry({ name: "a.xlsx", extension: "xlsx" }))).toBe("doc");
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
