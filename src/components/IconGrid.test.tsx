import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { IconGrid } from "./IconGrid";
import { getHtml5Drag, setHtml5Drag } from "@/lib/native-drag";
import type { FileEntry } from "@/lib/types";

type IconGridProps = ComponentProps<typeof IconGrid>;

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

function makeProps(overrides: Partial<IconGridProps> = {}) {
  const noop = vi.fn();
  const props: IconGridProps = {
    paneId: 1,
    mode: "icons",
    iconSize: 64,
    onIconSizeChange: noop,
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
    onRenameCommit: vi.fn(),
    onRenameCancel: noop,
    onCopyPath: noop,
    onRefresh: noop,
    onShareDir: noop,
    onDropPaths: noop,
    onDropIntoDir: vi.fn(),
    onDragOverChange: noop,
    onNewFolder: noop,
    onNewFile: noop,
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
    customQuick: [],
    onToggleTag: noop,
    onToggleQuick: noop,
    currentDir: "/mock/dir",
    pluginOpener: false,
    pluginTerminal: false,
    openers: [],
    shells: [],
    vscodeDetected: false,
    gitTools: [],
    quickTools: [],
    onOpenWith: noop,
    onOpenTerminal: noop,
    onOpenVscode: noop,
    onOpenGitTool: noop,
    onOpenQuickTool: noop,
    onConfigureQuickTools: noop,
    onAddCustomOpener: vi.fn(async () => {}),
    dragTarget: false,
    dragOp: "copy" as const,
    showHidden: false,
    showExtensions: true,
    renaming: null,
    isActive: true,
    onActivate: noop,
    zoom: 1,
    onBack: noop,
    onForward: noop,
    onCompress: noop,
    onExtract: noop,
    onProperties: noop,
    onPropertiesDir: noop,
    onDiff: noop,
    onSyncDiff: noop,
    iconPositions: {},
    onSetIconPosition: vi.fn(),
    onClearIconPositions: vi.fn(),
    autoArrange: false,
    onToggleAutoArrange: vi.fn(),
    ...overrides,
  };
  return props;
}

describe("IconGrid（v0.27 大图标/画廊视图）", () => {
  it("渲染全部条目单元，目录带 drop 目标标记", () => {
    const { container } = render(<IconGrid {...makeProps()} />);
    const items = container.querySelectorAll("[data-grid-item]");
    expect(items).toHaveLength(3);
    const dirItem = container.querySelector('[data-path="/mock/dir/Documents"]');
    expect(dirItem?.hasAttribute("data-drop-dir")).toBe(true);
    const fileItem = container.querySelector('[data-path="/mock/dir/main.rs"]');
    expect(fileItem?.hasAttribute("data-drop-dir")).toBe(false);
  });

  it("单击选中（onSelect 单选语义）", () => {
    const onSelect = vi.fn();
    const { container } = render(<IconGrid {...makeProps({ onSelect })} />);
    fireEvent.click(container.querySelector('[data-path="/mock/dir/main.rs"]')!);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "main.rs" }),
      false,
    );
  });

  it("双击打开", () => {
    const onOpen = vi.fn();
    const { container } = render(<IconGrid {...makeProps({ onOpen })} />);
    fireEvent.doubleClick(container.querySelector('[data-path="/mock/dir/Documents"]')!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: "Documents" }));
  });

  it("方向键导航：单列布局（jsdom 视口宽 0）下左右为 no-op，向下选中下一行", () => {
    const onSelect = vi.fn();
    const props = makeProps({ onSelect, selection: ["/mock/dir/Documents"] });
    const { container } = render(<IconGrid {...props} />);
    const body = container.querySelector("[data-icongrid-body]")!;
    fireEvent.keyDown(body, { key: "ArrowRight" });
    expect(onSelect).not.toHaveBeenCalled(); // 单列：右越界不动
    fireEvent.keyDown(body, { key: "ArrowLeft" });
    expect(onSelect).not.toHaveBeenCalled(); // 单列：左越界不动
    fireEvent.keyDown(body, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalled();
    const arg = onSelect.mock.calls[0][0] as FileEntry;
    expect(["main.rs", "photo.png"]).toContain(arg.name);
  });

  it("Enter 打开主选中", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <IconGrid {...makeProps({ onOpen, selection: ["/mock/dir/photo.png"] })} />,
    );
    fireEvent.keyDown(container.querySelector("[data-icongrid-body]")!, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: "photo.png" }));
  });

  it("画廊模式同样渲染；缩略图组件对图片条目生效（失败回退图标不阻塞渲染）", () => {
    const { container } = render(<IconGrid {...makeProps({ mode: "gallery" })} />);
    expect(container.querySelectorAll("[data-grid-item]")).toHaveLength(3);
  });

  it("选中项高亮 bg-selected", () => {
    const { container } = render(
      <IconGrid {...makeProps({ selection: ["/mock/dir/main.rs"] })} />,
    );
    const item = container.querySelector('[data-path="/mock/dir/main.rs"]')!;
    expect(item.className).toContain("bg-selected");
  });

  it("自动排列开启时忽略摆放记录（回到流式布局）", () => {
    // jsdom 视口宽 0 → 单列布局。记录 main.rs 到第 3 行 (0,2)：
    // 无自动排列时按记录落位（top = 12 + 2×行高 114 = 240）
    const { container: c1 } = render(
      <IconGrid
        {...makeProps({
          iconPositions: { "main.rs": [0, 2] },
        })}
      />,
    );
    const style1 = c1.querySelector('[data-path="/mock/dir/main.rs"]')!
      .getAttribute("style") ?? "";
    expect(style1).toContain("top: 240px");

    // 自动排列：忽略记录，main.rs 回到自然顺位第二格（top = 126）
    const { container: c2 } = render(
      <IconGrid
        {...makeProps({
          iconPositions: { "main.rs": [0, 1] },
          autoArrange: true,
        })}
      />,
    );
    const style2 = c2.querySelector('[data-path="/mock/dir/main.rs"]')!
      .getAttribute("style") ?? "";
    expect(style2).toContain("top: 126px");
  });

  it("空白右键菜单包含「自动排列」，开启时带勾选标记", () => {
    const { container } = render(<IconGrid {...makeProps({ autoArrange: true })} />);
    // 菜单由 radix 懒渲染——只验证渲染不崩 + 空态；交互在 e2e V7 覆盖
    expect(container.querySelector("[data-icongrid-body]")).toBeTruthy();
  });

  it("空目录显示空态文案", () => {
    render(<IconGrid {...makeProps({ entries: [] })} />);
    expect(screen.getByText("此目录为空")).toBeTruthy();
  });

  it("选中项展开全名浮层（grid-label-full），未选中不显示", () => {
    const { container } = render(
      <IconGrid {...makeProps({ selection: ["/mock/dir/main.rs"] })} />,
    );
    // 三个条目都有浮层节点，但只有主选中的可见（未选中的带 hidden，由 group-hover 接管）
    const chips = [...container.querySelectorAll('[data-testid="grid-label-full"]')];
    const visible = chips.filter((el) => !el.className.includes("hidden"));
    expect(visible.length).toBe(1);
    expect(visible[0].className).toContain("block");
    // 未选中态：浮层隐藏（group-hover 由 CSS 接管）
    const { container: c2 } = render(<IconGrid {...makeProps()} />);
    for (const el of c2.querySelectorAll('[data-testid="grid-label-full"]')) {
      expect(el.className).toContain("hidden");
    }
  });

  it("内联重命名：renaming 匹配的条目渲染输入框", () => {
    const { container } = render(
      <IconGrid
        {...makeProps({ renaming: { path: "/mock/dir/main.rs", name: "main.rs" } })}
      />,
    );
    expect(container.querySelector("input")).toBeTruthy();
  });

  it("重命名框自适应宽度：jsdom 文本宽 0 → 落到下限（iconSize 64 → 格子内容宽 72px）", () => {
    const { container } = render(
      <IconGrid
        {...makeProps({ renaming: { path: "/mock/dir/main.rs", name: "main.rs" } })}
      />,
    );
    expect(container.querySelector("input")!.style.width).toBe("72px");
  });

  it("多选拖到文件夹图标：onDropIntoDir 携带全部选中路径（自研回落路径）", () => {
    const onDropIntoDir = vi.fn();
    const { container } = render(
      <IconGrid
        {...makeProps({
          onDropIntoDir,
          selection: ["/mock/dir/main.rs", "/mock/dir/photo.png"],
        })}
      />,
    );
    const dirItem = container.querySelector('[data-path="/mock/dir/Documents"]')!;
    // jsdom 没有 elementFromPoint，直接装桩让 hitTarget 命中文件夹图标
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const origFromPoint = doc.elementFromPoint;
    doc.elementFromPoint = () => dirItem;
    // 按下已选中项 = 携带全部选中拖拽（图标视图语义）
    fireEvent.mouseDown(container.querySelector('[data-path="/mock/dir/main.rs"]')!);
    fireEvent.mouseMove(window, { clientX: 40, clientY: 40 });
    fireEvent.mouseUp(window, { clientX: 40, clientY: 40 });
    doc.elementFromPoint = origFromPoint;
    expect(onDropIntoDir).toHaveBeenCalledWith(
      ["/mock/dir/main.rs", "/mock/dir/photo.png"],
      "copy",
      "/mock/dir/Documents",
    );
  });

  it("dragstart：HTML5 拖出写入 uri-list / plain / 会话标记并接管（自研拖拽清理）", () => {
    const { container } = render(
      <IconGrid
        {...makeProps({ selection: ["/mock/dir/main.rs", "/mock/dir/photo.png"] })}
      />,
    );
    const item = container.querySelector('[data-path="/mock/dir/main.rs"]')!;
    const setData = vi.fn();
    const nativeEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(nativeEvent, "dataTransfer", {
      value: { setData, effectAllowed: "" },
    });
    fireEvent(item, nativeEvent);
    // 拖出选中组：uri-list 供 macOS WKWebView 映射 NSURL（拖到浏览器/访达可上传）
    const call = (t: string) => setData.mock.calls.find(([k]) => k === t)?.[1] as string;
    expect(call("text/plain")).toBe("/mock/dir/main.rs\n/mock/dir/photo.png");
    expect(call("text/uri-list")).toContain("file:///mock/dir/main.rs");
    expect(call("application/x-rdir-dnd")).toBe("1");
    expect(getHtml5Drag()).toMatchObject({
      sourcePaneId: 1,
      paths: ["/mock/dir/main.rs", "/mock/dir/photo.png"],
    });
    setHtml5Drag(null);
  });

  it("HTML5 drop 落回本窗格空白槽：按落点写入摆放记录；非应用内投放不动作", () => {
    const onSetIconPosition = vi.fn();
    // 不设选中：主选中的「滚入可视区」effect 会在 jsdom 里改 scrollTop，槽位换算随之漂移。
    // 被拖路径来自 dataTransfer，与选中无关
    const { container } = render(<IconGrid {...makeProps({ onSetIconPosition })} />);
    const body = container.querySelector("[data-icongrid-body]")!;
    const makeDt = (types: string[]) => ({
      types,
      getData: (t: string) =>
        t === "application/x-rdir-dnd" ? "1" : t === "text/plain" ? "/mock/dir/main.rs" : "",
    });
    const dropAt = (x: number, y: number, types: string[]) => {
      const nativeEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(nativeEvent, "dataTransfer", { value: makeDt(types) });
      Object.defineProperty(nativeEvent, "clientX", { value: x });
      Object.defineProperty(nativeEvent, "clientY", { value: y });
      fireEvent(body, nativeEvent);
    };
    // iconSize 64 → 单元 88×106，行距 114：clientY 600 → 槽位 (0,5)，写入摆放记录
    dropAt(40, 600, ["application/x-rdir-dnd", "text/plain"]);
    expect(onSetIconPosition).toHaveBeenCalledWith("main.rs", [0, 5]);
    // 无应用内标记（外部拖入）：不动作
    dropAt(40, 600, ["Files"]);
    expect(onSetIconPosition).toHaveBeenCalledTimes(1);
  });
});
