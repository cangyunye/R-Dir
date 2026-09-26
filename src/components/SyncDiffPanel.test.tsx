import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SyncDiffPanel, type SyncDiffPanelProps } from "./SyncDiffPanel";
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

function renderPanel(over: Partial<SyncDiffPanelProps> = {}) {
  const props: SyncDiffPanelProps = {
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
    ...over,
  };
  render(<SyncDiffPanel {...props} />);
  return props;
}

describe("SyncDiffPanel（v0.18 同步比对面板）", () => {
  it("渲染条目、状态标签与总数", () => {
    renderPanel();
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(screen.getByText("仅左侧")).toBeTruthy();
    expect(screen.getByText("仅右侧")).toBeTruthy();
    expect(screen.getByText("4 项")).toBeTruthy();
    expect(screen.getByText("已对齐")).toBeTruthy();
  });

  it("只看差异过滤掉 same 条目", () => {
    renderPanel();
    expect(screen.getByText("d.txt")).toBeTruthy();
    fireEvent.click(screen.getByText("只看差异"));
    expect(screen.queryByText("d.txt")).toBeNull();
    expect(screen.getByText("a.txt")).toBeTruthy();
  });

  it("未对齐显示横幅与三个操作按钮", () => {
    const props = renderPanel({
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
    fireEvent.click(screen.getByText("断开链接"));
    expect(props.onUnlink).toHaveBeenCalled();
  });

  it("对侧不支持 mkdir 时隐藏「新建并进入」", () => {
    renderPanel({
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
    renderPanel({
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

  it("折叠后仅存头部", () => {
    renderPanel();
    fireEvent.click(screen.getByTitle("折叠面板"));
    expect(screen.queryByText("a.txt")).toBeNull();
    expect(screen.getByText("同步比对")).toBeTruthy();
  });

  it("比对失败显示错误", () => {
    renderPanel({ status: "error", entries: null, error: "未连接" });
    expect(screen.getByText(/比对失败/)).toBeTruthy();
  });
});
