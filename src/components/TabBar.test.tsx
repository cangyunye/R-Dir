import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "./TabBar";

const tabs = [
  { id: 1, title: "A" },
  { id: 2, title: "B" },
];

function setup(overrides: Partial<Parameters<typeof TabBar>[0]> = {}) {
  const props = {
    tabs,
    activeId: 1,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onReorder: vi.fn(),
    onRename: vi.fn(),
    ...overrides,
  };
  const { container } = render(<TabBar {...props} />);
  return { props, container };
}

describe("TabBar", () => {
  // 回归：以前 mousedown 只写 ref 不触发重渲染，全局 move/up 监听从未挂载 → 拖不动
  it("左键按住标签拖到另一个标签上触发重排", () => {
    const { props, container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    expect(rows.length).toBe(2);
    const second = rows[1] as HTMLElement;
    // jsdom 未实现 elementFromPoint，桩为返回第二个标签
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint =
      () => second;

    fireEvent.mouseDown(rows[0], { button: 0, clientX: 10 });
    fireEvent.mouseMove(window, { clientX: 60 });
    fireEvent.mouseUp(window);

    expect(props.onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("未超过阈值不触发重排（普通点击）", () => {
    const { props, container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint =
      () => rows[1] as HTMLElement;
    fireEvent.mouseDown(rows[0], { button: 0, clientX: 10 });
    fireEvent.mouseMove(window, { clientX: 12 });
    fireEvent.mouseUp(window);
    expect(props.onReorder).not.toHaveBeenCalled();
  });

  it("点击标签触发 onSelect", () => {
    const { props } = setup();
    fireEvent.click(screen.getByText("B"));
    expect(props.onSelect).toHaveBeenCalledWith(2);
  });

  it("双击标签进入内联重命名并回车提交", () => {
    const { props } = setup();
    fireEvent.doubleClick(screen.getByText("A"));
    const input = screen.getByDisplayValue("A");
    fireEvent.change(input, { target: { value: "工作" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith(1, "工作");
  });

  it("重命名输入框清空后回车 → 传空串（恢复自动标题）", () => {
    const { props } = setup();
    fireEvent.doubleClick(screen.getByText("A"));
    const input = screen.getByDisplayValue("A");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith(1, "");
  });

  // ---- v0.15 右键标签菜单：关闭 / 重命名 / 移动到最右边 ----
  it("右键标签弹出菜单，含三项操作", () => {
    const { container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    fireEvent.contextMenu(rows[0]);
    expect(screen.getByText("关闭标签")).toBeTruthy();
    expect(screen.getByText("重命名")).toBeTruthy();
    expect(screen.getByText("移动到最右边")).toBeTruthy();
  });

  it("菜单「关闭标签」触发 onClose", () => {
    const { props, container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    fireEvent.contextMenu(rows[0]);
    fireEvent.click(screen.getByText("关闭标签"));
    expect(props.onClose).toHaveBeenCalledWith(1);
  });

  it("菜单「重命名」进入内联输入", () => {
    const { container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    fireEvent.contextMenu(rows[0]);
    fireEvent.click(screen.getByText("重命名"));
    expect(screen.getByDisplayValue("A")).toBeTruthy();
  });

  it("菜单「移动到最右边」触发 onReorder(idx, last)", () => {
    const { props, container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    fireEvent.contextMenu(rows[0]);
    fireEvent.click(screen.getByText("移动到最右边"));
    expect(props.onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("已在最右边时「移动到最右边」禁用", () => {
    const { container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    fireEvent.contextMenu(rows[1]);
    const item = screen.getByText("移动到最右边") as HTMLButtonElement;
    expect(item.disabled).toBe(true);
  });

  it("仅剩一个标签时「关闭标签」禁用", () => {
    const { container } = setup({ tabs: [{ id: 1, title: "A" }] });
    const rows = container.querySelectorAll("[data-tab-idx]");
    fireEvent.contextMenu(rows[0]);
    const item = screen.getByText("关闭标签") as HTMLButtonElement;
    expect(item.disabled).toBe(true);
  });

  it("右键菜单渲染在标签栏容器内（非 Portal，避免根 zoom 溢出窗口）", () => {
    const { container } = setup();
    const rows = container.querySelectorAll("[data-tab-idx]");
    fireEvent.contextMenu(rows[0]);
    const menu = screen.getByText("关闭标签").closest("div.absolute");
    expect(menu).toBeTruthy();
    expect(container.contains(menu!)).toBe(true);
  });
});
