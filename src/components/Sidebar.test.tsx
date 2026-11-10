import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { TAG_DEFS } from "@/lib/persist";
import type { QuickAccessItem, SftpServerView } from "@/lib/types";

const base = {
  quickAccess: [],
  volumes: [],
  currentPath: "/",
  onNavigate: vi.fn(),
  onMiddleOpen: vi.fn(),
  customQuick: [],
  onRemoveQuick: vi.fn(),
  tagCounts: {} as Record<string, number>,
  tags: TAG_DEFS,
  tagNames: {} as Record<string, string>,
  onRenameTag: vi.fn(),
  onAddTag: vi.fn(() => true),
  onTagsFullHint: vi.fn(),
  activeTagId: null as string | null,
  onSelectTag: vi.fn(),
  sftpServers: [],
  onSftpOpen: vi.fn(),
  onSftpDisconnect: vi.fn(),
  onSftpEdit: vi.fn(),
  onSftpRemove: vi.fn(),
  onSftpAdd: vi.fn(),
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

describe("远程临时目录固定入口（v0.44.0）", () => {
  const TEMP = "/tmp/r-dir-remote";

  it("提供路径与回调才渲染：label 复用「远程临时目录」词条，title 显路径，点击与中键透传", () => {
    const onOpenRemoteTemp = vi.fn();
    const onMiddleOpen = vi.fn();
    const { container } = render(
      <Sidebar {...base} remoteTempPath={TEMP} onOpenRemoteTemp={onOpenRemoteTemp} onMiddleOpen={onMiddleOpen} />,
    );
    expect(screen.getByText("远程临时目录")).toBeTruthy();
    const row = container.querySelector(`button[title="${TEMP}"]`) as HTMLElement;
    fireEvent.click(row);
    expect(onOpenRemoteTemp).toHaveBeenCalledWith(TEMP);
    // 中键新标签：React onAuxClick 委托自原生 auxclick 事件
    fireEvent(row, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(onMiddleOpen).toHaveBeenCalledWith(TEMP);
  });

  it("缺省不渲染；收缩态只留图标，title 为名称+路径", () => {
    const first = render(<Sidebar {...base} />);
    expect(first.container.querySelector(`button[title="${TEMP}"]`)).toBeNull();
    expect(first.container.textContent).not.toContain("远程临时目录");
    const onOpenRemoteTemp = vi.fn();
    const { container } = render(
      <Sidebar {...base} collapsed remoteTempPath={TEMP} onOpenRemoteTemp={onOpenRemoteTemp} />,
    );
    const rows = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.title === "远程临时目录\n/tmp/r-dir-remote",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).not.toContain("远程临时目录");
    fireEvent.click(rows[0]);
    expect(onOpenRemoteTemp).toHaveBeenCalledWith(TEMP);
  });
});

const server: SftpServerView = {
  id: "deploy@10.0.0.5:22",
  name: "生产机",
  host: "10.0.0.5",
  port: 22,
  user: "deploy",
  defaultRemote: "/home/deploy",
  group: "线上",
  auth: "key",
  hasSecret: false,
  connected: true,
};
const quick = [{ key: "home", path: "/Users/me" }] as QuickAccessItem[];

describe("Sidebar 收缩为图标栏（v0.44.0）", () => {
  it("默认展开：分区文字、服务器名与分组名可见，点服务器即连接", () => {
    const onSftpOpen = vi.fn();
    render(<Sidebar {...base} quickAccess={quick} sftpServers={[server]} onSftpOpen={onSftpOpen} />);
    expect(screen.getByText("快速访问")).toBeTruthy();
    expect(screen.getByText("主目录")).toBeTruthy();
    expect(screen.getByText("线上")).toBeTruthy();
    fireEvent.click(screen.getByText("生产机"));
    expect(onSftpOpen).toHaveBeenCalledWith(server);
  });

  it("收缩：文字不渲染，图标行仍可导航，title 补全名称与路径", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <Sidebar {...base} collapsed quickAccess={quick} onNavigate={onNavigate} />,
    );
    expect(screen.queryByText("快速访问")).toBeNull();
    expect(screen.queryByText("主目录")).toBeNull();
    expect(container.querySelector('[title="快速访问"]')).toBeTruthy();
    // title 含换行（名称 + 路径），CSS 属性选择器不便表达，直接比对属性值
    const home = Array.from(container.querySelectorAll("button")).find(
      (b) => b.title === "主目录\n/Users/me",
    ) as HTMLElement;
    expect(home).toBeTruthy();
    fireEvent.click(home);
    expect(onNavigate).toHaveBeenCalledWith("/Users/me");
    expect(container.querySelector("[data-sidebar]")?.className).toContain("w-12");
  });

  it("收缩：远程服务器只显示图标，不可操作，点击只弹展开提示", () => {
    const onSftpOpen = vi.fn();
    const hint = vi.fn();
    const { container } = render(
      <Sidebar
        {...base}
        collapsed
        collapseShortcut="Ctrl+E"
        sftpServers={[server]}
        onSftpOpen={onSftpOpen}
        onCollapsedServerHint={hint}
      />,
    );
    expect(screen.queryByText("生产机")).toBeNull();
    expect(screen.queryByText("线上")).toBeNull();
    const rows = container.querySelectorAll("[data-sidebar-server-collapsed]");
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("draggable")).toBeNull();
    expect(row.title).toBe("展开侧边栏后查看远程服务器（Ctrl+E）");
    fireEvent.click(row);
    expect(hint).toHaveBeenCalledTimes(1);
    expect(onSftpOpen).not.toHaveBeenCalled();
  });

  it("栏底收放按钮：提供回调才渲染，aria-expanded 反映状态，点击触发切换", () => {
    const { rerender } = render(<Sidebar {...base} />);
    expect(screen.queryByTestId("sidebar-collapse-toggle")).toBeNull();
    const toggle = vi.fn();
    rerender(<Sidebar {...base} onToggleCollapsed={toggle} collapseShortcut="Ctrl+E" />);
    const btn = screen.getByTestId("sidebar-collapse-toggle");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.title).toBe("收起侧边栏（Ctrl+E）");
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
    rerender(<Sidebar {...base} collapsed onToggleCollapsed={toggle} collapseShortcut="Ctrl+E" />);
    expect(screen.getByTestId("sidebar-collapse-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("sidebar-collapse-toggle").title).toBe("展开侧边栏（Ctrl+E）");
  });
});
