import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { DiffDialog } from "./DiffDialog";
import type { DiffEntry } from "@/lib/types";

const diffDirs = vi.fn();
const cancelDiff = vi.fn();
const copyEntries = vi.fn();
const deleteEntries = vi.fn();

vi.mock("@/lib/api", () => ({
  diffDirs: (...a: unknown[]) => diffDirs(...a),
  cancelDiff: (...a: unknown[]) => cancelDiff(...a),
  copyEntries: (...a: unknown[]) => copyEntries(...a),
  deleteEntries: (...a: unknown[]) => deleteEntries(...a),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const side = (p: string, size: number) => ({ path: p, size, modified: 1, is_dir: false });

const sample: DiffEntry[] = [
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
  {
    name: "d.txt",
    is_dir: false,
    left: side("/L/d.txt", 50),
    right: side("/R/d.txt", 50),
    status: "same",
  },
  {
    name: "e",
    is_dir: false,
    left: side("/L/e", 1),
    right: { path: "/R/e", size: 0, modified: 1, is_dir: true },
    status: "different",
    reason: "type",
  },
];

beforeEach(() => {
  diffDirs.mockReset().mockResolvedValue({ entries: sample, cancelled: false });
  cancelDiff.mockReset().mockResolvedValue(undefined);
  copyEntries.mockReset().mockResolvedValue([]);
  deleteEntries.mockReset().mockResolvedValue(undefined);
});

describe("DiffDialog（v0.18 差异比对）", () => {
  it("默认一层比对并渲染状态标签", async () => {
    render(<DiffDialog leftDir="/L" rightDir="/R" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    expect(screen.getByText("仅左侧")).toBeTruthy();
    expect(screen.getByText("仅右侧")).toBeTruthy();
    expect(screen.getByText("不同·大小")).toBeTruthy();
    expect(screen.getByText("不同·类型")).toBeTruthy();
    expect(diffDirs).toHaveBeenCalledWith(
      expect.any(String),
      "/L",
      "/R",
      1,
      expect.any(Boolean),
      expect.any(Number),
    );
  });

  it("切换到三层会以 level=3 重新比对", async () => {
    render(<DiffDialog leftDir="/L" rightDir="/R" onClose={() => {}} />);
    await waitFor(() => expect(diffDirs).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("三层·内容"));
    await waitFor(() =>
      expect(diffDirs).toHaveBeenLastCalledWith(
        expect.any(String),
        "/L",
        "/R",
        3,
        expect.any(Boolean),
        expect.any(Number),
      ),
    );
  });

  it("「只看差异」隐藏相同项", async () => {
    render(<DiffDialog leftDir="/L" rightDir="/R" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("d.txt")).toBeTruthy());
    fireEvent.click(screen.getByText("只看差异"));
    expect(screen.queryByText("d.txt")).toBeNull();
    expect(screen.getByText("a.txt")).toBeTruthy();
  });

  it("向右同步需二次确认后才执行", async () => {
    render(<DiffDialog leftDir="/L" rightDir="/R" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    fireEvent.click(screen.getByText("全选差异"));
    fireEvent.click(screen.getByRole("button", { name: /向右同步/ }));
    // 先弹确认，不立即执行
    expect(screen.getByText(/确认向右同步/)).toBeTruthy();
    expect(copyEntries).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认同步" }));
    await waitFor(() => expect(copyEntries).toHaveBeenCalledWith(["/L/a.txt"], "/R"));
    await waitFor(() => expect(deleteEntries).toHaveBeenCalledWith(["/R/b.txt"]));
    expect(copyEntries).toHaveBeenCalledWith(["/L/c.txt"], "/R");
    expect(copyEntries).toHaveBeenCalledWith(["/L/e"], "/R");
    // same 项不参与同步
    expect(copyEntries).not.toHaveBeenCalledWith(["/L/d.txt"], "/R");
  });

  it("向左同步：right-only 复制到左，left-only 删除左侧", async () => {
    render(<DiffDialog leftDir="/L" rightDir="/R" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    fireEvent.click(screen.getByText("全选差异"));
    fireEvent.click(screen.getByRole("button", { name: /向左同步/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认同步" }));
    await waitFor(() => expect(copyEntries).toHaveBeenCalledWith(["/R/b.txt"], "/L"));
    await waitFor(() => expect(deleteEntries).toHaveBeenCalledWith(["/L/a.txt"]));
  });
});
