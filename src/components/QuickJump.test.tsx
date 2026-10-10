import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickJump, type QuickJumpRow, type QuickJumpProps } from "./QuickJump";
import type { FileEntry } from "@/lib/types";

function entry(name: string, isDir = false): FileEntry {
  return {
    name,
    path: `/x/${name}`,
    is_dir: isDir,
    is_symlink: false,
    size: 1234,
    modified: 1_700_000_000_000,
    created: null,
    permissions: "rw-r--r--",
    extension: name.includes(".") ? name.split(".").pop()! : "",
  };
}

const rows: QuickJumpRow[] = [
  { entry: entry("main.rs"), positions: [0, 1] },
  { entry: entry("Documents", true), positions: [] },
];

function setup(overrides: Partial<QuickJumpProps> = {}) {
  const props: QuickJumpProps = {
    query: "ma",
    rows,
    activeIndex: 0,
    totalMatches: 2,
    onQueryChange: vi.fn(),
    onMove: vi.fn(),
    onConfirm: vi.fn(),
    onHover: vi.fn(),
    onActivate: vi.fn(),
    onCancel: vi.fn(),
    onOutsideDown: vi.fn(),
    ...overrides,
  };
  render(<QuickJump {...props} />);
  return props;
}

describe("QuickJump 玻璃浮层", () => {
  it("渲染结果、活动行与匹配计数", () => {
    setup();
    expect(document.querySelector('[data-quickjump]')).toBeTruthy();
    expect(document.querySelectorAll("[data-quickjump-row]")).toHaveLength(2);
    expect(document.querySelector('[data-quickjump-row="0"]')!.getAttribute("data-quickjump-active")).toBe("true");
    expect(screen.getByText("2 项匹配")).toBeInTheDocument();
  });

  it("只高亮匹配字符", () => {
    setup();
    // active 行 positions [0,1] → 'm','a' 两个加粗 span
    const marks = document.querySelectorAll("[data-quickjump] .font-semibold");
    expect(marks.length).toBe(2);
  });

  it("↑↓ 触发 onMove", () => {
    const p = setup();
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(p.onMove).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(p.onMove).toHaveBeenCalledWith(-1);
  });

  it("回车确认 / Esc 取消", () => {
    const p = setup();
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onConfirm).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("输入变更触发 onQueryChange", () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText("快速定位查询"), { target: { value: "mai" } });
    expect(p.onQueryChange).toHaveBeenCalledWith("mai");
  });

  it("鼠标悬停 / 点击行转发", () => {
    const p = setup();
    const r1 = document.querySelector('[data-quickjump-row="1"]')!;
    fireEvent.mouseEnter(r1);
    expect(p.onHover).toHaveBeenCalledWith(1);
    fireEvent.mouseDown(r1);
    expect(p.onActivate).toHaveBeenCalledWith(1);
  });

  it("点窗外（遮罩）触发 onOutsideDown", () => {
    const p = setup();
    fireEvent.mouseDown(document.querySelector("[data-quickjump-backdrop]")!);
    expect(p.onOutsideDown).toHaveBeenCalled();
  });

  it("零匹配显示空状态", () => {
    setup({ rows: [], totalMatches: 0 });
    expect(screen.getByText("无匹配项")).toBeInTheDocument();
    expect(screen.getByText("0 项匹配")).toBeInTheDocument();
  });

  it("activeIndex 变化时把活动行滚入可视区", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(
      <QuickJump
        query="ma" rows={rows} activeIndex={0} totalMatches={2}
        onQueryChange={vi.fn()} onMove={vi.fn()} onConfirm={vi.fn()}
        onHover={vi.fn()} onActivate={vi.fn()} onCancel={vi.fn()} onOutsideDown={vi.fn()}
      />,
    );
    spy.mockClear();
    rerender(
      <QuickJump
        query="ma" rows={rows} activeIndex={1} totalMatches={2}
        onQueryChange={vi.fn()} onMove={vi.fn()} onConfirm={vi.fn()}
        onHover={vi.fn()} onActivate={vi.fn()} onCancel={vi.fn()} onOutsideDown={vi.fn()}
      />,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
