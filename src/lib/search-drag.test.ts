import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitSearchDragHover,
  finishSearchDrag,
  getSearchDrag,
  onSearchDragFinish,
  onSearchDragHover,
  resolveSearchDropAt,
  setSearchDrag,
  type SearchDragSession,
} from "./search-drag";

const session = (over: Partial<SearchDragSession> = {}): SearchDragSession => ({
  paths: ["/mock/home/a.txt"],
  entries: [],
  finished: false,
  ...over,
});

/** jsdom 无布局：按选择器命中的假元素桩（resolveSearchDropAt → elementFromPoint → closest） */
const setProbe = (el: unknown) => {
  Object.defineProperty(document, "elementFromPoint", {
    value: () => el,
    configurable: true,
    writable: true,
  });
};
const elWith = (hits: Record<string, unknown>) =>
  ({ closest: (selector: string) => hits[selector] ?? null }) as unknown as HTMLElement;

describe("search-drag 会话（feat/search-drag）", () => {
  beforeEach(() => {
    setSearchDrag(null);
  });
  afterEach(() => {
    setSearchDrag(null);
  });

  it("set/get 会话标记：面板 dragstart 设置，App 拖放事件读取", () => {
    expect(getSearchDrag()).toBeNull();
    const s = session();
    setSearchDrag(s);
    expect(getSearchDrag()).toBe(s);
  });

  it("finishSearchDrag 恰好收尾一次：首个调用者定结果，OLE promise 兜底不再重复", () => {
    const s = session();
    setSearchDrag(s);
    const seen: (string | undefined)[] = [];
    onSearchDragFinish((x) => seen.push(x.result));
    expect(finishSearchDrag("deleted")).toBe(true);
    expect(finishSearchDrag("cancelled")).toBe(false);
    expect(seen).toEqual(["deleted"]);
    expect(getSearchDrag()).toBeNull();
    expect(s.finished).toBe(true);
  });

  it("无会话时 finish 是 no-op（拖放事件与会话错峰不误伤）", () => {
    expect(finishSearchDrag("cancelled")).toBe(false);
  });

  it("悬停通报广播与退订（OLE 拖拽期间 App 通报 zone 悬停 → 面板渲染）", () => {
    const seen: (string | null)[] = [];
    const off = onSearchDragHover((k) => seen.push(k));
    emitSearchDragHover("trash");
    off();
    emitSearchDragHover(null);
    expect(seen).toEqual(["trash"]);
  });
});

describe("resolveSearchDropAt 落点解析", () => {
  afterEach(() => {
    setSearchDrag(null);
  });

  it("命中取消区 [data-search-drop=cancel]", () => {
    setProbe(elWith({ "[data-search-drop]": { dataset: { searchDrop: "cancel" }, hasAttribute: () => false } }));
    expect(resolveSearchDropAt(10, 10, [])).toEqual({ kind: "cancel", target: null });
  });

  it("命中垃圾箱 [data-search-drop=trash]", () => {
    setProbe(elWith({ "[data-search-drop]": { dataset: { searchDrop: "trash" }, hasAttribute: () => false } }));
    expect(resolveSearchDropAt(10, 10, [])).toEqual({ kind: "trash", target: null });
  });

  it("禁用态垃圾箱（会话含远程路径 data-disabled）按取消处理", () => {
    setProbe(elWith({ "[data-search-drop]": { dataset: { searchDrop: "trash" }, hasAttribute: () => true } }));
    expect(resolveSearchDropAt(10, 10, [])).toEqual({ kind: "cancel", target: null });
  });

  it("非 zone 落点回落窗格解析（drop-target.ts）", () => {
    setProbe(
      elWith({
        "[data-search-drop]": null,
        "[data-pane-id],[data-pane-swap-root]": { dataset: { paneId: "3" } },
        "[data-drop-dir][data-path]": null,
      }),
    );
    expect(resolveSearchDropAt(10, 10, [])).toEqual({ kind: null, target: { paneId: 3, dirPath: null } });
  });

  it("空白处：无 zone 无窗格 → 目标为 null（mouseup 侧视为取消）", () => {
    setProbe(elWith({}));
    expect(resolveSearchDropAt(10, 10, [])).toEqual({ kind: null, target: null });
  });
});
