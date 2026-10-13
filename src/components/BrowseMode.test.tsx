import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowseMode } from "./BrowseMode";
import type { FileEntry } from "@/lib/types";

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
  sortKey: "name" as const,
  sortDir: "asc" as const,
  showHidden: false,
  onClose: vi.fn(),
  onOpenExternal: vi.fn(),
};

function setup(entries: FileEntry[], primaryPath: string | null = null) {
  const onNavigate = vi.fn();
  render(
    <BrowseMode
      {...base}
      entries={entries}
      primaryPath={primaryPath}
      onNavigate={onNavigate}
    />,
  );
  return { onNavigate };
}

describe("BrowseMode 图文浏览模式", () => {
  it("只收录可预览类型（目录/zip 不出现在缩略图条）", () => {
    setup([
      entry("b.png"),
      entry("a.md"),
      entry("c.pdf"),
      entry("d.zip"),
      entry("sub", { is_dir: true, extension: "" }),
    ]);
    const strip = screen.getByTestId("browse-mode");
    // 图片 tile 在 jsdom 中缩略图失败回退图标（无文件名文本），用 title 断言
    expect(strip.querySelector('button[title="b.png"]')).not.toBeNull();
    expect(strip.textContent).toContain("a.md");
    expect(strip.textContent).toContain("c.pdf");
    expect(strip.querySelector('button[title="d.zip"]')).toBeNull();
    expect(strip.querySelector('button[title="sub"]')).toBeNull();
    // 未选中 → 从第 1 项开始（共 3 项）
    expect(screen.getByTestId("browse-counter").textContent).toBe("1 / 3");
  });

  it("主选中定位：primaryPath 为第 2 项 → 计数 2/3", () => {
    const entries = [entry("a.md"), entry("b.png"), entry("c.pdf")];
    setup(entries, "/mock/home/b.png");
    expect(screen.getByTestId("browse-counter").textContent).toBe("2 / 3");
  });

  it("→ 切换下一项并回调 onNavigate（导航即选中）", () => {
    const { onNavigate } = setup([entry("a.md"), entry("b.png")]);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith("/mock/home/b.png");
  });

  it("首项按 ← 停留不动；End 跳最后一项", () => {
    const { onNavigate } = setup([entry("a.md"), entry("b.png"), entry("c.pdf")], "/mock/home/a.md");
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
        entries={[entry("b.png")]}
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
});
