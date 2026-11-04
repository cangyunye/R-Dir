import { describe, it, expect } from "vitest";
import { highlightCode, languageForPath } from "./highlight";

describe("languageForPath", () => {
  it("扩展名 → 语言 id（大小写不敏感，Windows 反斜杠路径兜底）", () => {
    expect(languageForPath("/home/prj/main.rs")).toBe("rust");
    expect(languageForPath("/home/app.tsx")).toBe("typescript");
    expect(languageForPath("/home/Cargo.TOML")).toBe("ini");
    expect(languageForPath("/home/data.jsonl")).toBe("json");
    expect(languageForPath("/home/run.sh")).toBe("bash");
    expect(languageForPath("/home/backup.ps1")).toBe("powershell");
    expect(languageForPath("C:\\dir\\a.py")).toBe("python");
  });

  it("无扩展名 / 点前缀约定文件按完整文件名命中（后端对点文件给空扩展名）", () => {
    expect(languageForPath("/home/Makefile")).toBe("makefile");
    expect(languageForPath("/home/dockerfile")).toBe("dockerfile");
    expect(languageForPath("/home/Gemfile")).toBe("ruby");
    expect(languageForPath("/home/.bashrc")).toBe("bash");
    expect(languageForPath("/home/.gitconfig")).toBe("ini");
  });

  it("无语法 / 纯文本 / 未知 → null（保持纯文本，不硬猜）", () => {
    expect(languageForPath("/home/notes.txt")).toBeNull();
    expect(languageForPath("/home/data.csv")).toBeNull();
    expect(languageForPath("/home/app.log")).toBeNull();
    // hljs 11 无 vue / zig 语法模块
    expect(languageForPath("/home/app.vue")).toBeNull();
    expect(languageForPath("/home/src.zig")).toBeNull();
    // .env* 明确不映射（bash 语法对 KEY=value 整行误判，不如纯文本）
    expect(languageForPath("/home/.env.local")).toBeNull();
    expect(languageForPath("/home/.gitignore")).toBeNull();
    expect(languageForPath("/home/a.zip")).toBeNull();
    expect(languageForPath("/home/Makefile.bak")).toBeNull();
  });
});

describe("highlightCode", () => {
  it("json：产出 .hljs-* span 且原文保留（选区/复制语义依赖）", async () => {
    const html = await highlightCode('{\n  "name": "r-dir"\n}', "json");
    expect(html).toBeTruthy();
    expect(html!).toContain("hljs-attr");
    expect(html!).toContain("hljs-string");
    expect(html!).toContain("r-dir");
  });

  it("输出自带 HTML 转义，可安全 dangerouslySetInnerHTML", async () => {
    const html = await highlightCode('<img src=x onerror="alert(1)">', "xml");
    expect(html!).toBeTruthy();
    // 原文标签不再以未转义形态出现；`<` 已转义为实体（img 被 xml 语法包进 hljs-name span，故非连续）
    expect(html!).not.toContain("<img");
    expect(html!).toContain("&lt;<span");
  });

  it("语言映射表外的 id → null 回退", async () => {
    expect(await highlightCode("x = 1", "cobol")).toBeNull();
  });

  it("span 数超护栏 → null 回退（极端 token 密度宁可不着色）", async () => {
    const big = "{" + '"k": 1,'.repeat(12000) + '"k": 1}';
    expect(await highlightCode(big, "json")).toBeNull();
  });

  it("非法语法输入不抛错（ignoreIllegals）", async () => {
    const html = await highlightCode("{{{}}} \"\"\" unbalanced", "json");
    expect(typeof html === "string" || html === null).toBe(true);
  });
});
