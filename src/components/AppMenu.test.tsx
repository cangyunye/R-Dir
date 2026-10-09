import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AppMenu, type AppMenuActions } from "./AppMenu";

/**
 * 菜单项点击回归（v0.23.0）：Radix DropdownMenuItem 的 onClick 会把 MouseEvent 作为
 * 首参透传。此前 `onNewTab={newTab}` 直传可选参函数 `(path?: string)`，事件对象被误当
 * path → `target.match` 抛 TypeError → 新建标签页无效。现 Item 包装层截断参数，本用例
 * 断言回调以零参调用；「退出」必须触发 onQuit（交确认对话框，不得静默直接退出）。
 */
function makeActions(overrides: Partial<AppMenuActions> = {}): AppMenuActions {
  return {
    onNewTab: () => {},
    onCloseTab: () => {},
    onQuit: () => {},
    onNewFolder: () => {},
    onNewFile: () => {},
    onUndo: () => {},
    canUndo: false,
    onRedo: () => {},
    canRedo: false,
    onCopy: () => {},
    onCut: () => {},
    onPaste: () => {},
    canPaste: false,
    onDuplicate: () => {},
    canDuplicate: false,
    onRename: () => {},
    canRename: false,
    onDelete: () => {},
    canDelete: false,
    onCopyPath: () => {},
    onToggleProperties: () => {},
    onToggleHidden: () => {},
    showHidden: false,
    onToggleExtensions: () => {},
    showExtensions: false,
    onToggleSearch: () => {},
    onRefresh: () => {},
    onBack: () => {},
    onForward: () => {},
    onUp: () => {},
    onHome: () => {},
    onSplitRow: () => {},
    onSplitCol: () => {},
    onClosePane: () => {},
    canClosePane: false,
    onFocusNextPane: () => {},
    onOpenDiff: () => {},
    onOpenSyncDiff: () => {},
    syncDiffActive: false,
    onOpenGitDiff: () => {},
    onMasterKey: () => {},
    onOpenSettings: () => {},
    onCheckUpdate: () => {},
    onOpenRepo: () => {},
    appName: "R-Dir",
    appVersion: "0.0.0-test",
    dark: false,
    onToggleTheme: () => {},
    onOpenPalette: () => {},
    ...overrides,
  };
}

/** 打开 ⋮ 应用菜单（jsdom 无 PointerEvent，走触发器键盘开启：focus + Enter） */
function openMenu() {
  const trigger = screen.getByTitle("应用菜单");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("AppMenu 菜单项点击", () => {
  beforeEach(() => cleanup());

  it("「新建标签页」以零参回调触发（MouseEvent 不再漏进可选参函数）", () => {
    const onNewTab = vi.fn();
    render(<AppMenu {...makeActions({ onNewTab })} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^新建标签页/ }));
    expect(onNewTab).toHaveBeenCalledTimes(1);
    // 关键断言：首参不是 MouseEvent（直传时 newTab 收到事件对象 → TypeError → 无效）
    expect(onNewTab).toHaveBeenCalledWith();
  });

  it("「退出」触发 onQuit（交由确认对话框，而非静默保存退出）", () => {
    const onQuit = vi.fn();
    render(<AppMenu {...makeActions({ onQuit })} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onQuit).toHaveBeenCalledWith();
  });

  it("开关型菜单项（显示隐藏文件）正常触发", () => {
    const onToggleHidden = vi.fn();
    render(<AppMenu {...makeActions({ onToggleHidden })} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^显示隐藏文件/ }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
  });
});
