import { afterEach, describe, it, expect, vi } from "vitest";
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
    onRenameCommit: noop,
    onRenameCancel: noop,
    isActive: true,
    onActivate: noop,
    zoom: 1,
    onZoomChange: noop,
    onBack: noop,
    onForward: noop,
    onCompress: noop,
    onExtract: noop,
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

describe("FileList 空白处右键菜单", () => {
  // 注意：jsdom 下 radix ContextMenu 每个测试文件只有第一次能开出菜单，
  // 三个场景用同一实例 rerender 切换（菜单保持打开、折叠组展开状态保留）。
  it("终端组展开后包含 Git Bash：探测到无标注 / 未探测到标注未安装 / 无 gitbash 项不出现", () => {
    const utils = renderList({
      pluginTerminal: true,
      gitTools: [{ id: "gitbash", name: "Git Bash", detected: true }],
    });
    fireEvent.contextMenu(utils.body);
    // 折叠组：点组名内联展开
    fireEvent.click(document.querySelector('[data-testid="menu-group-terminalEmpty"]')!);
    const menu = () => document.querySelector('[data-slot="context-menu-content"]');

    expect(menu()?.textContent).toContain("Git Bash");
    expect(menu()?.textContent).not.toContain("未安装");

    // 未探测到 → 置灰「未安装」
    utils.rerender(
      <FileList
        {...makeProps({
          pluginTerminal: true,
          gitTools: [{ id: "gitbash", name: "Git Bash", detected: false }],
        })}
      />,
    );
    expect(menu()?.textContent).toContain("Git Bash");
    expect(menu()?.textContent).toContain("未安装");

    // 非 Windows（无 gitbash 项）→ 不出现
    utils.rerender(<FileList {...makeProps({ pluginTerminal: true, gitTools: [] })} />);
    expect(menu()?.textContent ?? "").not.toContain("Git Bash");

    // 顶部常用工具条（与条目右键同款）：有启用工具时显示磁贴
    utils.rerender(
      <FileList
        {...makeProps({
          pluginOpener: true,
          quickTools: [{ id: "vscode", name: "Visual Studio Code", exec: "", args: "", detected: true }],
        })}
      />,
    );
    expect(document.querySelector('[title="用 Visual Studio Code 打开"]')).toBeTruthy();
  });
});

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

describe("FileList 行内重命名提交（v0.26.1 macOS 回车/失焦不生效修复）", () => {
  it("回车提交重命名", () => {
    const onRenameCommit = vi.fn();
    renderList({
      renaming: { path: "/mock/dir/main.rs", name: "main.rs" },
      onRenameCommit,
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-path="/mock/dir/main.rs"] input',
    )!;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameCommit).toHaveBeenCalledWith("/mock/dir/main.rs", "renamed.rs");
  });

  it("失焦（点击其他地方）提交重命名", () => {
    const onRenameCommit = vi.fn();
    const onRenameCancel = vi.fn();
    renderList({
      renaming: { path: "/mock/dir/main.rs", name: "main.rs" },
      onRenameCommit,
      onRenameCancel,
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-path="/mock/dir/main.rs"] input',
    )!;
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    input.focus();
    fireEvent.blur(input);
    expect(onRenameCommit).toHaveBeenCalledWith("/mock/dir/main.rs", "renamed.rs");
    expect(onRenameCancel).not.toHaveBeenCalled();
  });

  it("未改名失焦 = 取消（对齐访达点空白关闭）", () => {
    const onRenameCommit = vi.fn();
    const onRenameCancel = vi.fn();
    renderList({
      renaming: { path: "/mock/dir/main.rs", name: "main.rs" },
      onRenameCommit,
      onRenameCancel,
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-path="/mock/dir/main.rs"] input',
    )!;
    input.focus();
    fireEvent.blur(input);
    expect(onRenameCommit).not.toHaveBeenCalled();
    expect(onRenameCancel).toHaveBeenCalled();
  });

  it("macOS 中文 IME：组合中的回车（isComposing）不提交，由输入法上屏", () => {
    const onRenameCommit = vi.fn();
    const onRenameCancel = vi.fn();
    renderList({
      renaming: { path: "/mock/dir/main.rs", name: "main.rs" },
      onRenameCommit,
      onRenameCancel,
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-path="/mock/dir/main.rs"] input',
    )!;
    fireEvent.change(input, { target: { value: "笔记" } });
    // 组合中的回车（isComposing=true，候选词确认）交给输入法
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRenameCommit).not.toHaveBeenCalled();
    expect(onRenameCancel).not.toHaveBeenCalled();
    // 上屏后再按回车才提交
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameCommit).toHaveBeenCalledWith("/mock/dir/main.rs", "笔记");
  });

  it("回车/Escape 不冒泡到行（行的 Enter = 打开条目）", () => {
    const onOpen = vi.fn();
    const onRenameCommit = vi.fn();
    renderList({
      renaming: { path: "/mock/dir/main.rs", name: "main.rs" },
      onRenameCommit,
      onOpen,
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-path="/mock/dir/main.rs"] input',
    )!;
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("起手从未持焦的 blur（焦点竞争）不提交也不取消，等重聚焦", () => {
    const onRenameCommit = vi.fn();
    const onRenameCancel = vi.fn();
    renderList({
      renaming: { path: "/mock/dir/main.rs", name: "main.rs" },
      onRenameCommit,
      onRenameCancel,
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-path="/mock/dir/main.rs"] input',
    )!;
    fireEvent.change(input, { target: { value: "renamed.rs" } });
    // 未先 focus 直接 blur（radix 回焦抢走时 input 从未持焦）
    fireEvent.blur(input);
    expect(onRenameCommit).not.toHaveBeenCalled();
    expect(onRenameCancel).not.toHaveBeenCalled();
  });
});

describe("详情列表目录行 = 拖放目标（v0.31.2 拖入目录）", () => {
  it("目录行带 data-drop-dir，文件行没有；dragDir 命中时高亮为投放目标", () => {
    const { container } = renderList({ dragDir: "/mock/dir/Documents" });
    const dirRow = container.querySelector('[data-path="/mock/dir/Documents"]')!;
    const fileRow = container.querySelector('[data-path="/mock/dir/main.rs"]')!;
    expect(dirRow.hasAttribute("data-drop-dir")).toBe(true);
    expect(fileRow.hasAttribute("data-drop-dir")).toBe(false);
    expect(dirRow.className).toContain("ring-primary");
    expect(fileRow.className).not.toContain("ring-primary");
    // 未命中其他目录行不高亮
    const { container: c2 } = renderList({ dragDir: "/mock/dir/Other" });
    expect(
      c2.querySelector('[data-path="/mock/dir/Documents"]')!.className,
    ).not.toContain("ring-primary");
  });
});

describe("FileList 橡皮筋框选（v0.34.1 补充回归：手势状态机此前零测试）", () => {
  const ORIG_GBCR = Element.prototype.getBoundingClientRect;
  afterEach(() => {
    (Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      ORIG_GBCR;
  });

  /** 布局桩：窗格容器在 (0,0) 800×600，行高 26（ROW_HEIGHT）逐行排布 */
  function stubLayout(container: HTMLElement) {
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }) as DOMRect;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-path]"));
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () =>
        ({
          left: 0,
          top: i * 26,
          right: 800,
          bottom: i * 26 + 26,
          width: 800,
          height: 26,
          x: 0,
          y: i * 26,
        }) as DOMRect;
    });
    return rows;
  }

  it("空白按下拖出矩形覆盖前两行 → onSelectRange 收到这两行路径", () => {
    const utils = renderList();
    const pane = utils.container.querySelector("[data-pane-id]") as HTMLElement;
    const rows = stubLayout(pane);

    fireEvent.mouseDown(utils.body, { button: 0, clientX: 10, clientY: 5 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 50 });
    fireEvent.mouseUp(window, { clientX: 700, clientY: 50 });

    expect(utils.props.onSelectRange).toHaveBeenCalledWith([
      rows[0].dataset.path,
      rows[1].dataset.path,
    ]);
  });

  it("矩形太小（<3px）视为空白单击 → onClearSelection（fromRow=false 语义）", () => {
    const utils = renderList();
    const pane = utils.container.querySelector("[data-pane-id]") as HTMLElement;
    stubLayout(pane);

    fireEvent.mouseDown(utils.body, { button: 0, clientX: 10, clientY: 5 });
    fireEvent.mouseMove(window, { clientX: 11, clientY: 6 });
    fireEvent.mouseUp(window, { clientX: 11, clientY: 6 });

    expect(utils.props.onClearSelection).toHaveBeenCalled();
    expect(utils.props.onSelectRange).not.toHaveBeenCalled();
  });

  it("Ctrl+拖出 = 附加框选：与既有 selection 合并去重", () => {
    const utils = renderList({ selection: ["/mock/dir/photo.png"] });
    const pane = utils.container.querySelector("[data-pane-id]") as HTMLElement;
    const rows = stubLayout(pane);

    fireEvent.mouseDown(utils.body, { button: 0, clientX: 10, clientY: 5, ctrlKey: true });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 50 });
    fireEvent.mouseUp(window, { clientX: 700, clientY: 50 });

    expect(utils.props.onSelectRange).toHaveBeenCalledWith([
      "/mock/dir/photo.png",
      rows[0].dataset.path,
      rows[1].dataset.path,
    ]);
  });
});

describe("FileList 重命名行滚动定位（v0.35 新建文件/文件夹后可见性）", () => {
  /** jsdom 无布局：scrollTop 赋值会被丢弃，改用存取器捕获组件的滚动指令 */
  function captureScroll(el: HTMLElement, clientHeight: number) {
    let v = 0;
    Object.defineProperty(el, "scrollTop", { get: () => v, set: (n) => (v = n), configurable: true });
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    return () => v;
  }

  it("renaming 指向视口外条目 → scrollTop 推到能看到该行的位置", () => {
    const utils = renderList();
    // 视口高 52px = 两行：photo.png 在 idx=2（target=52）→ 超出 bottom(26) → 滚到 52
    const get = captureScroll(utils.body, 52);
    utils.rerender(
      <FileList {...makeProps({ renaming: { path: "/mock/dir/photo.png", name: "photo.png" } })} />,
    );
    expect(get()).toBe(52);
  });

  it("renaming 行已在视口内 → 不动滚动位置", () => {
    const utils = renderList();
    // idx=1 target=26，未超出 bottom=26 → 不产生滚动
    const get = captureScroll(utils.body, 52);
    utils.rerender(
      <FileList {...makeProps({ renaming: { path: "/mock/dir/main.rs", name: "main.rs" } })} />,
    );
    expect(get()).toBe(0);
  });

  it("renaming 条目尚未出现在列表（目录还在加载）→ 不滚动也不报错", () => {
    const utils = renderList({
      renaming: { path: "/mock/dir/新建文件夹", name: "新建文件夹" },
    });
    expect(utils.body.scrollTop).toBe(0);
  });
});
