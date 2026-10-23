import { describe, it, expect } from "vitest";
import { resolveDropTarget } from "./drop-target";

/** 搭一段与真实结构同形的 DOM：窗格根 > 列表 > 行（目录行带 data-drop-dir）。 */
function mount(dom: string): void {
  document.body.innerHTML = dom;
}

const PANE = (inner: string, id = 1) =>
  `<div data-pane-id="${id}">${inner}</div>`;

const ROW = (path: string, dropDir = false) =>
  `<div data-path="${path}"${dropDir ? " data-drop-dir" : ""}><span>${path}</span></div>`;

describe("拖拽落点解析（resolveDropTarget）", () => {
  it("命中目录行 → 文件夹目标（paneId + dirPath）", () => {
    mount(PANE(`${ROW("/a/Docs", true)}${ROW("/a/f.txt")}`));
    const el = document.querySelector('[data-path="/a/Docs"] span');
    expect(resolveDropTarget(el, [])).toEqual({ paneId: 1, dirPath: "/a/Docs" });
  });

  it("命中文件行 → 窗格级目标（dirPath null）", () => {
    mount(PANE(`${ROW("/a/Docs", true)}${ROW("/a/f.txt")}`));
    const el = document.querySelector('[data-path="/a/f.txt"] span');
    expect(resolveDropTarget(el, [])).toEqual({ paneId: 1, dirPath: null });
  });

  it("被拖路径自身（拖文件夹到它自己）排除 → 回落窗格级", () => {
    mount(PANE(ROW("/a/Docs", true)));
    const el = document.querySelector('[data-path="/a/Docs"] span');
    expect(resolveDropTarget(el, ["/a/Docs"])).toEqual({ paneId: 1, dirPath: null });
  });

  it("窗格外（无 data-pane-id / data-pane-swap-root 祖先）→ null", () => {
    mount(`<div>${ROW("/a/Docs", true)}</div>`);
    const el = document.querySelector('[data-path="/a/Docs"] span');
    expect(resolveDropTarget(el, [])).toBeNull();
  });

  it("null 元素与空 DOM 安全返回 null", () => {
    mount("");
    expect(resolveDropTarget(null, [])).toBeNull();
    expect(resolveDropTarget(document.body, [])).toBeNull();
  });

  it("窗格头区域（data-pane-swap-root）也归一到窗格", () => {
    mount(`<div data-pane-swap-root="7">${ROW("/a/Docs", true)}</div>`);
    const el = document.querySelector('[data-path="/a/Docs"] span');
    expect(resolveDropTarget(el, [])).toEqual({ paneId: 7, dirPath: "/a/Docs" });
  });
});
