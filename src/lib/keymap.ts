/**
 * 快捷键注册表（P1 重构版）
 *
 * - 动作以 actionId 唯一标识，键位只是默认绑定（M5 配置化时按 id 覆盖）
 * - 统一逻辑键 `mod` = macOS ⌘ / Windows Ctrl；`alt` 两平台一致
 * - 例外：macOS 标签切换保留 `ctrl+tab`（系统已占用 ⌘+Tab）
 * - when: "global" 全局生效 / "pane" 需活动窗格
 * - 输入框聚焦时整体放行（由 App 统一判断 typing 后直接 return）
 */

export type When = "global" | "pane";

export interface KeyAction {
  id: string;
  label: string;
  group: string;
  when: When;
  win: string;
  mac: string;
}

const A = (a: Omit<KeyAction, "win" | "mac"> & { win: string; mac: string }): KeyAction => a;

export const ACTIONS: KeyAction[] = [
  // 导航
  A({ id: "goUp", label: "上一级目录", group: "导航", when: "pane", win: "alt+up / backspace", mac: "mod+up" }),
  A({ id: "goBack", label: "后退", group: "导航", when: "pane", win: "alt+left", mac: "mod+[" }),
  A({ id: "goForward", label: "前进", group: "导航", when: "pane", win: "alt+right", mac: "mod+]" }),
  A({ id: "refresh", label: "刷新", group: "导航", when: "pane", win: "f5", mac: "mod+r" }),
  A({ id: "focusAddress", label: "聚焦地址栏", group: "导航", when: "global", win: "mod+l", mac: "mod+l" }),
  A({ id: "goHome", label: "前往主目录", group: "导航", when: "pane", win: "mod+shift+h", mac: "mod+shift+h" }),
  // 选择
  A({ id: "selectAll", label: "全选", group: "选择", when: "pane", win: "mod+a", mac: "mod+a" }),
  A({ id: "invertSelection", label: "反向选择", group: "选择", when: "pane", win: "mod+shift+a", mac: "mod+shift+a" }),
  A({ id: "clearSelection", label: "取消选择", group: "选择", when: "pane", win: "esc", mac: "esc" }),
  // 文件操作
  A({ id: "copy", label: "复制", group: "文件操作", when: "pane", win: "mod+c", mac: "mod+c" }),
  A({ id: "cut", label: "剪切", group: "文件操作", when: "pane", win: "mod+x", mac: "mod+x" }),
  A({ id: "paste", label: "粘贴", group: "文件操作", when: "pane", win: "mod+v", mac: "mod+v" }),
  A({ id: "duplicate", label: "复制到当前目录", group: "文件操作", when: "pane", win: "mod+d", mac: "mod+d" }),
  A({ id: "rename", label: "重命名", group: "文件操作", when: "pane", win: "f2", mac: "f2" }),
  A({ id: "open", label: "打开", group: "文件操作", when: "pane", win: "enter", mac: "enter" }),
  A({ id: "delete", label: "删除到回收站", group: "文件操作", when: "pane", win: "delete", mac: "mod+delete" }),
  A({ id: "deletePermanent", label: "永久删除（需确认）", group: "文件操作", when: "pane", win: "shift+delete", mac: "mod+alt+delete" }),
  A({ id: "newFolder", label: "新建文件夹", group: "文件操作", when: "pane", win: "mod+shift+n", mac: "mod+shift+n" }),
  A({ id: "newFile", label: "新建文件", group: "文件操作", when: "pane", win: "mod+alt+n", mac: "mod+alt+n" }),
  A({ id: "copyPath", label: "复制完整路径", group: "文件操作", when: "pane", win: "mod+shift+c", mac: "mod+shift+c" }),
  A({ id: "undo", label: "撤销", group: "文件操作", when: "pane", win: "mod+z", mac: "mod+z" }),
  A({ id: "redo", label: "重做", group: "文件操作", when: "pane", win: "mod+y", mac: "mod+shift+z" }),
  A({ id: "properties", label: "属性栏", group: "文件操作", when: "pane", win: "alt+enter", mac: "mod+i" }),
  // 标签页
  A({ id: "newTab", label: "新标签页", group: "标签页", when: "global", win: "mod+t", mac: "mod+t" }),
  A({ id: "closeTab", label: "关闭标签页", group: "标签页", when: "global", win: "mod+w", mac: "mod+w" }),
  A({ id: "nextTab", label: "下一个标签页", group: "标签页", when: "global", win: "mod+tab", mac: "ctrl+tab" }),
  A({ id: "prevTab", label: "上一个标签页", group: "标签页", when: "global", win: "mod+shift+tab", mac: "ctrl+shift+tab" }),
  A({ id: "reopenTab", label: "恢复关闭的标签页", group: "标签页", when: "global", win: "mod+shift+t", mac: "mod+shift+t" }),
  A({ id: "jumpTab1", label: "跳转到第 1 个标签页", group: "标签页", when: "global", win: "mod+1", mac: "mod+1" }),
  A({ id: "jumpTab2", label: "跳转到第 2 个标签页", group: "标签页", when: "global", win: "mod+2", mac: "mod+2" }),
  A({ id: "jumpTab3", label: "跳转到第 3 个标签页", group: "标签页", when: "global", win: "mod+3", mac: "mod+3" }),
  A({ id: "jumpTab4", label: "跳转到第 4 个标签页", group: "标签页", when: "global", win: "mod+4", mac: "mod+4" }),
  A({ id: "jumpTab5", label: "跳转到第 5 个标签页", group: "标签页", when: "global", win: "mod+5", mac: "mod+5" }),
  A({ id: "jumpTab6", label: "跳转到第 6 个标签页", group: "标签页", when: "global", win: "mod+6", mac: "mod+6" }),
  A({ id: "jumpTab7", label: "跳转到第 7 个标签页", group: "标签页", when: "global", win: "mod+7", mac: "mod+7" }),
  A({ id: "jumpTab8", label: "跳转到第 8 个标签页", group: "标签页", when: "global", win: "mod+8", mac: "mod+8" }),
  A({ id: "jumpTab9", label: "跳转到第 9 个标签页", group: "标签页", when: "global", win: "mod+9", mac: "mod+9" }),
  // 分屏 / 窗格
  A({ id: "splitRow", label: "左右分屏", group: "分屏 / 窗格", when: "global", win: "mod+\\", mac: "mod+\\" }),
  A({ id: "splitCol", label: "上下分屏", group: "分屏 / 窗格", when: "global", win: "mod+j", mac: "mod+j" }),
  A({ id: "focusNextPane", label: "聚焦下一窗格", group: "分屏 / 窗格", when: "global", win: "mod+shift+\\", mac: "mod+shift+\\" }),
  A({ id: "closePane", label: "关闭当前窗格", group: "分屏 / 窗格", when: "global", win: "mod+shift+w", mac: "mod+shift+w" }),
  A({ id: "resetSplitRatio", label: "重置分屏比例", group: "分屏 / 窗格", when: "global", win: "mod+0", mac: "mod+0" }),
  // 搜索
  A({ id: "focusSearch", label: "聚焦搜索（文件名）", group: "搜索", when: "global", win: "mod+f", mac: "mod+f" }),
  A({ id: "focusSearchContent", label: "切换内容搜索", group: "搜索", when: "global", win: "mod+shift+f", mac: "mod+shift+f" }),
  // 视图 / 全局
  A({ id: "toggleHidden", label: "显示/隐藏隐藏文件", group: "视图 / 全局", when: "pane", win: "mod+shift+.", mac: "mod+shift+." }),
  A({ id: "toggleTheme", label: "切换主题", group: "视图 / 全局", when: "global", win: "mod+alt+t", mac: "mod+alt+t" }),
  A({ id: "openSettings", label: "打开设置（快捷键一览）", group: "视图 / 全局", when: "global", win: "mod+,", mac: "mod+," }),
  A({ id: "openHelp", label: "帮助 / 快捷键一览", group: "视图 / 全局", when: "global", win: "f1", mac: "f1" }),
];

export const isMac =
  typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Mac") || navigator.platform?.toLowerCase().includes("mac"));

/** 动作的当前平台绑定串（如 "mod+shift+n" / "ctrl+tab"） */
export function bindingOf(a: KeyAction): string {
  return isMac ? a.mac : a.win;
}

function normKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

/**
 * 将 KeyboardEvent 归一化为绑定串（如 "mod+shift+n" / "f2" / "escape"）。
 * mac 分支同时识别 meta（mod）与 ctrl（ctrl+tab 例外）；win 分支 mod=ctrl。
 */
export function keyEventString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac) {
    if (e.metaKey) parts.push("mod");
    if (e.ctrlKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
  } else {
    if (e.ctrlKey) parts.push("mod");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
  }
  parts.push(normKey(e.key));
  return parts.join("+");
}

/** 当前平台下查找组合键命中的动作（首个匹配；支持 "a / b" 多键绑定） */
export function findAction(combo: string): KeyAction | undefined {
  for (const a of ACTIONS) {
    const binds = bindingOf(a).split(" / ");
    if (binds.includes(combo)) return a;
  }
  return undefined;
}

const MOD_LABEL = isMac ? "⌘" : "Ctrl";
const ALT_LABEL = isMac ? "⌥" : "Alt";
const SHIFT_LABEL = isMac ? "⇧" : "Shift";

const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  esc: "Esc",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  space: "Space",
  "\\": "\\",
  ",": ",",
  ".": ".",
  " ": "Space",
};

/** 将绑定串格式化为当前平台的可读展示（如 "Ctrl+Shift+N" / "⌘+⇧+N"） */
export function formatBinding(bind: string): string {
  return bind
    .split(" / ")
    .map((combo) =>
      combo
        .split("+")
        .map((p) => {
          if (p === "mod") return MOD_LABEL;
          if (p === "alt") return ALT_LABEL;
          if (p === "shift") return SHIFT_LABEL;
          if (p === "ctrl") return "Ctrl";
          if (p.length === 1) return isMac ? p.toUpperCase() : p.toUpperCase();
          return KEY_LABELS[p] ?? p;
        })
        .join("+"),
    )
    .join(" / ");
}
