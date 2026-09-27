import { describe, expect, it } from "vitest";
import { splitPathSegments } from "./path-segments";

describe("路径栏分段拆分", () => {
  it("Windows 盘符路径按 \\ 拆分，盘符为首段", () => {
    expect(splitPathSegments("F:\\Media\\Music\\银铃")).toEqual([
      { label: "F:\\", target: "F:\\" },
      { label: "Media", target: "F:\\Media" },
      { label: "Music", target: "F:\\Media\\Music" },
      { label: "银铃", target: "F:\\Media\\Music\\银铃" },
    ]);
  });

  it("Windows 路径兼容 / 分隔与根路径", () => {
    expect(splitPathSegments("C:/")).toEqual([{ label: "C:\\", target: "C:\\" }]);
    expect(splitPathSegments("C:/Users")).toEqual([
      { label: "C:\\", target: "C:\\" },
      { label: "Users", target: "C:\\Users" },
    ]);
  });

  it("POSIX 绝对路径以 / 为首段", () => {
    expect(splitPathSegments("/mock/home/Documents")).toEqual([
      { label: "/", target: "/" },
      { label: "mock", target: "/mock" },
      { label: "home", target: "/mock/home" },
      { label: "Documents", target: "/mock/home/Documents" },
    ]);
  });

  it("sftp 虚拟路径以 authority 为首段", () => {
    const segs = splitPathSegments("sftp://u@127.0.0.1:22/remote/deploy.sh");
    expect(segs[0]).toEqual({ label: "u@127.0.0.1:22", target: "sftp://u@127.0.0.1:22/" });
    expect(segs[1]).toEqual({
      label: "remote",
      target: "sftp://u@127.0.0.1:22/remote",
    });
    expect(segs[2]).toEqual({
      label: "deploy.sh",
      target: "sftp://u@127.0.0.1:22/remote/deploy.sh",
    });
  });

  it("sftp 根目录只有 authority 段", () => {
    expect(splitPathSegments("sftp://u@h:22/")).toEqual([
      { label: "u@h:22", target: "sftp://u@h:22/" },
    ]);
  });

  it("http 路径按 origin + 路径拆分", () => {
    const segs = splitPathSegments("http://192.168.1.5:8000/music/a.mp3");
    expect(segs[0]).toEqual({ label: "192.168.1.5:8000", target: "http://192.168.1.5:8000/" });
    expect(segs.map((s) => s.label)).toEqual(["192.168.1.5:8000", "music", "a.mp3"]);
  });

  it("标签虚拟视图整体一段", () => {
    expect(splitPathSegments("tags://red")).toEqual([{ label: "tags://red", target: "tags://red" }]);
  });

  it("UNC 与相对路径兜底", () => {
    expect(splitPathSegments("\\\\srv\\share\\a\\b")[0]).toEqual({
      label: "\\\\srv\\share",
      target: "\\\\srv\\share",
    });
    expect(splitPathSegments("relative/path")).toEqual([
      { label: "relative/path", target: "relative/path" },
    ]);
    expect(splitPathSegments("")).toEqual([]);
  });
});
