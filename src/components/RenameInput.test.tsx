import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
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

describe("起手安定窗口（v0.42 焦点竞态加固：程序性抢焦不再瞬闪杀会话）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("窗口内的失焦（radix 关菜单回焦迟到抢焦）不收口，会话仍活着", () => {
    const spy = vi.spyOn(Date, "now");
    const { input, onCommit, onCancel } = mount(); // settleUntil = 挂载时刻 + 约1.1s
    spy.mockReturnValue(Date.now() + 400); // 仍在安定窗口内
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("窗口内失焦后重试聚焦重新拿回焦点，随后回车正常提交", () => {
    vi.useFakeTimers();
    const { input, onCommit, onCancel } = mount();
    fireEvent.focus(input);
    fireEvent.blur(input); // 安定窗口内 → 不收口
    expect(onCancel).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(130); // 120ms 档重试聚焦
    });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("renamed.rs");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("窗口外的失焦恢复原语义：未改名 = 取消", () => {
    const spy = vi.spyOn(Date, "now");
    const { input, onCommit, onCancel } = mount();
    spy.mockReturnValue(Date.now() + 5000); // 已出安定窗口
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("窗口外的失焦恢复原语义：改过名 = 提交", () => {
    const spy = vi.spyOn(Date, "now");
    const { input, onCommit, onCancel } = mount();
    spy.mockReturnValue(Date.now() + 5000);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("renamed.rs");
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("fitWidth 自适应宽度（图标网格长名）", () => {
  afterEach(() => vi.restoreAllMocks());

  /** jsdom 无 canvas 布局，stub 出确定性测宽：每字符 perChar px */
  const stubMeasure = (perChar: number) =>
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (s: string) => ({ width: s.length * perChar }),
    } as unknown as CanvasRenderingContext2D);

  it("按输入框实际计算字体测宽 + 内边距 12px + 边框 2px + 2px 余量", () => {
    stubMeasure(10); // “通用应用图标设计.png”12 字符 × 10 + 16 = 136
    render(
      <RenameInput
        initial="通用应用图标设计.png"
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        fitWidth={{ min: 72, max: 780 }}
      />,
    );
    expect(document.querySelector("input")!.style.width).toBe("136px");
  });

  it("超长名钳到上限，不产生横向滚动", () => {
    stubMeasure(10); // 100 字符 × 10 + 16 = 1016 → 780
    render(
      <RenameInput
        initial={"x".repeat(100)}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        fitWidth={{ min: 72, max: 780 }}
      />,
    );
    expect(document.querySelector("input")!.style.width).toBe("780px");
  });

  it("canvas 不可用（jsdom 裸环境）→ 宽度落到下限", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(
      <RenameInput
        initial="通用应用图标设计.png"
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        fitWidth={{ min: 72, max: 780 }}
      />,
    );
    expect(document.querySelector("input")!.style.width).toBe("72px");
  });

  it("不传 fitWidth：不接管宽度（详情/搜索行保持铺满原样）", () => {
    render(<RenameInput initial="main.rs" onCommit={vi.fn()} onCancel={vi.fn()} />);
    expect(document.querySelector("input")!.style.width).toBe("");
  });
});

describe("框内按下塌缩全选（WKWebView 选区拖动规避）", () => {
  /** jsdom 无 canvas 布局，stub 出确定性测宽：每字符 perChar px */
  const stubMeasure = (perChar: number) =>
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (s: string) => ({ width: s.length * perChar }),
    } as unknown as CanvasRenderingContext2D);

  it("起手全选 + 框内按下（选区内）→ preventDefault 接管，选区塌缩到按点", () => {
    stubMeasure(10); // clientX 25 → 偏移 2（2×10 ≤ 25 < 3×10）
    const { input } = mount();
    fireEvent.focus(input);
    act(() => input.setSelectionRange(0, 7)); // 起手 select() 的全选态
    fireEvent.mouseDown(input, { clientX: 25, button: 0 });
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    fireEvent.mouseUp(window); // 结束手势，摘掉临时监听
  });

  it("框内按住拖动：mousemove 从塌缩点手动扩展选区，mouseup 定格", () => {
    stubMeasure(10);
    const { input } = mount();
    fireEvent.focus(input);
    act(() => input.setSelectionRange(0, 7)); // 起手全选态
    fireEvent.mouseDown(input, { clientX: 25, button: 0 }); // 塌缩到 2
    fireEvent.mouseMove(window, { clientX: 60 }); // 拖到偏移 6
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);
    fireEvent.mouseUp(window);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);
  });

  it("光标态框内按下不干预（原生定位 + 拖动扩展本就正确）", () => {
    stubMeasure(10);
    const { input } = mount();
    fireEvent.focus(input);
    act(() => input.setSelectionRange(3, 3));
    fireEvent.mouseDown(input, { clientX: 25, button: 0 });
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
  });

  it("按在选区外不塌缩（WebKit 对选区外按下原生就是新选区）", () => {
    stubMeasure(10);
    const { input } = mount();
    fireEvent.focus(input);
    act(() => input.setSelectionRange(0, 2)); // 双击选中前两个字符的场景
    fireEvent.mouseDown(input, { clientX: 60 }); // 偏移 6，落在 (0,2) 之外
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
  });
});
