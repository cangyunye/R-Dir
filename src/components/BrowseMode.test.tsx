import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowseMode } from "./BrowseMode";
import { probeFile } from "@/lib/probe";
import { probeLocalFile } from "@/lib/api";
import type { FileEntry } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
    extension: name.split(".").pop() ?? "",
    ...over,
  };
}

const base = {
  onClose: vi.fn(),
  onOpenExternal: vi.fn(),
};

/** list 即调用方（App useSniffPreviewList）算好的收录清单：排序/过滤语义归 hook 测试 */
function setup(list: FileEntry[], primaryPath: string | null = null) {
  const onNavigate = vi.fn();
  render(
    <BrowseMode list={list} primaryPath={primaryPath} onNavigate={onNavigate} {...base} />,
  );
  return { onNavigate };
}

describe("BrowseMode 图文浏览模式", () => {
  beforeEach(() => {
    mockProbe.mockReset();
  });

  it("渲染调用方清单：图片 tile / 文本 / 文档卡 + 计数", () => {
    setup([entry("a.md"), entry("b.png"), entry("c.pdf")]);
    const strip = screen.getByTestId("browse-mode");
    // 图片 tile 在 jsdom 中缩略图失败回退图标（无文件名文本），用 title 断言
    expect(strip.querySelector('button[title="b.png"]')).not.toBeNull();
    expect(strip.textContent).toContain("a.md");
    expect(strip.textContent).toContain("c.pdf");
    // 未选中 → 从第 1 项开始（共 3 项）
    expect(screen.getByTestId("browse-counter").textContent).toBe("1 / 3");
  });

  it("主选中定位：primaryPath 为第 2 项 → 计数 2/3", () => {
    const list = [entry("a.md"), entry("b.png"), entry("c.pdf")];
    setup(list, "/mock/home/b.png");
    expect(screen.getByTestId("browse-counter").textContent).toBe("2 / 3");
  });

  it("→ 切换下一项并回调 onNavigate（导航即选中）", () => {
    const { onNavigate } = setup([entry("a.md"), entry("b.png")]);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith("/mock/home/b.png");
  });

  it("首项按 ← 停留不动；End 跳最后一项", () => {
    const { onNavigate } = setup(
      [entry("a.md"), entry("b.png"), entry("c.pdf")],
      "/mock/home/a.md",
    );
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "End" });
    expect(onNavigate).toHaveBeenLastCalledWith("/mock/home/c.pdf");
  });

  it("ESC 退出；Enter 外部打开当前项", () => {
    const onOpenExternal = vi.fn();
    render(
      <BrowseMode
        {...base}
        onOpenExternal={onOpenExternal}
        list={[entry("b.png")]}
        primaryPath={null}
        onNavigate={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onOpenExternal).toHaveBeenCalledWith("/mock/home/b.png");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalled();
  });

  it("点击缩略图条小卡 → onNavigate 对应路径", () => {
    const { onNavigate } = setup([entry("a.md"), entry("b.png"), entry("c.pdf")]);
    fireEvent.click(screen.getByTitle("c.pdf"));
    expect(onNavigate).toHaveBeenCalledWith("/mock/home/c.pdf");
  });

  it("v0.42 嗅探命中的未知类型图片：与原生图片同款缩略图 tile（w-20）", async () => {
    const unknown = entry("photo", { extension: "" });
    mockProbe.mockResolvedValue({ kind: "image", format: "png" });
    await probeFile(unknown); // 预热会话缓存（等价 App 侧懒收录路径的产物）
    render(<BrowseMode list={[unknown]} primaryPath={null} onNavigate={vi.fn()} {...base} />);
    const tile = screen.getByTestId("browse-mode").querySelector('button[title="photo"]');
    expect(tile).not.toBeNull();
    expect(tile!.className).toContain("w-20");
  });
});
