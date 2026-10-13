import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { RenameInput } from "./RenameInput";

function mount(overrides: { onCommit?: (n: string) => void; onCancel?: () => void; initial?: string } = {}) {
  const onCommit = overrides.onCommit ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  const initial = overrides.initial ?? "main.rs";
  const utils = render(<RenameInput initial={initial} onCommit={onCommit} onCancel={onCancel} />);
  const input = document.querySelector("input")!;
  return { onCommit, onCancel, initial, input, ...utils };
}

describe("RenameInput 全局 mousedown 收口（点拖拽区/滚动条等不触发失焦的区域也能结束会话）", () => {
  it("外部 mousedown（无失焦跟随，模拟 Tauri 拖拽区 preventDefault）→ 改过名即提交", () => {
    const { input, onCommit, onCancel } = mount();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(onCommit).toHaveBeenCalledWith("renamed.rs");
    expect(onCancel).not.toHaveBeenCalled();
    // 该路径原生不会跟随 blur（焦点未动），会话已由 mousedown 结束
  });

  it("外部 mousedown 未改名 → 取消（对齐访达点空白关闭）", () => {
    const { input, onCommit, onCancel } = mount();
    fireEvent.focus(input);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("mousedown 落在输入框内部 → 不结束会话", () => {
    const { input, onCommit, onCancel } = mount();
    fireEvent.focus(input);
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("mousedown 结束后跟随的 blur 不重复提交（会话只收口一次）", () => {
    const { input, onCommit, onCancel } = mount();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("起手从未持焦（radix 焦点竞争窗口）→ 外部 mousedown 不结束，交给重试聚焦", () => {
    const { onCommit, onCancel } = mount();
    // 不 fireEvent.focus：模拟焦点竞争期间从未持焦
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("回车提交与全局收口共用一次守卫：Enter 后再 mousedown 不二次提交", () => {
    const { input, onCommit } = mount();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
