import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSniffPreviewList } from "./useSniffPreviewList";
import { probeLocalFile } from "@/lib/api";
import type { FileEntry } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  probeLocalFile: vi.fn(),
}));
const mockProbe = vi.mocked(probeLocalFile);

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/mock/home/${name}`,
    is_dir: false,
    is_symlink: false,
    size: 100,
    modified: 1700000000000,
    created: 1700000000000,
    permissions: "-rw-r--r--",
    extension: name.includes(".") ? name.split(".").pop()! : "",
    ...over,
  };
}

describe("useSniffPreviewList 浏览模式懒收录（v0.42）", () => {
  beforeEach(() => {
    mockProbe.mockReset();
  });

  it("基础清单 = 可预览类型（排序、过滤与列表同序）；未知类型命中图片后追加", async () => {
    // 乱序传入：hook 输出应与列表同序（name asc）
    const entries = [
      entry("payload"), // 未知类型 → 嗅探判图片
      entry("b.png"),
      entry("d.zip"), // archive 桶：不收录
      entry("sub", { is_dir: true, extension: "" }), // 目录：不收录
      entry("blob2"), // 未知类型 → 嗅探判二进制：不收录
      entry("a.md"),
    ];
    mockProbe.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("payload")
          ? { kind: "image" as const, format: "png" }
          : { kind: "binary" as const },
      ),
    );
    const { result } = renderHook(() =>
      useSniffPreviewList(entries, "name", "asc", false, true),
    );
    // 嗅探落地前已有扩展名可判定清单
    expect(result.current.map((e) => e.name)).toEqual(["a.md", "b.png"]);
    // 嗅探命中图片渐进追加（二进制不进）
    await waitFor(() => {
      expect(result.current.map((e) => e.name)).toEqual(["a.md", "b.png", "payload"]);
    });
    // 两个候选都被探测
    expect(mockProbe).toHaveBeenCalledTimes(2);
  });

  it("enabled=false：不探测、不追加", async () => {
    const entries = [entry("b.png"), entry("payload")];
    const { result } = renderHook(() =>
      useSniffPreviewList(entries, "name", "asc", false, false),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.map((e) => e.name)).toEqual(["b.png"]);
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("嗅探结果走会话缓存：同一文件夹重复激活不重复发 IPC", async () => {
    const entries = [entry("b.png"), entry("photo2")];
    mockProbe.mockResolvedValue({ kind: "image", format: "png" });
    const first = renderHook(() => useSniffPreviewList(entries, "name", "asc", false, true));
    await waitFor(() => {
      expect(first.result.current.map((e) => e.name)).toEqual(["b.png", "photo2"]);
    });
    const times = mockProbe.mock.calls.length;
    // 重新挂载（模拟浏览模式退出再进入，条目数据不变）
    const second = renderHook(() => useSniffPreviewList(entries, "name", "asc", false, true));
    await waitFor(() => {
      expect(second.result.current.map((e) => e.name)).toEqual(["b.png", "photo2"]);
    });
    expect(mockProbe.mock.calls.length).toBe(times);
  });
});
