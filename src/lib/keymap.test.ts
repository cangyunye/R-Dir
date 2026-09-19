import { describe, it, expect, beforeEach } from "vitest";
import {
  ACTIONS,
  keyEventString,
  findAction,
  bindingOf,
  findConflicts,
  formatBinding,
  setUserBinding,
  clearUserBinding,
  resetUserBindings,
  hasCustomBinding,
} from "./keymap";

// jsdom 里 navigator.userAgent 不是 Mac，强制走 Windows 分支
beforeEach(() => {
  resetUserBindings();
});

// ---- 基础注册完整性 ----
describe("ACTIONS 注册完整性", () => {
  it("所有动作 id 唯一", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个动作都有 win 和 mac 绑定", () => {
    for (const a of ACTIONS) {
      expect(a.win, `${a.id} 缺 win`).toBeTruthy();
      expect(a.mac, `${a.id} 缺 mac`).toBeTruthy();
      expect(a.group, `${a.id} 缺 group`).toBeTruthy();
      expect(a.label, `${a.id} 缺 label`).toBeTruthy();
    }
  });

  it("覆盖 7 个分组", () => {
    const groups = new Set(ACTIONS.map((a) => a.group));
    expect(groups.has("导航")).toBe(true);
    expect(groups.has("选择")).toBe(true);
    expect(groups.has("文件操作")).toBe(true);
    expect(groups.has("标签页")).toBe(true);
    expect(groups.has("分屏 / 窗格")).toBe(true);
    expect(groups.has("搜索")).toBe(true);
    expect(groups.has("视图 / 全局")).toBe(true);
  });
});

// ---- keyEventString ----
describe("keyEventString（Windows 分支）", () => {
  function ev(partial: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: "n",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...partial,
    } as KeyboardEvent;
  }

  it("纯字母小写", () => {
    expect(keyEventString(ev({ key: "N" }))).toBe("n");
  });
  it("Ctrl+Shift+N", () => {
    expect(keyEventString(ev({ key: "N", ctrlKey: true, shiftKey: true }))).toBe(
      "mod+shift+n",
    );
  });
  it("F5 归一化", () => {
    expect(keyEventString(ev({ key: "F5" }))).toBe("f5");
  });
  it("Enter", () => {
    expect(keyEventString(ev({ key: "Enter" }))).toBe("enter");
  });
  it("Escape → esc", () => {
    expect(keyEventString(ev({ key: "Escape" }))).toBe("esc");
  });
  it("Backspace", () => {
    expect(keyEventString(ev({ key: "Backspace" }))).toBe("backspace");
  });
  it("方向键", () => {
    expect(keyEventString(ev({ key: "ArrowUp" }))).toBe("up");
    expect(keyEventString(ev({ key: "ArrowLeft" }))).toBe("left");
  });
  it("Ctrl+L", () => {
    expect(keyEventString(ev({ key: "l", ctrlKey: true }))).toBe("mod+l");
  });
});

// ---- findAction 全量快捷键映射（Windows）----
describe("findAction 全量快捷键（Windows）", () => {
  const cases: [string, string][] = [
    // 导航
    ["alt+up", "goUp"],
    ["backspace", "goUp"],
    ["alt+left", "goBack"],
    ["alt+right", "goForward"],
    ["f5", "refresh"],
    ["mod+l", "focusAddress"],
    ["mod+shift+h", "goHome"],
    // 选择
    ["mod+a", "selectAll"],
    ["mod+shift+a", "invertSelection"],
    ["esc", "clearSelection"],
    // 文件操作
    ["mod+c", "copy"],
    ["mod+x", "cut"],
    ["mod+v", "paste"],
    ["mod+d", "duplicate"],
    ["f2", "rename"],
    ["enter", "open"],
    ["delete", "delete"],
    ["shift+delete", "deletePermanent"],
    ["mod+shift+n", "newFolder"],
    ["mod+alt+n", "newFile"],
    ["mod+shift+c", "copyPath"],
    ["mod+z", "undo"],
    ["mod+y", "redo"],
    ["alt+enter", "properties"],
    // 标签页
    ["mod+t", "newTab"],
    ["mod+w", "closeTab"],
    ["mod+tab", "nextTab"],
    ["mod+shift+tab", "prevTab"],
    ["mod+shift+t", "reopenTab"],
    ["mod+1", "jumpTab1"],
    ["mod+9", "jumpTab9"],
    // 分屏
    ["mod+\\", "splitRow"],
    ["mod+j", "splitCol"],
    ["mod+shift+\\", "focusNextPane"],
    ["mod+shift+w", "closePane"],
    ["mod+0", "resetSplitRatio"],
    // 搜索
    ["mod+f", "focusSearch"],
    ["mod+shift+f", "focusSearchContent"],
    // 视图
    ["mod+shift+.", "toggleHidden"],
    ["mod+alt+t", "toggleTheme"],
    ["mod+,", "openSettings"],
    ["f1", "openHelp"],
  ];

  for (const [combo, expectedId] of cases) {
    it(`${combo} → ${expectedId}`, () => {
      const a = findAction(combo);
      expect(a?.id).toBe(expectedId);
    });
  }

  it("未知组合返回 undefined", () => {
    expect(findAction("mod+q")).toBeUndefined();
  });
});

// ---- 自定义键位 ----
describe("自定义键位", () => {
  it("setUserBinding 覆盖默认", () => {
    setUserBinding("open", "mod+o");
    expect(hasCustomBinding("open")).toBe(true);
    const a = ACTIONS.find((x) => x.id === "open")!;
    expect(bindingOf(a)).toBe("mod+o");
  });
  it("clearUserBinding 回退默认", () => {
    setUserBinding("open", "mod+o");
    clearUserBinding("open");
    const a = ACTIONS.find((x) => x.id === "open")!;
    expect(bindingOf(a)).toBe("enter");
  });
  it("findConflicts 检测冲突", () => {
    const conflicts = findConflicts("mod+shift+n");
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0].id).toBe("newFolder");
  });
  it("findConflicts 排除自身", () => {
    const conflicts = findConflicts("mod+shift+n", "newFolder");
    expect(conflicts.find((a) => a.id === "newFolder")).toBeUndefined();
  });
});

// ---- formatBinding ----
describe("formatBinding", () => {
  it("mod+shift+n → Ctrl+Shift+N", () => {
    expect(formatBinding("mod+shift+n")).toBe("Ctrl+Shift+N");
  });
  it("f5 → F5", () => {
    expect(formatBinding("f5")).toBe("F5");
  });
  it("多键绑定用 / 分隔", () => {
    expect(formatBinding("alt+up / backspace")).toBe("Alt+↑ / Backspace");
  });
});
