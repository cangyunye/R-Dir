import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppConfirmDialog } from "./AppConfirmDialog";

const base = { title: "目标已存在同名文件夹", message: "当前目录已存在同名文件夹：Docs" };

describe("AppConfirmDialog", () => {
  it("默认只有取消 / 确定两个按钮，不渲染第三选项", () => {
    render(
      <AppConfirmDialog req={base} onConfirm={vi.fn()} onCancel={vi.fn()} onAlt={vi.fn()} />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.getByText("确定")).toBeTruthy();
  });

  it("带 altLabel 时渲染第三按钮，点击只触发 onAlt（同名目录「覆盖」）", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onAlt = vi.fn();
    render(
      <AppConfirmDialog
        req={{ ...base, confirmLabel: "新增目录", altLabel: "覆盖" }}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onAlt={onAlt}
      />,
    );
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["取消", "覆盖", "新增目录"]);
    fireEvent.click(screen.getByText("覆盖"));
    expect(onAlt).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("缺少 onAlt 回调时即使给了 altLabel 也不渲染第三按钮", () => {
    render(
      <AppConfirmDialog
        req={{ ...base, altLabel: "覆盖" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByText("覆盖")).toBeNull();
  });

  it("Enter = 确认、Esc = 取消，第三按钮不改变键盘裁决", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onAlt = vi.fn();
    render(
      <AppConfirmDialog
        req={{ ...base, confirmLabel: "新增目录", altLabel: "覆盖" }}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onAlt={onAlt}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAlt).not.toHaveBeenCalled();
  });
});
