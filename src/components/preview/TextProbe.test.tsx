import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TextProbe } from "./TextProbe";
import { probeLocalFile } from "@/lib/api";
import type { FileEntry } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeLocalFile: vi.fn(),
  readTextFile: vi.fn().mockResolvedValue({
    path: "/mock/home/payload",
    localPath: "",
    isTemp: false,
    lossy: false,
    text: "payload text",
    encoding: "UTF-8",
  }),
  previewData: vi.fn().mockResolvedValue(null),
}));
const mockProbe = vi.mocked(probeLocalFile);

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: "payload",
    path: "/mock/home/payload",
    is_dir: false,
    is_symlink: false,
    size: 2048,
    modified: 1700000000000,
    created: 1700000000000,
    permissions: "-rw-r--r--",
    extension: "",
    ...over,
  };
}

describe("TextProbe 未知类型探测路由（v0.42）", () => {
  beforeEach(() => {
    mockProbe.mockReset();
  });

  it("text → TextView（试探横幅 + 纯文本）", async () => {
    // 探测缓存是模块级（跨用例共享）：每个用例独立路径避免串味
    mockProbe.mockResolvedValue({
      kind: "text",
      path: "/tp-text",
      localPath: "",
      isTemp: false,
      lossy: false,
      text: "payload text",
      encoding: "UTF-8",
    });
    render(<TextProbe entry={entry({ path: "/tp-text" })} />);
    const view = await screen.findByTestId("preview-text");
    expect(view.textContent).toContain("payload text");
    expect(screen.getByTestId("preview-probe-banner").textContent).toContain("未知类型");
  });

  it("text 且超 2MB → 信息卡（门槛在 TextProbe 内判定）", async () => {
    mockProbe.mockResolvedValue({
      kind: "text",
      path: "/tp-big",
      localPath: "",
      isTemp: false,
      lossy: false,
      text: "big",
      encoding: "UTF-8",
    });
    render(<TextProbe entry={entry({ path: "/tp-big", size: 3 * 1024 * 1024 })} />);
    const card = await screen.findByTestId("preview-info");
    expect(card.textContent).toContain("此类型暂不支持预览");
  });

  it("image → 原图查看器；解码失败回退疑似二进制信息卡（fallback 链）", async () => {
    mockProbe.mockResolvedValue({ kind: "image", format: "png" });
    render(<TextProbe entry={entry({ path: "/tp-img" })} onOpenExternal={vi.fn()} />);
    // jsdom 无图片解码（previewData 桩回 null）→ ImageView fallback = 疑似二进制卡
    const card = await screen.findByTestId("preview-info");
    expect(card.textContent).toContain("疑似二进制");
  });

  it("image 且超 30MB → 超大图回退（缩略图放大）", async () => {
    mockProbe.mockResolvedValue({ kind: "image", format: "png" });
    render(<TextProbe entry={entry({ path: "/tp-img-big", size: 31 * 1024 * 1024 })} />);
    // jsdom 缩略图失败回退图标，但 OversizedImage 容器文案可断言
    await waitFor(() => {
      expect(screen.getByText(/文件超过 30MB/)).toBeTruthy();
    });
  });

  it("binary → 疑似二进制信息卡；探测失败 → 通用失败占位", async () => {
    mockProbe.mockResolvedValue({ kind: "binary" });
    const { unmount } = render(<TextProbe entry={entry({ path: "/tp-bin" })} />);
    const card = await screen.findByTestId("preview-info");
    expect(card.textContent).toContain("疑似二进制文件");
    unmount();

    mockProbe.mockRejectedValue("NOT_FILE|路径不是常规文件（目录/管道/设备），无法按文本读取");
    render(<TextProbe entry={entry({ path: "/tp-fifo", modified: 1 })} />);
    await waitFor(() => {
      expect(screen.getByText("文本读取失败")).toBeTruthy();
    });
  });

  it("oversized → 默认信息卡（非图片超 8MB 文本上限）", async () => {
    mockProbe.mockResolvedValue({ kind: "oversized" });
    render(<TextProbe entry={entry({ path: "/tp-over", size: 9 * 1024 * 1024 })} />);
    const card = await screen.findByTestId("preview-info");
    expect(card.textContent).toContain("此类型暂不支持预览");
  });
});
