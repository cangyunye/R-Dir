import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DragGhost } from "./DragGhost";
import type { FileEntry } from "@/lib/types";

function entry(name: string, isDir = false): FileEntry {
  return {
    name,
    path: `/mock/dir/${name}`,
    is_dir: isDir,
    is_symlink: false,
    size: 100,
    modified: 1_700_000_000_000,
    created: null,
    permissions: "rw-r--r--",
    extension: name.includes(".") ? name.split(".").pop()! : "",
  };
}

const ENTRIES = [entry("main.rs"), entry("photo.png"), entry("Notes.txt"), entry("Documents", true)];

describe("DragGhost 拖影内容（v0.49 特性4）", () => {
  it("主卡=首个文件名 + 类型图标；多选带数量徽章与操作文案", () => {
    const { container } = render(
      <DragGhost
        ghostRef={{ current: null }}
        paths={["/mock/dir/main.rs", "/mock/dir/photo.png", "/mock/dir/Notes.txt"]}
        op="copy"
        entries={ENTRIES}
      />,
    );
    expect(container.querySelector("[data-drag-ghost]")).toBeTruthy();
    expect(container.textContent).toContain("main.rs");
    expect(container.textContent).toContain("3"); // 数量徽章
    expect(container.textContent).toContain("复制"); // 操作文案
    // 堆叠层 2 张后卡
    const stacked = [...container.querySelectorAll("div[aria-hidden]")];
    expect(stacked.length).toBe(2);
  });

  it("目录落点行：悬停文件夹时显示「复制到「名」」；移动态切换文案", () => {
    const { container, rerender } = render(
      <DragGhost
        ghostRef={{ current: null }}
        paths={["/mock/dir/main.rs"]}
        op="copy"
        entries={ENTRIES}
        dropDir="Documents"
      />,
    );
    expect(container.textContent).toContain("复制到「Documents」");
    rerender(
      <DragGhost
        ghostRef={{ current: null }}
        paths={["/mock/dir/main.rs"]}
        op="move"
        entries={ENTRIES}
        dropDir="Documents"
      />,
    );
    expect(container.textContent).toContain("移动到「Documents」");
  });

  it("无落点/无条目时不渲染落点行与主卡文案也不崩", () => {
    const { container } = render(
      <DragGhost ghostRef={{ current: null }} paths={[]} op="copy" entries={ENTRIES} />,
    );
    expect(container.textContent).not.toContain("到「");
    expect(container.textContent).not.toContain("复制到");
  });

  it("被拖路径不在条目表（跨目录会话兜底）→ 主卡显示占位不崩", () => {
    const { container } = render(
      <DragGhost
        ghostRef={{ current: null }}
        paths={["/other/dir/x.txt"]}
        op="copy"
        entries={ENTRIES}
      />,
    );
    expect(container.textContent).toContain("…");
  });
});
