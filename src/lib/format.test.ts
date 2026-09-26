import { describe, it, expect } from "vitest";
import { formatSize, formatTime, basename, hideExtension, isAbsolutePath } from "./format";

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

describe("isAbsolutePath（v0.18 地址栏路径判定）", () => {
  it("Unix 绝对路径", () => {
    expect(isAbsolutePath("/home/kali")).toBe(true);
  });
  it("Windows 盘符路径", () => {
    expect(isAbsolutePath("C:\\Users\\admin")).toBe(true);
    expect(isAbsolutePath("C:/Users/admin")).toBe(true);
  });
  it("UNC 路径", () => {
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
  });
  it("相对路径与 ~ 不是绝对路径", () => {
    expect(isAbsolutePath("Documents")).toBe(false);
    expect(isAbsolutePath("./a/b")).toBe(false);
    expect(isAbsolutePath("~/.config/opencode/")).toBe(false);
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
