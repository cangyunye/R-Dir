import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

const base = {
  quickAccess: [],
  volumes: [],
  currentPath: "/",
  onNavigate: vi.fn(),
  onMiddleOpen: vi.fn(),
  customQuick: [],
  onRemoveQuick: vi.fn(),
  tagCounts: {} as Record<string, number>,
  tagNames: {} as Record<string, string>,
  onRenameTag: vi.fn(),
  activeTagId: null as string | null,
  onSelectTag: vi.fn(),
  sftpServers: [],
  onSftpOpen: vi.fn(),
  onSftpDisconnect: vi.fn(),
  onSftpEdit: vi.fn(),
  onSftpRemove: vi.fn(),
};

describe("Sidebar 标签计数（v0.15 修复被遮挡）", () => {
  it("显示标签的文件数量", () => {
    render(<Sidebar {...base} tagCounts={{ red: 3 }} />);
    expect(screen.getByText("3")).toBeTruthy();
  });

  // 回归：标签名 span 缺 min-w-0 时 flex-1 无法收缩，长名会把右侧计数挤出
  // 侧栏可视区（被窗格遮住）；ScrollArea 的 display:table 会进一步按 max-content 撑宽。
  it("长标签名可截断（min-w-0），计数仍渲染在行内", () => {
    render(
      <Sidebar
        {...base}
        tagCounts={{ red: 5 }}
        tagNames={{ red: "一个非常非常长的标签名称用于测试截断" }}
      />,
    );
    const label = screen.getByText("一个非常非常长的标签名称用于测试截断");
    expect(label.className).toContain("min-w-0");
    expect(label.className).toContain("truncate");
    expect(screen.getByText("5")).toBeTruthy();
  });
});
