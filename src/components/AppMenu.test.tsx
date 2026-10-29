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
    onSaveSession: () => {},
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
  viewMode: "details" as const,
  onViewModeChange: () => {},
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
    onAddSftp: () => {},
    onMasterKey: () => {},
    onOpenSettings: () => {},
    onCheckUpdate: () => {},
    onOpenRepo: () => {},
    onOpenDocs: () => {},
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

/** 打开右上角「工具」下拉（v0.34 从 ⋮ 菜单提出的分组：收藏夹 / 比对 / Git Diff / SFTP） */
function openTools() {
  const trigger = screen.getByTitle("工具");
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

  it("「保存会话」触发 onSaveSession 并显示键位提示", () => {
    const onSaveSession = vi.fn();
    render(<AppMenu {...makeActions({ onSaveSession })} />);
    openMenu();
    // 可访问名含键位提示后缀（"保存会话 Ctrl+S"），按前缀匹配
    const item = screen.getByRole("menuitem", { name: /^保存会话/ });
    fireEvent.click(item);
    expect(onSaveSession).toHaveBeenCalledTimes(1);
    // 键位提示跟随 keymap 当前平台绑定（jsdom 走 Windows 分支：saveSession = Ctrl+S）
    expect(item.textContent).toContain("Ctrl+S");
  });

  it("开关型菜单项（显示隐藏文件）正常触发", () => {
    const onToggleHidden = vi.fn();
    render(<AppMenu {...makeActions({ onToggleHidden })} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^显示隐藏文件/ }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
  });

  it("传入 onOpenFavorites 时「工具」下拉显示「收藏夹…」并显示键位提示", () => {
    const onOpenFavorites = vi.fn();
    render(<AppMenu {...makeActions({ onOpenFavorites })} />);
    openTools();
    const item = screen.getByRole("menuitem", { name: /^收藏夹…/ });
    fireEvent.click(item);
    expect(onOpenFavorites).toHaveBeenCalledTimes(1);
    // 键位提示跟随 keymap 当前平台绑定（jsdom 走 Windows 分支：openFavorites = Ctrl+B）
    expect(item.textContent).toContain("Ctrl+B");
  });

  it("未传 onOpenFavorites 时「工具」下拉不显示收藏夹菜单项", () => {
    render(<AppMenu {...makeActions()} />);
    openTools();
    expect(screen.queryByRole("menuitem", { name: /^收藏夹…/ })).toBeNull();
  });

  it("「工具」下拉承载原工具组全部条目，⋮ 菜单不再重复", () => {
    const onMasterKey = vi.fn();
    const onExportServers = vi.fn();
    render(<AppMenu {...makeActions({ onMasterKey, onExportServers, onOpenFavorites: () => {} })} />);
    openTools();
    for (const name of ["差异比对…", "同步比对", "打开 Git Diff…", "添加 SFTP 服务器…", "导出服务器列表…", "SFTP 主密钥…"]) {
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "SFTP 主密钥…" }));
    expect(onMasterKey).toHaveBeenCalledTimes(1);
    // ⋮ 应用菜单：工具组已移出，文件 / 帮助等分组照旧
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "SFTP 主密钥…" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^收藏夹…/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /^新建标签页/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^设置/ })).toBeTruthy();
  });
});
