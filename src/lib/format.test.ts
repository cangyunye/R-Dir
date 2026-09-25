import { describe, it, expect } from "vitest";
import { formatSize, formatTime, basename, hideExtension } from "./format";

describe("formatSize（lsd 风格）", () => {
  it("0 字节", () => {
    expect(formatSize(0)).toBe("0B");
  });
  it("小于 1K 用 B", () => {
    expect(formatSize(500)).toBe("500B");
  });
  it("1.4K", () => {
    expect(formatSize(1400)).toBe("1.4K");
  });
  it("大于 100K 不显示小数", () => {
    expect(formatSize(150_000)).toBe("146K");
  });
  it("2.3M", () => {
    expect(formatSize(2_300_000)).toBe("2.2M");
  });
  it("G 级", () => {
    expect(formatSize(1_500_000_000)).toBe("1.4G");
  });
});

describe("formatTime", () => {
  it("null 返回 —", () => {
    expect(formatTime(null)).toBe("—");
  });
  it("今年内显示 MM-DD HH:mm", () => {
    const now = new Date();
    const ms = now.getTime();
    const s = formatTime(ms);
    expect(s).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it("跨年显示 YYYY-MM-DD", () => {
    const s = formatTime(new Date("2020-01-01").getTime());
    expect(s).toBe("2020-01-01");
  });
});

describe("basename", () => {
  it("Windows 路径", () => {
    expect(basename("F:\\pantheon\\Project\\R-Dir")).toBe("R-Dir");
  });
  it("Unix 路径", () => {
    expect(basename("/home/kali/file.txt")).toBe("file.txt");
  });
  it("混合分隔符", () => {
    expect(basename("C:/Users/admin/doc")).toBe("doc");
  });
  it("无分隔符返回原串", () => {
    expect(basename("file.txt")).toBe("file.txt");
  });
});

describe("hideExtension（v0.14 隐藏扩展名）", () => {
  it("目录保留原名", () => {
    expect(hideExtension("my.folder", true)).toBe("my.folder");
  });
  it("普通文件去扩展名", () => {
    expect(hideExtension("report.docx", false)).toBe("report");
  });
  it("无扩展名文件保留", () => {
    expect(hideExtension("LICENSE", false)).toBe("LICENSE");
  });
  it("隐藏文件（.gitignore）保留", () => {
    expect(hideExtension(".gitignore", false)).toBe(".gitignore");
  });
  it("复合扩展名只去最后一节", () => {
    expect(hideExtension("backup.tar.gz", false)).toBe("backup.tar");
  });
});
