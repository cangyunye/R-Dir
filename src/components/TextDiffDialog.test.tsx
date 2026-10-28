import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { TextDiffDialog } from "./TextDiffDialog";
import type { TextDiffOutcome } from "@/lib/types";

const diffTextFiles = vi.fn();
const readTextFile = vi.fn();
const writeTextSide = vi.fn();

vi.mock("@/lib/api", () => ({
  diffTextFiles: (...a: unknown[]) => diffTextFiles(...a),
  readTextFile: (...a: unknown[]) => readTextFile(...a),
  writeTextSide: (...a: unknown[]) => writeTextSide(...a),
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
  writeTextSide.mockReset().mockResolvedValue(undefined);
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
    expect(diffTextFiles).toHaveBeenCalledWith("/L/a.log", "/R/a.log", "utf-8");
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

  it("v0.21.1 编码切换：下拉改 GBK 后两侧按新编码重新比较", async () => {
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("one").length).toBeGreaterThan(0));
    const select = screen.getByDisplayValue("UTF-8") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "gbk" } });
    await waitFor(() =>
      expect(diffTextFiles).toHaveBeenLastCalledWith("/L/a.log", "/R/a.log", "gbk"),
    );
  });

  it("v0.21.1 两侧行尾不同时显示换行符徽标", async () => {
    diffTextFiles.mockResolvedValue(
      outcome({
        left: {
          path: "/L/a.log",
          localPath: "/L/a.log",
          isTemp: false,
          lossy: false,
          bytes: 10,
          lines: 4,
          eol: "lf",
        },
        right: {
          path: "/R/a.log",
          localPath: "/R/a.log",
          isTemp: false,
          lossy: false,
          bytes: 12,
          lines: 4,
          eol: "crlf",
        },
      }),
    );
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/换行符/)).toBeTruthy());
  });

  it("v0.21.1 两侧行尾相同时不显示换行符徽标", async () => {
    diffTextFiles.mockResolvedValue(
      outcome({
        left: { path: "/L/a.log", localPath: "/L/a.log", isTemp: false, lossy: false, bytes: 10, lines: 4, eol: "lf" },
        right: { path: "/R/a.log", localPath: "/R/a.log", isTemp: false, lossy: false, bytes: 10, lines: 4, eol: "lf" },
      }),
    );
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("one").length).toBeGreaterThan(0));
    expect(screen.queryByText(/换行符/)).toBeNull();
  });

  it("v0.34 内容超宽时渲染左右两条联动横向滚动条", async () => {
    const { container } = render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll("[data-hscroll]")).toHaveLength(2),
    );
    expect(container.querySelector('[data-hscroll="left"]')).toBeTruthy();
    expect(container.querySelector('[data-hscroll="right"]')).toBeTruthy();
  });

  it("v0.34 双击单元格编辑右侧行：提交后 pair 改写、保存按钮激活", async () => {
    const { container } = render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
    const saveBtn = () => screen.getByText("保存修改") as HTMLButtonElement;
    expect(saveBtn().disabled).toBe(true);

    fireEvent.doubleClick(screen.getByText("new"));
    const input = (await waitFor(() => {
      const el = screen.getByDisplayValue("new");
      expect(el.tagName).toBe("INPUT");
      return el;
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("changed")).toBeTruthy());
    // 右侧改为与左侧不同的新值 → 仍是差异行，但已有未保存修改
    expect(saveBtn().disabled).toBe(false);
    // 脏标记出现在路径行
    expect(screen.getByTitle("右侧有未保存修改")).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it("v0.34 编辑成与左侧相同后整块变 eq，统计归零并显示相同徽标", async () => {
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
    fireEvent.doubleClick(screen.getByText("new"));
    const input = screen.getByDisplayValue("new");
    fireEvent.change(input, { target: { value: "old" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("两个文件相同")).toBeTruthy());
    expect(screen.getByText("+0")).toBeTruthy();
  });

  it("v0.34 中轴补丁：应用到右侧后右侧采用左侧行", async () => {
    const { container } = render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
    const btn = container.querySelector('[data-patch="l2r"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    // 右侧 new → old：old 两侧各渲染一次，全部行变 eq
    await waitFor(() => expect(screen.getAllByText("old")).toHaveLength(2));
    expect(screen.getByText("两个文件相同")).toBeTruthy();
    expect((screen.getByText("保存修改") as HTMLButtonElement).disabled).toBe(false);
  });

  it("v0.34 保存：writeTextSide 收到右侧全量行数组，保存后重新比较并清脏", async () => {
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
    fireEvent.doubleClick(screen.getByText("new"));
    const input = screen.getByDisplayValue("new");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect((screen.getByText("保存修改") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("保存修改"));
    await waitFor(() => expect(writeTextSide).toHaveBeenCalledTimes(1));
    expect(writeTextSide).toHaveBeenCalledWith(
      "/R/a.log",
      ["one", "two", "changed", "tail"],
      "lf",
      "utf-8",
    );
    // 保存成功后以服务端 diff 刷新（第 2 次比较），脏标记清除
    await waitFor(() => expect(diffTextFiles).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((screen.getByText("保存修改") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByText("已保存")).toBeTruthy();
  });

  it("v0.34 有未保存修改时关闭需确认，取消不打断、确认后关闭", async () => {
    const onClose = vi.fn();
    render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
    fireEvent.doubleClick(screen.getByText("new"));
    fireEvent.change(screen.getByDisplayValue("new"), { target: { value: "changed" } });
    fireEvent.keyDown(screen.getByDisplayValue("changed"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("changed")).toBeTruthy());

    fireEvent.click(screen.getByText("关闭"));
    expect(screen.getByText("有未保存的修改")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("取消"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("关闭"));
    fireEvent.click(screen.getByText("放弃并关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("v0.34 解码有损的一侧禁编辑：对应方向补丁按钮禁用", async () => {
    diffTextFiles.mockResolvedValue(
      outcome({
        right: {
          path: "/R/a.log",
          localPath: "/R/a.log",
          isTemp: false,
          lossy: true,
          bytes: 12,
          lines: 4,
        },
      }),
    );
    const { container } = render(
      <TextDiffDialog
        source={{ kind: "files", left: "/L/a.log", right: "/R/a.log" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
    // r2l（把右侧应用到左侧）目标侧是左侧，不受影响；l2r 目标侧右侧有损 → 禁用
    expect((container.querySelector('[data-patch="r2l"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-patch="l2r"]') as HTMLButtonElement).disabled).toBe(true);
    // 双击右侧单元格不进入编辑
    fireEvent.doubleClick(screen.getByText("new"));
    expect(screen.queryByDisplayValue("new")).toBeNull();
  });
});

