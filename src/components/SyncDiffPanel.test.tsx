import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  SyncDiffModal,
  SyncDiffStatusBar,
  type SyncDiffModalProps,
  type SyncDiffSummary,
} from "./SyncDiffPanel";
import type { DiffEntry } from "@/lib/types";
import type { SyncLink } from "@/lib/sync-link";

const side = (p: string, size: number) => ({ path: p, size, modified: 1, is_dir: false });

const entries: DiffEntry[] = [
  { name: "a.txt", is_dir: false, left: side("/L/a.txt", 10), right: null, status: "left-only" },
  { name: "b.txt", is_dir: false, left: null, right: side("/R/b.txt", 20), status: "right-only" },
  {
    name: "c.txt",
    is_dir: false,
    left: side("/L/c.txt", 30),
    right: side("/R/c.txt", 40),
    status: "different",
    reason: "size",
  },
  { name: "d.txt", is_dir: false, left: side("/L/d.txt", 50), right: side("/R/d.txt", 50), status: "same" },
];

const link: SyncLink = {
  tabId: 1,
  leftPaneId: 1,
  rightPaneId: 2,
  leftRoot: "/L",
  rightRoot: "/R",
};

const summary: SyncDiffSummary = {
  status: "done",
  total: 21,
  diffCount: 5,
  diverged: false,
  error: null,
};

function makeModalProps(over: Partial<SyncDiffModalProps> = {}): SyncDiffModalProps {
  return {
    open: true,
    link,
    leftPath: "/L",
    rightPath: "/R",
    alignment: { state: "aligned", rel: "", leftDir: "/L", rightDir: "/R" },
    status: "done",
    entries,
    error: null,
    canCreateMissing: true,
    onRealign: vi.fn(),
    onSwap: vi.fn(),
    onCreateMissing: vi.fn(),
    onReturnAlign: vi.fn(),
    onUnlink: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

function renderModal(over: Partial<SyncDiffModalProps> = {}) {
  const props = makeModalProps(over);
  render(<SyncDiffModal {...props} />);
  return props;
}

describe("SyncDiffStatusBar（状态栏摘要段）", () => {
  it("完成态显示总数与差异数,点击打开模态", () => {
    const onOpen = vi.fn();
    render(<SyncDiffStatusBar summary={summary} onOpen={onOpen} />);
    expect(screen.getByText("21 项 · 5 差异")).toBeTruthy();
    fireEvent.click(screen.getByTitle("查看同步比对结果（Ctrl+Shift+X）"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("一致时显示「一致」;未对齐为 warn 色调", () => {
    const { rerender } = render(
      <SyncDiffStatusBar summary={{ ...summary, diffCount: 0 }} onOpen={vi.fn()} />,
    );
    expect(screen.getByText("21 项 · 一致")).toBeTruthy();

    rerender(
      <SyncDiffStatusBar summary={{ ...summary, diverged: true }} onOpen={vi.fn()} />,
    );
    expect(screen.getByText("未对齐 · 21 项")).toBeTruthy();
    expect(
      document.querySelector('[data-sync-diff-status="warn"]'),
    ).not.toBeNull();
  });

  it("运行中与失败态", () => {
    const { rerender } = render(
      <SyncDiffStatusBar summary={{ ...summary, status: "running" }} onOpen={vi.fn()} />,
    );
    expect(screen.getByText("比对中…")).toBeTruthy();

    rerender(
      <SyncDiffStatusBar
        summary={{ ...summary, status: "error", error: "未连接" }}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("比对失败")).toBeTruthy();
    expect(
      document.querySelector('[data-sync-diff-status="error"]'),
    ).not.toBeNull();
  });
});

describe("SyncDiffModal（v0.18.2 结果模态）", () => {
  it("open=false 不渲染任何内容", () => {
    const { container } = render(<SyncDiffModal {...makeModalProps({ open: false })} />);
    expect(container.querySelector("[data-sync-diff-modal]")).toBeNull();
  });

  it("渲染条目、状态与对齐徽标;只看差异过滤 same", () => {
    renderModal();
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(screen.getByText("仅左侧")).toBeTruthy();
    expect(screen.getByText("已对齐")).toBeTruthy();
    fireEvent.click(screen.getByText("只看差异"));
    expect(screen.queryByText("d.txt")).toBeNull();
    expect(screen.getByText("a.txt")).toBeTruthy();
  });

  it("Esc 关闭;遮罩空白点击关闭", () => {
    const props = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    const overlay = document.querySelector("[data-sync-diff-modal]")!;
    fireEvent.mouseDown(overlay, { target: overlay });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("工具行:交换左右 / 重新对齐 / 断开链接", () => {
    const props = renderModal();
    fireEvent.click(screen.getByText("交换左右"));
    expect(props.onSwap).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("重新对齐"));
    expect(props.onRealign).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("断开链接"));
    expect(props.onUnlink).toHaveBeenCalledTimes(1);
  });

  it("未对齐横幅:三按钮可用", () => {
    const props = renderModal({
      alignment: {
        state: "diverged",
        layer: "a/b",
        missing: "c",
        missingSide: "left",
        leftDir: "/L/a/b",
        rightDir: "/R/a/b",
      },
    });
    expect(screen.getByText(/两侧不同层/)).toBeTruthy();
    fireEvent.click(screen.getByText("在对侧新建并进入"));
    expect(props.onCreateMissing).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("返回对齐"));
    expect(props.onReturnAlign).toHaveBeenCalledTimes(1);
  });

  it("对侧不可 mkdir 时隐藏「新建并进入」", () => {
    renderModal({
      alignment: {
        state: "diverged",
        layer: "",
        missing: "sub",
        missingSide: "left",
        leftDir: "/L",
        rightDir: "/R",
      },
      canCreateMissing: false,
    });
    expect(screen.queryByText("在对侧新建并进入")).toBeNull();
    expect(screen.getByText("返回对齐")).toBeTruthy();
  });

  it("一侧越界显示离开根目录提示", () => {
    renderModal({
      alignment: {
        state: "diverged",
        layer: "",
        outsideRoot: true,
        missingSide: "left",
        leftDir: "/L",
        rightDir: "/R",
      },
    });
    expect(screen.getByText(/一侧已离开链接根目录/)).toBeTruthy();
    expect(screen.queryByText("在对侧新建并进入")).toBeNull();
  });

  it("比对失败显示错误", () => {
    renderModal({ status: "error", entries: null, error: "未连接" });
    expect(screen.getByText(/比对失败/)).toBeTruthy();
  });

  it("v0.19 双击两侧同在的文件行直接同名比较（免基准）", () => {
    const onCompare = vi.fn();
    renderModal({ onCompare });
    fireEvent.doubleClick(screen.getByText("c.txt"));
    expect(onCompare).toHaveBeenCalledWith("/L/c.txt", "/R/c.txt", "c.txt");
    // 双击图标按钮同样触发（c.txt/d.txt 两行都有图标）
    fireEvent.click(screen.getAllByTitle("文本比较这两个文件")[0]);
    expect(onCompare).toHaveBeenCalledTimes(2);
  });

  it("v0.19 单侧条目与类型冲突行不可比较（无图标、双击无效）", () => {
    const onCompare = vi.fn();
    const dirEntries: DiffEntry[] = [
      {
        name: "only_right.txt",
        is_dir: false,
        left: null,
        right: side("/R/only_right.txt", 5),
        status: "right-only",
      },
      {
        name: "mixed",
        is_dir: true,
        left: side("/L/mixed", 0),
        right: { path: "/R/mixed", size: 0, modified: 1, is_dir: false },
        status: "different",
        reason: "type",
      },
    ];
    renderModal({ onCompare, entries: dirEntries });
    fireEvent.doubleClick(screen.getByText("only_right.txt"));
    fireEvent.doubleClick(screen.getByText("mixed"));
    expect(onCompare).not.toHaveBeenCalled();
    expect(screen.queryByTitle("文本比较这两个文件")).toBeNull();
  });
});
