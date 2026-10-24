import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FavoritesPalette } from "./FavoritesPalette";
import { makeFavorite } from "@/lib/favorites";

/** Radix Dialog 在 jsdom 用 <dialog>，open 时可见；直接渲染受控组件即可交互 */
function setup(overrides: Partial<Parameters<typeof FavoritesPalette>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    favorites: [makeFavorite("a", "需求排期"), makeFavorite("b", "日志排查")],
    onOpenFavorite: vi.fn(),
    onAddFavorite: vi.fn(),
    onRenameFavorite: vi.fn(),
    onRemoveFavorite: vi.fn(),
    onUpdateFavorite: vi.fn(),
    ...overrides,
  };
  render(<FavoritesPalette {...props} />);
  return props;
}

beforeEach(() => cleanup());

describe("FavoritesPalette 收藏夹面板", () => {
  it("空查询按 updatedAt 倒序展示全部收藏与路径摘要", () => {
    setup({
      favorites: [
        { ...makeFavorite("a", "旧", { panes: [{ id: 1, path: "/x/a", kind: "local" }] }), updatedAt: "2026-01-01T00:00:00Z" },
        {
          ...makeFavorite("b", "新", {
            panes: [
              { id: 1, path: "/x/b", kind: "local" },
              { id: 2, path: "/x/c", kind: "local" },
            ],
          }),
          updatedAt: "2026-02-01T00:00:00Z",
        },
      ],
    });
    const names = screen.getAllByText(/^(新|旧)$/);
    expect(names[0].textContent).toBe("新");
    expect(screen.getByText("/x/b · +1 窗格")).toBeInTheDocument();
    expect(screen.getByText(/2 项收藏/)).toBeInTheDocument();
  });

  it("输入查询按名称过滤(路径也参与)", () => {
    const props = setup();
    const input = screen.getByPlaceholderText(/搜索收藏/);
    fireEvent.change(input, { target: { value: "日志" } });
    // 命中文字被高亮组件拆成逐字符 span,按行容器断言
    const rows = screen.getAllByTestId("fav-row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("日志排查");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onOpenFavorite).toHaveBeenCalledWith("b");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("按窗格路径搜索命中", () => {
    setup({
      favorites: [
        makeFavorite("a", "甲", { panes: [{ id: 1, path: "/Users/me/tests", kind: "local" }] }),
        makeFavorite("b", "乙", { panes: [{ id: 1, path: "/Users/me/docs", kind: "local" }] }),
      ],
    });
    fireEvent.change(screen.getByPlaceholderText(/搜索收藏/), { target: { value: "tests" } });
    expect(screen.getByText("甲")).toBeInTheDocument();
    expect(screen.queryByText("乙")).toBeNull();
  });

  it("点击「收藏当前标签页」触发 onAddFavorite 且面板不关", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /收藏当前标签页/ }));
    expect(props.onAddFavorite).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("行内操作:更新按钮触发 onUpdateFavorite", () => {
    const props = setup();
    const row = screen.getByText("需求排期").closest("[data-fav-idx]")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(row.querySelector('[title="用当前标签更新此收藏"]')!);
    expect(props.onUpdateFavorite).toHaveBeenCalledWith("a");
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("行内操作:重命名输入回车提交 onRenameFavorite(id, 新名)", () => {
    const props = setup();
    const row = screen.getByText("需求排期").closest("[data-fav-idx]")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(row.querySelector('[title="重命名"]')!);
    const input = screen.getByDisplayValue("需求排期");
    fireEvent.change(input, { target: { value: "发布布局" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRenameFavorite).toHaveBeenCalledWith("a", "发布布局");
  });

  it("行内操作:删除按钮触发 onRemoveFavorite", () => {
    const props = setup();
    const row = screen.getByText("需求排期").closest("[data-fav-idx]")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(row.querySelector('[title="删除收藏"]')!);
    expect(props.onRemoveFavorite).toHaveBeenCalledWith("a");
  });

  it("空收藏列表显示引导文案", () => {
    setup({ favorites: [] });
    expect(screen.getByText(/暂无收藏/)).toBeInTheDocument();
  });

  it("无匹配查询显示空态", () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/搜索收藏/), { target: { value: "zzz" } });
    expect(screen.getByText("无匹配收藏")).toBeInTheDocument();
  });
});
