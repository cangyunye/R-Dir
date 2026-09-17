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
  A({ id: "delete", label: "删除到回收站", group: "文件操作", when: "pane", win: "delete", mac: "mod+delete / delete" }),
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

/**
 * 用户自定义键位（M5 持久化）
 * 结构：{ [actionId]: { win?: string; mac?: string } }
 * 仅存当前平台录制的键位，未覆盖的字段回落到默认绑定。
 */
type UserBindings = Record<string, { win?: string; mac?: string }>;

const KEYMAP_STORAGE_KEY = "rfm.keymap";

function loadUserBindings(): UserBindings {
  try {
    const raw = localStorage.getItem(KEYMAP_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UserBindings) : {};
  } catch {
    return {};
  }
}

let userBindings: UserBindings = loadUserBindings();

function persistUserBindings() {
  try {
    localStorage.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(userBindings));
  } catch {
    /* ignore */
  }
}

export function getUserBindings(): UserBindings {
  return userBindings;
}

/** 该动作是否有当前平台的用户自定义键位 */
export function hasCustomBinding(actionId: string): boolean {
  const u = userBindings[actionId];
  return !!u && (isMac ? !!u.mac : !!u.win);
}

/** 录制/修改当前平台键位（覆盖原自定义） */
export function setUserBinding(actionId: string, combo: string): void {
  const key = isMac ? "mac" : "win";
  userBindings = {
    ...userBindings,
    [actionId]: { ...userBindings[actionId], [key]: combo },
  };
  persistUserBindings();
}

/** 清除该动作的当前平台自定义键位（回落默认） */
export function clearUserBinding(actionId: string): void {
  const u = userBindings[actionId];
  if (!u) return;
  const key = isMac ? "mac" : "win";
  if (key === "mac") {
    if (u.win === undefined) {
      const { mac: _m, ...rest } = u;
      userBindings = { ...userBindings, [actionId]: rest };
    } else {
      userBindings = { ...userBindings, [actionId]: { ...u, mac: undefined } };
    }
  } else {
    if (u.mac === undefined) {
      const { win: _w, ...rest } = u;
      userBindings = { ...userBindings, [actionId]: rest };
    } else {
      userBindings = { ...userBindings, [actionId]: { ...u, win: undefined } };
    }
  }
  persistUserBindings();
}

/** 恢复全部默认键位 */
export function resetUserBindings(): void {
  userBindings = {};
  persistUserBindings();
}

/** 当前平台下该 combo 已被哪些其他动作占用（冲突检测，可排除自身） */
export function findConflicts(combo: string, exceptActionId?: string): KeyAction[] {
  return ACTIONS.filter(
    (a) => a.id !== exceptActionId && bindingOf(a).split(" / ").includes(combo),
  );
}

/** 动作的当前平台绑定串（优先用户自定义，回落默认；如 "mod+shift+n" / "ctrl+tab"） */
export function bindingOf(a: KeyAction): string {
  const u = userBindings[a.id];
  if (u) {
    const custom = isMac ? u.mac : u.win;
    if (custom !== undefined && custom !== "") return custom;
  }
  return isMac ? a.mac : a.win;
}

/** 特殊键别名：事件 e.key → 绑定串（保持与 KEY_LABELS / 默认绑定一致） */
const KEY_ALIAS: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "esc",
  Enter: "enter",
  Tab: "tab",
  Delete: "delete",
  " ": "space",
};

function normKey(k: string): string {
  const alias = KEY_ALIAS[k];
  if (alias) return alias;
  // F1–F12 归一化为小写（"F5" → "f5"）
  if (/^F\d{1,2}$/.test(k)) return k.toLowerCase();
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
    // macOS 退格键事件 key 为 "Backspace"，按删除语义归一化（匹配 mod+delete 绑定）
    if (e.key === "Backspace") {
      parts.push("delete");
      return parts.join("+");
    }
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
