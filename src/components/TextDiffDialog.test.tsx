import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { TextDiffDialog } from "./TextDiffDialog";
import type { TextDiffOutcome } from "@/lib/types";

const diffTextFiles = vi.fn();
const readTextFile = vi.fn();

vi.mock("@/lib/api", () => ({
  diffTextFiles: (...a: unknown[]) => diffTextFiles(...a),
  readTextFile: (...a: unknown[]) => readTextFile(...a),
}));

const outcome = (over: Partial<TextDiffOutcome> = {}): TextDiffOutcome => ({
  left: { path: "/L/a.log", localPath: "/L/a.log", isTemp: false, lossy: false, bytes: 10, lines: 4 },
  right: { path: "/R/a.log", localPath: "/R/a.log", isTemp: false, lossy: false, bytes: 12, lines: 4 },
  segments: [
    { kind: "eq", leftStart: 1, rightStart: 1, lines: ["one", "two"] },
    { kind: "del", leftStart: 3, rightStart: null, lines: ["old"] },
    { kind: "add", leftStart: null, rightStart: 3, lines: ["new"] },
    { kind: "eq", leftStart: 4, rightStart: 4, lines: ["tail"] },
  ],
  additions: 1,
  deletions: 1,
  same: false,
  coarse: false,
  ...over,
});

beforeEach(() => {
  diffTextFiles.mockReset().mockResolvedValue(outcome());
  readTextFile.mockReset();
});

describe("TextDiffDialog（v0.19 文本比较）", () => {
  it("文件模式：渲染左右行与配对着色行", async () => {
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("old")).toBeTruthy());
    expect(screen.getByText("new")).toBeTruthy();
    // eq 行左右两侧各渲染一次
    expect(screen.getAllByText("one")).toHaveLength(2);
    expect(screen.getAllByText("tail")).toHaveLength(2);
    expect(diffTextFiles).toHaveBeenCalledWith("/L/a.log", "/R/a.log");
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
  });

  it("相同文件显示「两个文件相同」徽标", async () => {
    const eqOnly = outcome({
      segments: [{ kind: "eq", leftStart: 1, rightStart: 1, lines: ["a"] }],
      additions: 0,
      deletions: 0,
      same: true,
    });
    diffTextFiles.mockResolvedValue(eqOnly);
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("两个文件相同")).toBeTruthy());
  });

  it("patchText 模式：解析 git diff 并渲染文件段", async () => {
    const patch = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      " ctx",
      "-old",
      "+new",
    ].join("\n");
    render(
      <TextDiffDialog source={{ kind: "patchText", text: patch }} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getAllByText("src/app.ts").length).toBeGreaterThan(0));
    expect(screen.getAllByText("src/app.ts")).toHaveLength(2); // 左右文件头
    expect(screen.getByText("old")).toBeTruthy();
    expect(diffTextFiles).not.toHaveBeenCalled();
  });

  it("patchText 无 diff 内容时显示错误提示", async () => {
    render(
      <TextDiffDialog source={{ kind: "patchText", text: "没有 diff 的日志" }} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/未识别出 diff 内容/)).toBeTruthy(),
    );
  });

  it("只看差异：隐藏相同行", async () => {
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("one").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("只看差异"));
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.queryByText("tail")).toBeNull();
    expect(screen.getByText("old")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
  });

  it("弹层尺寸按根 zoom 折算（根 zoom 下 vh/vw 会被放大,不折算则标题栏被顶出视口）", async () => {
    const { container } = render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("one").length).toBeGreaterThan(0));
    const box = container.querySelector(".rounded-lg") as HTMLElement;
    expect(box.style.height).toContain("var(--rdir-zoom");
    expect(box.style.width).toContain("var(--rdir-zoom");
  });
});

