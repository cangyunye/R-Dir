import { describe, expect, it } from "vitest";
import {
  computeAlignment,
  marksFromOutcome,
  mirrorPath,
  relOf,
  type SyncLink,
} from "./sync-link";

const winLink = (l = "F:\\work\\left", r = "F:\\work\\right"): SyncLink => ({
  tabId: 1,
  leftPaneId: 1,
  rightPaneId: 2,
  leftRoot: l,
  rightRoot: r,
});

describe("relOf", () => {
  it("win 相对路径规范化为 /", () => {
    expect(relOf(winLink(), "left", "F:\\work\\left\\a\\b")).toBe("a/b");
    expect(relOf(winLink(), "left", "F:\\work\\left")).toBe("");
    expect(relOf(winLink(), "left", "F:\\other")).toBeNull();
  });

  it("sftp 相对路径", () => {
    const l = winLink("sftp://u@h:22/root", "sftp://u@h:22/root");
    expect(relOf(l, "right", "sftp://u@h:22/root/x")).toBe("x");
    expect(relOf(l, "right", "sftp://u@h:22/root")).toBe("");
  });
});

describe("mirrorPath", () => {
  it("rel 转换回对侧分隔符", () => {
    expect(mirrorPath(winLink(), "right", "a/b")).toBe("F:\\work\\right\\a\\b");
    const l = winLink("F:\\l", "sftp://u@h:22/root");
    expect(mirrorPath(l, "right", "a/b")).toBe("sftp://u@h:22/root/a/b");
    expect(mirrorPath(winLink(), "left", "")).toBe("F:\\work\\left");
  });
});

describe("computeAlignment", () => {
  it("对齐：比对目录即两侧当前路径", () => {
    const a = computeAlignment(winLink(), "F:\\work\\left\\a", "F:\\work\\right\\a");
    expect(a).toEqual({
      state: "aligned",
      rel: "a",
      leftDir: "F:\\work\\left\\a",
      rightDir: "F:\\work\\right\\a",
    });
  });

  it("对侧无目录：回退共同层并给出缺失段", () => {
    const a = computeAlignment(winLink(), "F:\\work\\left\\a\\b\\c", "F:\\work\\right\\a\\b");
    expect(a.state).toBe("diverged");
    if (a.state === "diverged") {
      expect(a.layer).toBe("a/b");
      expect(a.missing).toBe("c");
      expect(a.missingSide).toBe("left");
      expect(a.outsideRoot).toBeUndefined();
      expect(a.leftDir).toBe("F:\\work\\left\\a\\b");
      expect(a.rightDir).toBe("F:\\work\\right\\a\\b");
    }
  });

  it("跨协议：共同层目录按各自协议拼接", () => {
    const l = winLink("F:\\work\\left", "sftp://u@h:22/root");
    const a = computeAlignment(l, "F:\\work\\left\\sub", "sftp://u@h:22/root");
    expect(a.state).toBe("diverged");
    if (a.state === "diverged") {
      expect(a.layer).toBe("");
      expect(a.missing).toBe("sub");
      expect(a.missingSide).toBe("left");
      expect(a.rightDir).toBe("sftp://u@h:22/root");
    }
  });

  it("一侧越界：outsideRoot，回退两侧根", () => {
    const a = computeAlignment(winLink(), "F:\\elsewhere", "F:\\work\\right");
    expect(a.state).toBe("diverged");
    if (a.state === "diverged") {
      expect(a.outsideRoot).toBe(true);
      expect(a.layer).toBe("");
      expect(a.missingSide).toBe("left");
      expect(a.leftDir).toBe("F:\\work\\left");
      expect(a.rightDir).toBe("F:\\work\\right");
    }
  });

  it("一侧在根另一侧在子目录：missing 指向更深一侧", () => {
    const a = computeAlignment(winLink(), "F:\\work\\left", "F:\\work\\right\\docs");
    expect(a.state).toBe("diverged");
    if (a.state === "diverged") {
      expect(a.layer).toBe("");
      expect(a.missing).toBe("docs");
      expect(a.missingSide).toBe("right");
    }
  });
});

describe("marksFromOutcome", () => {
  it("same 不产条目；差异保留 reason 与两侧大小", () => {
    const side = (size: number) => ({ path: "p", size, modified: null, is_dir: false });
    const marks = marksFromOutcome([
      { name: "a", is_dir: false, left: side(5), right: null, status: "left-only" },
      {
        name: "b",
        is_dir: false,
        left: side(5),
        right: side(9),
        status: "different",
        reason: "size",
      },
      {
        name: "c",
        is_dir: false,
        left: side(1),
        right: side(1),
        status: "same",
      },
    ]);
    expect(marks["a"]).toEqual({ status: "left-only", leftSize: 5, rightSize: null });
    expect(marks["b"]).toEqual({
      status: "different",
      reason: "size",
      leftSize: 5,
      rightSize: 9,
    });
    expect(marks["c"]).toBeUndefined();
  });
});
