import { describe, it, expect } from "vitest";
import {
  isSftpPath,
  isHttpPath,
  parseSftpAuthority,
  joinRemote,
} from "./sftp-path";

describe("路径协议判定", () => {
  it("识别 sftp:// 路径", () => {
    expect(isSftpPath("sftp://u@h:22/x")).toBe(true);
    expect(isSftpPath("C:\\Users")).toBe(false);
  });
  it("识别 http/https 路径", () => {
    expect(isHttpPath("http://localhost:8082/")).toBe(true);
    expect(isHttpPath("https://example.com/")).toBe(true);
    expect(isHttpPath("sftp://u@h/")).toBe(false);
  });
});

describe("parseSftpAuthority", () => {
  it("解析 user@host:port/path", () => {
    const a = parseSftpAuthority("sftp://kali@192.168.31.100:22/home/kali");
    expect(a).not.toBeNull();
    expect(a!.user).toBe("kali");
    expect(a!.host).toBe("192.168.31.100");
    expect(a!.port).toBe(22);
    expect(a!.id).toBe("kali@192.168.31.100:22");
    expect(a!.remotePath).toBe("/home/kali");
  });

  it("缺省端口 22", () => {
    const a = parseSftpAuthority("sftp://u@host/root");
    expect(a!.port).toBe(22);
    expect(a!.remotePath).toBe("/root");
  });

  it("根路径 remotePath 为 /", () => {
    const a = parseSftpAuthority("sftp://u@h:2222/");
    expect(a!.remotePath).toBe("/");
  });

  it("无 user@ 返回 null", () => {
    expect(parseSftpAuthority("sftp://")).toBeNull();
    expect(parseSftpAuthority("sftp://192.168.1.1/")).toBeNull();
  });
});

describe("joinRemote（回归：不能把 sftp:// 前缀拼进去）", () => {
  it("纯远程目录拼接文件名", () => {
    expect(joinRemote("/home/kali", "file.txt")).toBe("/home/kali/file.txt");
    expect(joinRemote("/home/kali/", "file.txt")).toBe("/home/kali/file.txt");
  });

  it("拼出的路径必须以 / 开头，不能含 sftp://", () => {
    const result = joinRemote("/home/kali", "AGENTS.md");
    expect(result.startsWith("/")).toBe(true);
    expect(result.startsWith("sftp://")).toBe(false);
    expect(result).not.toContain("@");
  });
});

// ---- v0.8.x 新建文件夹路径拼接回归 ----
describe("sftp 新建文件夹路径拼接", () => {
  it("joinRemote 在 sftp://host:port/root 下拼接子目录", () => {
    const base = "sftp://kali@192.168.31.100:22/home/kali";
    expect(joinRemote(base, "新建文件夹")).toBe(
      "sftp://kali@192.168.31.100:22/home/kali/新建文件夹",
    );
  });
  it("joinRemote 在 sftp://host:port/root/ 下不重复斜杠", () => {
    const base = "sftp://kali@192.168.31.100:22/home/kali/";
    expect(joinRemote(base, "新建文件夹")).toBe(
      "sftp://kali@192.168.31.100:22/home/kali/新建文件夹",
    );
  });
  it("joinRemote 根目录 / 下拼接", () => {
    const base = "sftp://kali@192.168.31.100:22/";
    expect(joinRemote(base, "data")).toBe(
      "sftp://kali@192.168.31.100:22/data",
    );
  });
  it("isSftpPath 识别 sftp:// 前缀", () => {
    expect(isSftpPath("sftp://kali@192.168.31.100:22/home/kali")).toBe(true);
    expect(isSftpPath("C:\\Users")).toBe(false);
    expect(isSftpPath("tags://red")).toBe(false);
  });
});