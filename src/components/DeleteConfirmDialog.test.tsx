import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import type { FileEntry } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  computeSize: vi.fn(async () => ({ bytes: 4096, files: 3, dirs: 2 })),
  cancelSize: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const file: FileEntry = {
  name: "Notes.txt",
  path: "/mock/home/Notes.txt",
  is_dir: false,
  is_symlink: false,
  size: 10,
  modified: 1_700_000_000_000,
  created: null,
  permissions: "rw-r--r--",
  extension: "txt",
};

/** 模拟全局键位分发器：挂在 window 冒泡阶段（与 App 的 keymap 监听同位） */
function bubbleSpy() {
  const seen: string[] = [];
  const fn = (e: KeyboardEvent) => seen.push(e.key);
  window.addEventListener("keydown", fn);
  return { seen, cleanup: () => window.removeEventListener("keydown", fn) };
}

describe("DeleteConfirmDialog 弹窗级键位（capture 拦截）", () => {
  it("Enter 确认删除一次，且不冒泡到全局键位（否则同一回车会打开选中文件）", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const global = bubbleSpy();
    render(
      <DeleteConfirmDialog entries={[file]} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "删除" }), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(global.seen).toEqual([]);

    global.cleanup();
  });

  it("Esc 取消，同样不冒泡到全局键位", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const global = bubbleSpy();
    render(
      <DeleteConfirmDialog entries={[file]} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "取消" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(global.seen).toEqual([]);

    global.cleanup();
  });
});
