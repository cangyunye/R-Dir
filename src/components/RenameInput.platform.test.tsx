import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { RenameInput } from "./RenameInput";

/**
 * 非 macOS（jsdom UA 无 Mac，isMac=false）下的门控行为：框内按下不接管——
 * 选区不被塌缩、mousedown 不被 preventDefault，全部交给引擎原生拖选
 * （Chromium/WebView2 原生本就正确；接管分支的 canvas 测宽在 zoom≠1 下错位，
 * 反而毁掉 F2 路径的拖选——v0.48 修复）。WKWebView 接管分支的用例见
 * RenameInput.test.tsx（vi.mock isMac=true）。
 */
describe("RenameInput 平台门控（非 macOS 不接管框内拖选）", () => {
  function mount(initial = "main.rs") {
    const utils = render(<RenameInput initial={initial} onCommit={vi.fn()} onCancel={vi.fn()} />);
    const input = document.querySelector("input")!;
    return { input, ...utils };
  }

  it("起手全选 + 框内按下（选区内）：不塌缩、不 preventDefault，交给原生", () => {
    const { input } = mount();
    fireEvent.focus(input);
    input.setSelectionRange(0, 7);
    const ev = new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, clientX: 25, button: 0,
    });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(7);
  });

  it("框内按住拖动：无手动接管监听介入，选区保持原样（原生扩展由真引擎负责）", () => {
    const { input, unmount } = mount();
    fireEvent.focus(input);
    input.setSelectionRange(0, 7);
    fireEvent.mouseDown(input, { clientX: 25, button: 0 });
    fireEvent.mouseMove(window, { clientX: 60 });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(7);
    fireEvent.mouseUp(window);
    unmount();
  });
});
