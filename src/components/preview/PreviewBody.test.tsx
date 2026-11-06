import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PreviewBody } from "./PreviewBody";
import { probeLocalFile } from "@/lib/api";
import type { FileEntry } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeLocalFile: vi.fn(),
  previewData: vi.fn().mockResolvedValue(null),
  // 探测判文本后 TextView 还会走 readTextFile 读内容（jsdom 下原实现必然 reject）
  readTextFile: vi.fn().mockResolvedValue({
    path: "",
    localPath: "",
    isTemp: false,
    lossy: false,
    text: "payload text",
    encoding: "UTF-8",
  }),
}));
const mockProbe = vi.mocked(probeLocalFile);

function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  const name = path.replace(/\/+$/, "").split("/").pop() ?? path;
  return {
    name,
    path,
    is_dir: false,
    is_symlink: false,
    size: 2048,
    modified: 1700000000000,
    created: 1700000000000,
    permissions: "-rw-r--r--",
    extension: name.split(".").pop() ?? "",
    ...over,
  };
}

describe("PreviewBody 信息卡：远程文件（v0.31.1）", () => {
  it("SFTP 文件：提示可下载到本地（双击），并给「下载到本地并打开」按钮走同一链路", () => {
    const onOpenExternal = vi.fn();
    render(
      <PreviewBody entry={entry("sftp://u@h:22/srv/report.pdf")} onOpenExternal={onOpenExternal} />,
    );
    const card = screen.getByTestId("preview-info");
    expect(card.textContent).toContain("下载到本地");
    expect(card.textContent).toContain("双击");
    expect(card.textContent).not.toContain("暂不支持内容预览");
    fireEvent.click(screen.getByTestId("preview-remote-open"));
    expect(onOpenExternal).toHaveBeenCalledWith("sftp://u@h:22/srv/report.pdf");
  });

  it("HTTP 文件：提示用浏览器打开", () => {
    const onOpenExternal = vi.fn();
    render(
      <PreviewBody entry={entry("http://h:8082/docs/a.zip")} onOpenExternal={onOpenExternal} />,
    );
    expect(screen.getByTestId("preview-info").textContent).toContain("浏览器");
    fireEvent.click(screen.getByTestId("preview-remote-open"));
    expect(onOpenExternal).toHaveBeenCalledWith("http://h:8082/docs/a.zip");
  });

  it("远程目录 / 未传回调时不出现按钮；本地不支持类型文案不变", () => {
    render(<PreviewBody entry={entry("sftp://u@h:22/srv/dir", { is_dir: true })} />);
    expect(screen.queryByTestId("preview-remote-open")).toBeNull();
    render(<PreviewBody entry={entry("sftp://u@h:22/srv/x.bin")} />);
    expect(screen.queryByTestId("preview-remote-open")).toBeNull();
    // 本地 zip（archive 桶）仍同步 info；未知类型（v0.42 text-probe）见下方 describe
    render(<PreviewBody entry={entry("/mock/home/x.zip")} onOpenExternal={vi.fn()} />);
    expect(screen.getAllByTestId("preview-info").at(-1)?.textContent).toContain("此类型暂不支持预览");
    expect(screen.queryByTestId("preview-remote-open")).toBeNull();
  });
});

describe("PreviewBody 未知类型试探（v0.42 text-probe → TextProbe 探测路由）", () => {
  beforeEach(() => {
    mockProbe.mockReset();
  });

  it("探测判二进制 → 回退「疑似二进制」信息卡（不发文本读取）", async () => {
    // 探测缓存是模块级（跨用例共享）：每个用例独立路径避免串味
    mockProbe.mockResolvedValueOnce({ kind: "binary" });
    render(<PreviewBody entry={entry("/mock/home/p-bin")} onOpenExternal={vi.fn()} />);
    const card = await screen.findByTestId("preview-info");
    expect(card.textContent).toContain("疑似二进制文件");
    expect(card.textContent).toContain("p-bin");
    expect(mockProbe).toHaveBeenCalledWith("/mock/home/p-bin");
  });

  it("探测判文本 → 文本视图 + 试探横幅", async () => {
    mockProbe.mockResolvedValueOnce({
      kind: "text",
      path: "/mock/home/p-text",
      localPath: "",
      isTemp: false,
      lossy: false,
      text: "payload text",
      encoding: "UTF-8",
    });
    render(<PreviewBody entry={entry("/mock/home/p-text")} />);
    const view = await screen.findByTestId("preview-text");
    expect(view.textContent).toContain("payload text");
    expect(view.textContent).toContain("未知类型");
  });

  it("探测判图片 → 原图查看器（jsdom 解码失败走 fallback 疑似二进制卡）", async () => {
    mockProbe.mockResolvedValueOnce({ kind: "image", format: "png" });
    render(<PreviewBody entry={entry("/mock/home/p-img")} onOpenExternal={vi.fn()} />);
    const card = await screen.findByTestId("preview-info");
    expect(card.textContent).toContain("疑似二进制");
  });

  it("探测判超大（非图片超 8MB）→ 默认信息卡", async () => {
    mockProbe.mockResolvedValueOnce({ kind: "oversized" });
    render(<PreviewBody entry={entry("/mock/home/p-huge", { size: 9 * 1024 * 1024 })} />);
    const card = await screen.findByTestId("preview-info");
    expect(card.textContent).toContain("此类型暂不支持预览");
  });
});
