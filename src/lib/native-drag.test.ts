import { describe, it, expect } from "vitest";
import { fileUriList } from "./native-drag";

/** file:// URI 列表（macOS HTML5 拖出）：百分号编码 + 每条 CRLF 结尾。
 *  中文/空格文件名不编码时 WKWebView 的 NSURL 解析失败，拖到 Dock 废纸篓
 *  被拒收、拖到 Finder 退化成文本（v0.52 修复回归点）。 */
describe("fileUriList（拖出 uri-list 组装）", () => {
  it("纯 ASCII 路径：href 形态不变，单条以 CRLF 结尾", () => {
    expect(fileUriList(["/mock/home/Notes.txt"])).toBe("file:///mock/home/Notes.txt\r\n");
  });

  it("空格与中文件名：百分号编码（UTF-8），语义路径不变", () => {
    const out = fileUriList(["/mock/home/我的 文件.txt"]);
    expect(out).toBe("file:///mock/home/%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6.txt\r\n");
    // 反解回原路径（模拟 WKWebView → NSURL 的解码侧）
    expect(decodeURIComponent(out.replace("file://", "").trimEnd())).toBe("/mock/home/我的 文件.txt");
  });

  it("「#」「?」等保留字也编码（不作为 URI 定界符吞路径）", () => {
    const out = fileUriList(["/mock/home/a#b?c.txt"]);
    expect(out).not.toContain("#");
    expect(out).not.toContain("?");
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("多条目：CRLF 分隔 + 末条收尾，反解逐条等于原路径", () => {
    const paths = ["/mock/home/a.txt", "/mock/home/图 片.png"];
    const out = fileUriList(paths);
    const round = out
      .split("\r\n")
      .filter(Boolean)
      .map((u) => decodeURIComponent(u.replace("file://", "")));
    expect(round).toEqual(paths);
  });

  it("Windows 反斜杠路径折算 posix 斜杠", () => {
    expect(fileUriList(["C:\\Users\\demo\\a.txt"]).startsWith("file:///C:/Users/demo/a.txt")).toBe(true);
  });
});
