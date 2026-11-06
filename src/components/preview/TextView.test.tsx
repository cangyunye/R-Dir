import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TextView } from "./TextView";
import { readTextFile } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  readTextFile: vi.fn(),
}));
const mockRead = vi.mocked(readTextFile);

const content = (text: string) => ({
  path: "/x",
  localPath: "",
  isTemp: false,
  lossy: false,
  text,
  encoding: "UTF-8",
});

describe("TextView 语法高亮（v0.41 渐进增强）", () => {
  beforeEach(() => {
    mockRead.mockReset();
  });

  it("有语法映射的文件：先出纯文本，高亮就绪后替换为 .hljs-* span，原文不变", async () => {
    mockRead.mockResolvedValue(content('{\n  "name": "r-dir"\n}\n'));
    render(<TextView path="/mock/home/app.json" />);
    const pre = await screen.findByTestId("preview-text");
    // 纯文本先落地（首屏零延迟），随后出现高亮 span
    await waitFor(() => {
      expect(pre.querySelector(".hljs-attr")).toBeTruthy();
    });
    expect(pre.querySelector("pre")!.textContent).toContain('"name"');
  });

  it("无语法映射的文件：始终纯文本，无高亮 span", async () => {
    mockRead.mockResolvedValue(content("R-Dir 预览文本第一行\n第二行"));
    render(<TextView path="/mock/home/Notes.txt" />);
    const pre = await screen.findByTestId("preview-text");
    await waitFor(() => {
      expect(pre.querySelector("pre")!.textContent).toContain("R-Dir 预览文本第一行");
    });
    expect(pre.querySelector(".hljs-")).toBeNull();
  });

  it("读取失败仍显示失败占位（高亮不改变错误路径）", async () => {
    mockRead.mockRejectedValue(new Error("boom"));
    render(<TextView path="/mock/home/gone.json" />);
    await waitFor(() => {
      expect(screen.getByText("文本读取失败")).toBeTruthy();
    });
  });
});

describe("TextView 试探模式（v0.42 text-probe 的文本结果）", () => {
  beforeEach(() => {
    mockRead.mockReset();
  });

  it("probe 模式：顶部出现「未知类型」试探横幅，纯文本无高亮", async () => {
    mockRead.mockResolvedValue(content("payload body"));
    render(<TextView path="/mock/home/payload" probe />);
    const pre = await screen.findByTestId("preview-text");
    expect(screen.getByTestId("preview-probe-banner").textContent).toContain("未知类型");
    expect(pre.querySelector("pre")!.textContent).toContain("payload body");
    expect(pre.querySelector(".hljs-")).toBeNull();
  });

  it("非 probe：无试探横幅", async () => {
    mockRead.mockResolvedValue(content("plain text"));
    render(<TextView path="/mock/home/notes.txt" />);
    await screen.findByTestId("preview-text");
    expect(screen.queryByTestId("preview-probe-banner")).toBeNull();
  });

  it("读取失败仍显示失败占位（probe 与否一致）", async () => {
    mockRead.mockRejectedValue(new Error("boom"));
    render(<TextView path="/mock/home/gone.json" probe />);
    await waitFor(() => {
      expect(screen.getByText("文本读取失败")).toBeTruthy();
    });
  });
});
