import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavDebugOverlay } from "./NavDebugOverlay";
import { navDebugPush, navDebugSnapshot } from "@/lib/nav-debug";

/**
 * v0.52 回归：诊断浮层曾把「每次调用都返回新对象」的 getSnapshot 交给
 * useSyncExternalStore，React 判定快照永远在变 → 无限重渲染 → 整棵树卸载白屏
 * （dev 构建自动开启浮层，桌面窗口与 web 页面全白）。
 */
describe("NavDebugOverlay", () => {
  it("快照引用在无新事件时保持稳定", () => {
    expect(navDebugSnapshot()).toBe(navDebugSnapshot());
  });

  it("可挂载且不触发无限重渲染", () => {
    localStorage.setItem("rfm.debug-nav", "1");
    navDebugPush("单击", "/mock/home/a.txt");
    const { container } = render(
      <NavDebugOverlay panePath="/mock/home" loading={false} selection={[]} />,
    );
    expect(screen.getByText(/NAV DEBUG/)).toBeTruthy();
    expect(container.textContent).toContain("单击 /mock/home/a.txt");
  });
});
