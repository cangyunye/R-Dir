import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PaneListMenu } from "./PaneListMenu";

const panes = [
  { tabId: 1, paneId: 1, title: "git", path: "F:\\pantheon\\git", active: true },
  { tabId: 1, paneId: 2, title: "home", path: "C:\\Users\\me", active: false },
];

describe("PaneListMenu（v0.15 修复溢出）", () => {
  it("点击按钮展开窗格列表，点击项回调 onActivate", () => {
    const onActivate = vi.fn();
    const { container } = render(<PaneListMenu panes={panes} onActivate={onActivate} />);
    expect(screen.queryByText("git")).toBeNull();
    fireEvent.click(container.querySelector("button")!);
    expect(screen.getByText("git")).toBeTruthy();
    fireEvent.click(screen.getByText("git"));
    expect(onActivate).toHaveBeenCalledWith(1, 1);
  });

  // 回归：旧实现用 Radix Portal + align=end，在根 zoom 下 Floating UI 视口
  // 与坐标不一致，下拉溢出窗口右侧；改为容器内绝对定位（非 Portal）。
  it("列表渲染在组件容器内（非 Portal，不会溢出窗口）", () => {
    const { container } = render(<PaneListMenu panes={panes} onActivate={() => {}} />);
    fireEvent.click(container.querySelector("button")!);
    const menu = screen.getByText("git").closest("div.absolute");
    expect(menu).toBeTruthy();
    expect(container.contains(menu!)).toBe(true);
  });

  it("空列表显示占位", () => {
    const { container } = render(<PaneListMenu panes={[]} onActivate={() => {}} />);
    fireEvent.click(container.querySelector("button")!);
    expect(screen.getByText("暂无窗格")).toBeTruthy();
  });

  it("Escape 关闭列表", () => {
    const { container } = render(<PaneListMenu panes={panes} onActivate={() => {}} />);
    fireEvent.click(container.querySelector("button")!);
    expect(screen.getByText("git")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("git")).toBeNull();
  });
});
