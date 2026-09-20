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
});
