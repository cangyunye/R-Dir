import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { FileList, qjWindowStart, QJ_MAX_ROWS } from "./FileList";
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

  it("目录上回车 → 调 onOpen 进入目录并关窗", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "d" });
    fireEvent.change(screen.getByLabelText("快速定位查询"), { target: { value: "doc" } });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Enter" });
    expect(props.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Documents", is_dir: true }),
    );
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });

  it("文件上回车 → onSelect 定位并关窗", () => {
    const { props, body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "photo.png" }),
      false,
    );
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });

  it("Esc → 还原打开前的选中并关窗", () => {
    const { props, body } = renderList({ selection: ["/mock/dir/main.rs"] });
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Escape" });
    expect(props.onSelectRange).toHaveBeenCalledWith(["/mock/dir/main.rs"]);
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });

  it("打开前无选中时 Esc → onClearSelection", () => {
    const { props, body } = renderList({ selection: [] });
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "Escape" });
    expect(props.onClearSelection).toHaveBeenCalled();
  });

  it("点窗外（遮罩）→ 提交关闭且不还原", () => {
    const { props, body } = renderList({ selection: ["/mock/dir/main.rs"] });
    fireEvent.keyDown(body, { key: "p" });
    fireEvent.mouseDown(document.querySelector("[data-quickjump-backdrop]")!);
    expect(document.querySelector("[data-quickjump]")).toBeNull();
    expect(props.onSelectRange).not.toHaveBeenCalled();
  });

  it("退格删空 query → 显示全量条目", () => {
    const { body } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    const input = screen.getByLabelText("快速定位查询");
    fireEvent.change(input, { target: { value: "" } });
    expect(document.querySelector("[data-quickjump]")!.textContent).toContain("3 项匹配");
  });

  it("currentDir 变化 → 自动关窗", () => {
    const { body, rerender } = renderList();
    fireEvent.keyDown(body, { key: "p" });
    expect(document.querySelector("[data-quickjump]")).toBeTruthy();
    rerender(<FileList {...makeProps({ currentDir: "/mock/other" })} />);
    expect(document.querySelector("[data-quickjump]")).toBeNull();
  });

  it("qjWindowStart：小集合恒为 0，大集合让 active 居中且不越界", () => {
    expect(qjWindowStart(10, 5)).toBe(0);
    expect(qjWindowStart(QJ_MAX_ROWS, 100)).toBe(0);
    expect(qjWindowStart(300, 0)).toBe(0);
    expect(qjWindowStart(300, 150)).toBe(50);
    expect(qjWindowStart(300, 299)).toBe(100);
  });

  it("输入框失焦（点到别处）→ 提交关闭且不还原", () => {
    const { props, body } = renderList({ selection: ["/mock/dir/main.rs"] });
    fireEvent.keyDown(body, { key: "p" });
    expect(document.querySelector("[data-quickjump]")).toBeTruthy();
    fireEvent.blur(screen.getByLabelText("快速定位查询"));
    expect(document.querySelector("[data-quickjump]")).toBeNull();
    expect(props.onSelectRange).not.toHaveBeenCalled();
  });

  it("↑ 从首项环绕到末项", () => {
    const { props, body } = renderList();
    // seed "o" 匹配 Documents 与 photo.png（input 顺序：Documents 在前）
    fireEvent.keyDown(body, { key: "o" });
    const first = (props.onSelect as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    fireEvent.keyDown(screen.getByLabelText("快速定位查询"), { key: "ArrowUp" });
    const after = (props.onSelect as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(after).not.toEqual(first);
    expect(after).toMatchObject({ name: "photo.png" });
  });
});

describe("鼠标侧键（后退/前进）", () => {
  const paneOf = (container: HTMLElement) =>
    container.querySelector("[data-pane-id]") as HTMLElement;

  it("mouseup 侧键 3 → onBack；侧键 4 → onForward（不依赖 auxclick）", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const { container } = renderList({ onBack, onForward });
    const pane = paneOf(container);
    fireEvent.mouseDown(pane, { button: 3 });
    fireEvent.mouseUp(pane, { button: 3 });
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(pane, { button: 4 });
    fireEvent.mouseUp(pane, { button: 4 });
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it("左键 mouseup 不触发前进/后退", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const { container } = renderList({ onBack, onForward });
    const pane = paneOf(container);
    fireEvent.mouseDown(pane, { button: 0 });
    fireEvent.mouseUp(pane, { button: 0 });
    expect(onBack).not.toHaveBeenCalled();
    expect(onForward).not.toHaveBeenCalled();
  });

  it("同一手势 mouseup + auxclick 只触发一次（Chromium 会双发，避免前进两次）", () => {
    const onForward = vi.fn();
    const { container } = renderList({ onForward });
    const pane = paneOf(container);
    fireEvent.mouseDown(pane, { button: 4 });
    fireEvent.mouseUp(pane, { button: 4 });
    fireEvent(pane, new MouseEvent("auxclick", { button: 4, bubbles: true }));
    expect(onForward).toHaveBeenCalledTimes(1);
  });
});
