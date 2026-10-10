import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { FileList } from "./FileList";
import type { FileEntry } from "@/lib/types";

type FileListProps = ComponentProps<typeof FileList>;

function entry(name: string, isDir = false): FileEntry {
  return {
    name,
    path: `/mock/dir/${name}`,
    is_dir: isDir,
    is_symlink: false,
    size: 100,
    modified: 1_700_000_000_000,
    created: null,
    permissions: "rw-r--r--",
    extension: name.includes(".") ? name.split(".").pop()! : "",
  };
}

const ENTRIES: FileEntry[] = [
  entry("Documents", true),
  entry("main.rs"),
  entry("photo.png"),
];

function makeProps(overrides: Partial<FileListProps> = {}) {
  const noop = vi.fn();
  const props: FileListProps = {
    paneId: 1,
    entries: ENTRIES,
    sortKey: "name",
    sortDir: "asc",
    onSort: noop,
    selection: [],
    onSelect: vi.fn(),
    onSelectRange: vi.fn(),
    onClearSelection: vi.fn(),
    onOpen: vi.fn(),
    onMiddleOpen: noop,
    onCopy: noop,
    onCut: noop,
    onDelete: noop,
    onRename: noop,
    onCopyPath: noop,
    onRefresh: noop,
    onDropPaths: noop,
    onDragOverChange: noop,
    onNewFolder: noop,
    onNewFile: noop,
    onShareDir: noop,
    onPaste: noop,
    canPaste: false,
    onUndo: noop,
    onRedo: noop,
    canUndo: false,
    canRedo: false,
    onSelectAll: noop,
    onInvertSelection: noop,
    fileTags: {},
    tagNames: {},
    onRenameTag: noop,
    customQuick: [],
    onToggleTag: noop,
    onToggleQuick: noop,
    currentDir: "/mock/dir",
    pluginOpener: false,
    pluginTerminal: false,
    openers: [],
    shells: [],
    onOpenWith: noop,
    onOpenTerminal: noop,
    onAddCustomOpener: vi.fn(async () => {}),
    dragTarget: false,
    dragOp: "copy" as const,
    showHidden: false,
    showExtensions: true,
    renaming: null,
    onRenameCommit: noop,
    onRenameCancel: noop,
    isActive: true,
    onActivate: noop,
    zoom: 1,
    onZoomChange: noop,
    onBack: noop,
    onForward: noop,
    onCompress: noop,
    onProperties: noop,
    onPropertiesDir: noop,
    onDiff: noop,
    onSyncDiff: noop,
    compareBase: null,
    onSetCompareBase: noop,
    onCompareWithBase: noop,
    onComparePick: noop,
    onCompareSelected: noop,
    onViewPatch: noop,
    ...overrides,
  };
  return props;
}

function renderList(overrides: Partial<FileListProps> = {}) {
  const props = makeProps(overrides);
  const utils = render(<FileList {...props} />);
  const body = utils.container.querySelector("[data-filelist-body]") as HTMLElement;
  return { ...utils, props, body };
}

describe("FileList 快速定位集成", () => {
  it("键入可打印字符弹出玻璃窗并实时跟随首个命中", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    expect(document.querySelector("[data-quickjump]")).toBeTruthy();
    // "p" 命中 photo.png（唯一以 p 开头者）
    expect(props.onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "photo.png" }),
      false,
    );
  });

  it("输入变化过滤结果并重置到首项", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "m" });
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.change(input, { target: { value: "mai" } });
    expect(props.onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "main.rs" }),
      false,
    );
  });

  it("浮层打开时列表 body 不再吞键", () => {
    const { body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    const before = document.querySelectorAll("[data-quickjump]").length;
    fireEvent.keyDown(body, { key: "h" }); // 应被忽略（handleListKeyDown 早退）
    expect(document.querySelectorAll("[data-quickjump]").length).toBe(before);
    // 查询串未变（仍是 "p"，由浮层展示）
    expect(document.querySelector("[data-quickjump]")!.textContent).toContain("p");
  });
});
