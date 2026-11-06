import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSniffedImage, peekProbe, probeFile } from "./probe";
import { probeLocalFile } from "@/lib/api";
import type { FileEntry } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  probeLocalFile: vi.fn(),
}));
const mockProbe = vi.mocked(probeLocalFile);

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: "payload",
    path: "/mock/home/payload",
    is_dir: false,
    is_symlink: false,
    size: 100,
    modified: 1700000000000,
    created: 1700000000000,
    permissions: "-rw-r--r--",
    extension: "",
    ...over,
  };
}

describe("probe 探测缓存（v0.42）", () => {
  beforeEach(() => {
    mockProbe.mockReset();
  });

  it("同 path|mtime|size 只发一次 IPC，结果会话缓存", async () => {
    // 模块级缓存跨用例共享：每个用例用独立路径避免串味
    mockProbe.mockResolvedValue({ kind: "binary" });
    const e = entry({ path: "/mock/home/p1" });
    await probeFile(e);
    await probeFile(e);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(peekProbe(e)).toEqual({ kind: "binary" });
    expect(isSniffedImage(e)).toBe(false);
  });

  it("mtime/size 变化 → 缓存失效重探（下载中的半截文件改完即重探）", async () => {
    mockProbe.mockResolvedValue({ kind: "binary" });
    const old = entry({ path: "/mock/home/p2" });
    await probeFile(old);
    mockProbe.mockResolvedValue({ kind: "image", format: "png" });
    const changed = entry({ path: "/mock/home/p2", modified: 1700000000001 });
    await probeFile(changed);
    expect(mockProbe).toHaveBeenCalledTimes(2);
    expect(isSniffedImage(changed)).toBe(true);
    // 旧版本条目仍命中旧缓存
    expect(isSniffedImage(entry({ path: "/mock/home/p2" }))).toBe(false);
  });

  it("未探测过的条目 peekProbe 不发 IPC 返回 undefined", () => {
    expect(peekProbe(entry({ path: "/mock/home/p3" }))).toBeUndefined();
    expect(mockProbe).not.toHaveBeenCalled();
  });
});
