import { describe, it, expect, vi } from "vitest";
import { statEntriesWalk, needsRemoteStat } from "./remote-size";
import type { FileEntry } from "./types";

// listDir 来自 ./api（Tauri invoke 封装），这里整体桩化
vi.mock("./api", () => ({
  listDir: vi.fn(),
}));

import { listDir } from "./api";
const listDirMock = vi.mocked(listDir);

const file = (path: string, size: number): FileEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  is_dir: false,
  is_symlink: false,
  size,
  modified: null,
  created: null,
  permissions: "",
  extension: "",
});
const dir = (path: string): FileEntry => ({
  ...file(path, 0),
  is_dir: true,
});

describe("needsRemoteStat", () => {
  it("含 sftp/http 路径时需要远程统计", () => {
    expect(needsRemoteStat([{ path: "/tmp/a" }])).toBe(false);
    expect(needsRemoteStat([{ path: "sftp://u@h:22/a" }])).toBe(true);
    expect(needsRemoteStat([{ path: "http://h/a" }])).toBe(true);
    expect(needsRemoteStat([{ path: "/tmp/a" }, { path: "sftp://u@h:22/a" }])).toBe(true);
  });
});

describe("statEntriesWalk", () => {
  it("种子文件大小先计入，目录逐层 BFS 递归", async () => {
    listDirMock.mockImplementation(async (p: string) => {
      if (p === "sftp://u@h:22/dir")
        return [file("sftp://u@h:22/dir/a.txt", 10), dir("sftp://u@h:22/dir/sub")];
      if (p === "sftp://u@h:22/dir/sub")
        return [file("sftp://u@h:22/dir/sub/b.bin", 32)];
      return [];
    });
    const shots: number[] = [];
    const r = await statEntriesWalk(
      [file("sftp://u@h:22/top.bin", 5), dir("sftp://u@h:22/dir")],
      (s) => shots.push(s.bytes),
      () => false,
    );
    expect(r).toEqual({ bytes: 47, files: 3, dirs: 2 });
    // 进度单调不减且最终值 = 返回值
    expect(shots[0]).toBe(5);
    expect(shots[shots.length - 1]).toBe(47);
    expect([...shots].sort((a, b) => a - b)).toEqual(shots);
  });

  it("列目录失败跳过该目录不中断", async () => {
    listDirMock.mockImplementation(async (p: string) => {
      if (p === "sftp://u@h:22/bad") throw new Error(" perm denied");
      if (p === "sftp://u@h:22/ok") return [file("sftp://u@h:22/ok/x", 7)];
      return [];
    });
    const r = await statEntriesWalk(
      [dir("sftp://u@h:22/bad"), dir("sftp://u@h:22/ok")],
      () => {},
      () => false,
    );
    expect(r).toEqual({ bytes: 7, files: 1, dirs: 2 });
  });

  it("符号链接环不导致死循环", async () => {
    listDirMock.mockImplementation(async (p: string) =>
      p === "sftp://u@h:22/a" ? [dir("sftp://u@h:22/a")] : [],
    );
    const r = await statEntriesWalk(
      [dir("sftp://u@h:22/a")],
      () => {},
      () => false,
    );
    expect(r).toEqual({ bytes: 0, files: 0, dirs: 1 });
  });

  it("cancelled 后提前停止", async () => {
    let calls = 0;
    listDirMock.mockImplementation(async () => {
      calls++;
      return [dir("sftp://u@h:22/next")];
    });
    const r = await statEntriesWalk(
      [dir("sftp://u@h:22/n0")],
      () => {},
      () => calls >= 2,
    );
    expect(r.dirs).toBeLessThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(3);
  });
});
