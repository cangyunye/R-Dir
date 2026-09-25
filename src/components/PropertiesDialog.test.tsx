import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PropertiesDialog, RollingNumber } from "./PropertiesDialog";
import type { FileEntry } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  computeSize: vi.fn(async () => ({ bytes: 4096, files: 3, dirs: 2 })),
  cancelSize: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const dir: FileEntry = {
  name: "Documents",
  path: "/mock/home/Documents",
  is_dir: true,
  is_symlink: false,
  size: 0,
  modified: null,
  created: null,
  permissions: "drwxr-xr-x",
  extension: "",
};

const file: FileEntry = {
  name: "Notes.txt",
  path: "/mock/home/Notes.txt",
  is_dir: false,
  is_symlink: false,
  size: 1234,
  modified: null,
  created: null,
  permissions: "-rw-r--r--",
  extension: "txt",
};

describe("RollingNumber（老虎机滚动数字）", () => {
  it("通过 data-value 暴露完整数值（供测试/无障碍）", () => {
    const { container } = render(<RollingNumber value={1234567} />);
    const el = container.querySelector("[data-value]");
    expect(el?.getAttribute("data-value")).toBe("1234567");
    expect(el?.getAttribute("aria-label")).toBe("1,234,567");
  });

  it("负数按 0 处理", () => {
    const { container } = render(<RollingNumber value={-5} />);
    expect(container.querySelector("[data-value]")?.getAttribute("data-value")).toBe("0");
  });
});

describe("PropertiesDialog（v0.16 属性）", () => {
  it("单目录：显示名称/类型并异步统计大小与数量", async () => {
    render(<PropertiesDialog entries={[dir]} onClose={() => {}} />);
    expect(screen.getByText("属性")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("文件夹")).toBeTruthy();
    // computeSize mock 返回 bytes=4096 → formatSize = 4.0K；files/dirs = 3/2
    await waitFor(() => expect(screen.getByText("（4.0K）")).toBeTruthy());
    const values = Array.from(
      document.querySelectorAll("[data-value]"),
    ).map((el) => el.getAttribute("data-value"));
    expect(values).toContain("4096");
    expect(values).toContain("3");
    expect(values).toContain("2");
  });

  it("单文件：初始即显示已知大小", () => {
    render(<PropertiesDialog entries={[file]} onClose={() => {}} />);
    expect(screen.getByText("Notes.txt")).toBeTruthy();
    const values = Array.from(
      document.querySelectorAll("[data-value]"),
    ).map((el) => el.getAttribute("data-value"));
    // 初始 seed = 文件自身大小 1234
    expect(values).toContain("1234");
  });

  it("多选：标题为「N 个项目」", () => {
    render(<PropertiesDialog entries={[dir, file]} onClose={() => {}} />);
    expect(screen.getByText("2 个项目")).toBeTruthy();
  });
});
