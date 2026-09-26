import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandPalette, type CommandItem } from "./CommandPalette";

const items: CommandItem[] = [
  { id: "copy", label: "复制", group: "文件操作", binding: "mod+c" },
  { id: "paste", label: "粘贴", group: "文件操作", binding: "mod+v" },
  {
    id: "openSettings",
    label: "打开设置（快捷键一览）",
    group: "视图 / 全局",
    binding: "mod+,",
  },
];

function setup() {
  const onRun = vi.fn();
  const onOpenChange = vi.fn();
  render(<CommandPalette open onOpenChange={onOpenChange} items={items} onRun={onRun} />);
  const input = screen.getByPlaceholderText(/搜索命令/);
  return { onRun, onOpenChange, input };
}

describe("CommandPalette 命令面板", () => {
  it("未过滤时列出全部命令并按组渲染", () => {
    setup();
    expect(screen.getByText("复制")).toBeInTheDocument();
    expect(screen.getByText("粘贴")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "文件操作" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "视图 / 全局" })).toBeInTheDocument();
  });

  it("输入关键字过滤列表", () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/搜索命令/), {
      target: { value: "粘贴" },
    });
    expect(screen.getByText("粘贴")).toBeInTheDocument();
    expect(screen.queryByText("复制")).not.toBeInTheDocument();
    expect(screen.queryByText("打开设置（快捷键一览）")).not.toBeInTheDocument();
  });

  it("无匹配时显示空状态", () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/搜索命令/), {
      target: { value: "不存在的命令" },
    });
    expect(screen.getByText("无匹配命令")).toBeInTheDocument();
  });

  it("↑↓ 移动选中项，回车执行并关闭面板", () => {
    const { onRun, onOpenChange, input } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledWith("paste");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("点击条目直接执行", () => {
    const { onRun, onOpenChange } = setup();
    fireEvent.click(screen.getByText("打开设置（快捷键一览）"));
    expect(onRun).toHaveBeenCalledWith("openSettings");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
