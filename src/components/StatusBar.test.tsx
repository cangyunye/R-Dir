import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";

const base = {
  path: "/mock/home",
  total: 3,
  selected: [] as string[],
  selectedSize: 0,
  showHidden: false,
  error: null as string | null,
  notice: null as string | null,
  onCancelDownload: vi.fn(),
  onSharePanel: vi.fn(),
};

describe("StatusBar 传输指示（v0.18.1 修复）", () => {
  it("进行中显示阶段与文件名 + 百分比", () => {
    render(
      <StatusBar
        {...base}
        transfer={{
          phase: "download",
          label: "a.md",
          doneFiles: 0,
          totalFiles: 1,
          fileDone: 5,
          fileTotal: 10,
          done: false,
        }}
      />,
    );
    expect(screen.getByText("下载中：a.md")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("固定文案 label 不重复拼接阶段名（不再出现「复制中：复制中…」）", () => {
    render(
      <StatusBar
        {...base}
        transfer={{
          phase: "copy",
          label: "复制中…",
          doneFiles: 0,
          totalFiles: 2,
          fileDone: 0,
          fileTotal: 0,
          done: false,
        }}
      />,
    );
    expect(screen.getByText("复制中…")).toBeTruthy();
  });

  it("done=true 显示「下载完成」（App 收到后 1.5s 清除指示）", () => {
    render(
      <StatusBar
        {...base}
        transfer={{
          phase: "download",
          label: "a.md",
          doneFiles: 1,
          totalFiles: 1,
          fileDone: 10,
          fileTotal: 10,
          done: true,
          id: "http://x/f",
        }}
      />,
    );
    expect(screen.getByText("下载完成")).toBeTruthy();
    // 完成后不再提供「停止下载」
    expect(screen.queryByText("停止")).toBeNull();
  });
});
