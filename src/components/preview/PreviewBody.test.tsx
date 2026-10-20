import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PreviewBody } from "./PreviewBody";
import type { FileEntry } from "@/lib/types";

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
    render(<PreviewBody entry={entry("/mock/home/x.bin")} onOpenExternal={vi.fn()} />);
    expect(screen.getAllByTestId("preview-info").at(-1)?.textContent).toContain("此类型暂不支持预览");
    expect(screen.queryByTestId("preview-remote-open")).toBeNull();
  });
});
