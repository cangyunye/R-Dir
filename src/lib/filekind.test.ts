import { describe, it, expect } from "vitest";
import { fileKindOf, isArchiveExt, THUMBNAIL_KINDS, FILE_KINDS } from "./filekind";

const mk = (is_dir: boolean, extension: string, is_symlink?: boolean) => ({
  is_dir,
  extension,
  is_symlink,
});

describe("fileKindOf（v0.27 文件类型分类）", () => {
  it("目录恒为 folder，不看扩展名", () => {
    expect(fileKindOf(mk(true, "zip"))).toBe("folder");
    expect(fileKindOf(mk(true, ""))).toBe("folder");
  });

  it("核心扩展名映射", () => {
    expect(fileKindOf(mk(false, "png"))).toBe("image");
    expect(fileKindOf(mk(false, "jpeg"))).toBe("image");
    expect(fileKindOf(mk(false, "mp4"))).toBe("video");
    expect(fileKindOf(mk(false, "flac"))).toBe("audio");
    expect(fileKindOf(mk(false, "7z"))).toBe("archive");
    expect(fileKindOf(mk(false, "rs"))).toBe("code");
    expect(fileKindOf(mk(false, "docx"))).toBe("doc");
    expect(fileKindOf(mk(false, "xlsx"))).toBe("sheet");
    expect(fileKindOf(mk(false, "pptx"))).toBe("slide");
    expect(fileKindOf(mk(false, "md"))).toBe("text");
  });

  it("v0.27 新增 pdf 与 app 分类", () => {
    expect(fileKindOf(mk(false, "pdf"))).toBe("pdf");
    for (const ext of ["exe", "msi", "dmg", "app", "deb", "appimage", "apk"]) {
      expect(fileKindOf(mk(false, ext))).toBe("app");
    }
  });

  it("未知扩展名落 file 兜底", () => {
    expect(fileKindOf(mk(false, "xyz"))).toBe("file");
    expect(fileKindOf(mk(false, ""))).toBe("file");
  });

  it("14 类完整且缩略图资格是子集", () => {
    expect(FILE_KINDS).toHaveLength(14); // v0.52 新增 link（符号链接锁链图标）
    for (const k of THUMBNAIL_KINDS) expect(FILE_KINDS).toContain(k);
  });

  it("v0.52 符号链接独立为 link 类型（类型列/图标以链接呈现，不论扩展名）", () => {
    expect(fileKindOf(mk(false, "txt", true))).toBe("link");
    expect(fileKindOf(mk(false, "", true))).toBe("link");
    expect(fileKindOf(mk(true, "", true))).toBe("folder"); // 目录优先于链接判定
    expect(fileKindOf(mk(false, "png"))).not.toBe("link");
  });

  it("v0.32 isArchiveExt：常见压缩包可解压，裸 xz 例外（后端暂不支持）", () => {
    for (const ext of ["zip", "rar", "7z", "tar", "gz", "bz2", "tgz", "tbz", "txz"]) {
      expect(isArchiveExt(ext)).toBe(true);
    }
    expect(isArchiveExt("ZIP")).toBe(true); // 大小写不敏感
    expect(isArchiveExt("xz")).toBe(false);
    expect(isArchiveExt("txt")).toBe(false);
    expect(isArchiveExt("")).toBe(false);
  });
});
