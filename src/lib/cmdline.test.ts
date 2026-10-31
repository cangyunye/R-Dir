import { describe, expect, it } from "vitest";
import { firstCommandToken, hasScheme, isCommandToken } from "./cmdline";

describe("地址栏命令判定（v0.22.0）", () => {
  describe("hasScheme", () => {
    it("识别 sftp/http/tags 前缀（大小写不敏感、容忍首尾空白）", () => {
      expect(hasScheme("sftp://h/")).toBe(true);
      expect(hasScheme("HTTPS://example.com/")).toBe(true);
      expect(hasScheme("  tags://全部 ")).toBe(true);
      expect(hasScheme("/local/path")).toBe(false);
      expect(hasScheme("git")).toBe(false);
    });
    it("v0.39 通用化：smb/nfs 等新协议 scheme 同样命中（此前漏判致地址栏输入被拼进 cwd）", () => {
      expect(hasScheme("smb://172.20.214.44")).toBe(true);
      expect(hasScheme("nfs://h1/export")).toBe(true);
      expect(hasScheme("ftp://h")).toBe(true);
      expect(hasScheme("my-scheme+1.2://h")).toBe(true);
      expect(hasScheme("://no-name")).toBe(false);
      expect(hasScheme("1bad://h")).toBe(false);
    });
  });

  describe("isCommandToken（单裸词 → 请求命令补全）", () => {
    it("裸词命中", () => {
      expect(isCommandToken("git")).toBe(true);
      expect(isCommandToken("  GIT ")).toBe(true);
    });
    it("含空白（已输参数）、分隔符、盘符冒号、~、scheme 均不命中", () => {
      expect(isCommandToken("git status")).toBe(false);
      expect(isCommandToken("./x.sh")).toBe(false);
      expect(isCommandToken("a/b")).toBe(false);
      expect(isCommandToken("a\\b")).toBe(false);
      expect(isCommandToken("C:")).toBe(false);
      expect(isCommandToken("~")).toBe(false);
      expect(isCommandToken("~/Doc")).toBe(false);
      expect(isCommandToken("sftp://h/")).toBe(false);
      expect(isCommandToken("")).toBe(false);
      expect(isCommandToken("   ")).toBe(false);
    });
  });

  describe("firstCommandToken（回车兜底执行判定）", () => {
    it("带参数的命令行返回首 token", () => {
      expect(firstCommandToken("git status")).toBe("git");
      expect(firstCommandToken("  echo \"hello world\"  ")).toBe("echo");
    });
    it("首 token 含分隔符 / 盘符、scheme、~ 开头 → null（交回路径流程）", () => {
      expect(firstCommandToken("./run.sh arg")).toBeNull();
      expect(firstCommandToken("C:\\tools\\x.exe")).toBeNull();
      expect(firstCommandToken("sftp://h/git")).toBeNull();
      expect(firstCommandToken("~/bin/t")).toBeNull();
      expect(firstCommandToken("")).toBeNull();
    });
  });
});
