import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeStudioDrawer, type ThemeStudioSession } from "./ThemeStudioDrawer";
import { createDraft, TOKEN_GROUPS } from "@/lib/themeEditor";
import { THEME_TOKEN_KEYS, type ThemePack } from "@/lib/themePacks";

const blueberry: ThemePack = {
  id: "blueberry",
  name: "蓝莓",
  base: "dark",
  tokens: {
    "--background": "oklch(0.185 0.035 275)",
    "--primary": "oklch(0.68 0.15 275)",
    "--border": "oklch(1 0 0 / 12%)",
  },
};

function makeSession(): ThemeStudioSession {
  const origin = createDraft(blueberry);
  return { origin, draft: origin, sourceLabel: "蓝莓" };
}

function setup(overrides: Partial<Parameters<typeof ThemeStudioDrawer>[0]> = {}) {
  const props = {
    session: makeSession(),
    expanded: true,
    packs: [blueberry],
    shortcutLabel: "⌘+⌥+P",
    onChange: vi.fn(),
    onLoadSource: vi.fn(),
    onReset: vi.fn(),
    onExpand: vi.fn(),
    onCollapse: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
  const utils = render(<ThemeStudioDrawer {...props} />);
  return { ...utils, props };
}

beforeEach(() => {
  // jsdom 没有 CSS.supports：原值输入提交依赖它放行
  if (typeof CSS === "undefined") {
    (globalThis as unknown as { CSS: unknown }).CSS = { supports: () => true };
  } else if (typeof CSS.supports !== "function") {
    Object.defineProperty(CSS, "supports", { value: () => true, configurable: true });
  }
});

describe("ThemeStudioDrawer", () => {
  it("没有会话时不渲染", () => {
    const { container } = setup({ session: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("按分组渲染全部 23 个 token：22 个色块 + 1 个阴影预设", () => {
    setup();
    for (const group of TOKEN_GROUPS) {
      expect(screen.getByText(group.label)).toBeInTheDocument();
    }
    const swatches = screen.getAllByTestId(/^theme-swatch-/);
    expect(swatches).toHaveLength(THEME_TOKEN_KEYS.length - 1);
    expect(screen.getByTestId("theme-shadow-select")).toBeInTheDocument();
  });

  it("展开 / 收回：translate 切换，收起时出现把手，点击把手展开", () => {
    const { props, rerender } = setup();
    expect(screen.getByTestId("theme-studio-drawer")).toHaveClass("translate-x-0");
    expect(screen.queryByTestId("theme-studio-handle")).toBeNull();

    rerender(<ThemeStudioDrawer {...props} expanded={false} />);
    expect(screen.getByTestId("theme-studio-drawer")).toHaveClass("translate-x-full");
    // 草稿内容仍在 DOM 中（状态保留），只是滑出视口
    expect(screen.getByTestId("theme-studio-name")).toHaveValue("蓝莓");
    fireEvent.click(screen.getByTestId("theme-studio-handle"));
    expect(props.onExpand).toHaveBeenCalledTimes(1);
  });

  it("头部收回与关闭分别触发 onCollapse / onClose", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTitle("收回（⌘+⌥+P）"));
    expect(props.onCollapse).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("theme-studio-close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("组件明暗 / 名称 / id 编辑通过 onChange 回传整份草稿", () => {
    const { props } = setup();
    fireEvent.click(screen.getByText("浅色"));
    expect(props.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ base: "light" }));

    fireEvent.change(screen.getByTestId("theme-studio-name"), { target: { value: "我的蓝莓" } });
    expect(props.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: "我的蓝莓" }));

    fireEvent.change(screen.getByTestId("theme-studio-id"), { target: { value: "Bad Id" } });
    expect(props.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: "Bad Id" }));
  });

  it("id 非法时保存 / 导出禁用并给出提示；与已安装包重名时提示覆盖", () => {
    const session = makeSession();
    const { rerender, props } = setup({
      session: { ...session, draft: { ...session.draft, id: "Bad Id" } },
    });
    expect(screen.getByTestId("theme-studio-save")).toBeDisabled();
    expect(screen.getByTestId("theme-studio-export")).toBeDisabled();
    expect(screen.getByText("小写字母 / 数字 / 连字符，≤64 字符")).toBeInTheDocument();

    rerender(
      <ThemeStudioDrawer {...props} session={{ ...session, draft: { ...session.draft, id: "blueberry" } }} />,
    );
    expect(screen.getByTestId("theme-studio-save")).toBeEnabled();
    expect(screen.getByText("保存将覆盖已安装的同名主题")).toBeInTheDocument();
  });

  it("重置只在草稿有改动时可用", () => {
    const session = makeSession();
    const { rerender, props } = setup({ session });
    expect(screen.getByTestId("theme-studio-reset")).toBeDisabled();
    rerender(
      <ThemeStudioDrawer
        {...props}
        session={{ ...session, draft: { ...session.draft, tokens: { ...session.draft.tokens, "--primary": "oklch(0.5 0.1 30)" } } }}
      />,
    );
    const reset = screen.getByTestId("theme-studio-reset");
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it("载入起点下拉：内置与已安装包分别回传", () => {
    const { props } = setup();
    const select = screen.getByTestId("theme-studio-source");
    fireEvent.change(select, { target: { value: "dark" } });
    expect(props.onLoadSource).toHaveBeenLastCalledWith("dark");
    fireEvent.change(select, { target: { value: "pack:blueberry" } });
    expect(props.onLoadSource).toHaveBeenLastCalledWith(blueberry);
  });

  it("点色块弹出 L/C/H 滑杆；带透明度的 token 多一根 A", () => {
    setup();
    fireEvent.click(screen.getByTestId("theme-swatch-primary"));
    const popover = screen.getByText("--primary").closest("div")!.parentElement!;
    expect(within(popover).getAllByRole("slider")).toHaveLength(3);
    expect(within(popover).getByTestId("theme-restore")).toBeDisabled();
    // 关掉再开 border
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("theme-swatch-border"));
    const borderPop = screen.getByText("--border").closest("div")!.parentElement!;
    expect(within(borderPop).getAllByRole("slider")).toHaveLength(4);
  });

  it("原值输入回车提交合法颜色，空值回退", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("theme-swatch-primary"));
    const input = screen.getByTestId("theme-raw-input");
    fireEvent.change(input, { target: { value: "#ff0000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ "--primary": "#ff0000" }) }),
    );
    vi.mocked(props.onChange).mockClear();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(props.onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("oklch(0.68 0.15 275)");
  });

  it("恢复原值把该 token 回写为起点值", () => {
    const session = makeSession();
    const { props } = setup({
      session: { ...session, draft: { ...session.draft, tokens: { ...session.draft.tokens, "--primary": "oklch(0.5 0.1 30)" } } },
    });
    fireEvent.click(screen.getByTestId("theme-swatch-primary"));
    const restore = screen.getByTestId("theme-restore");
    expect(restore).toBeEnabled();
    fireEvent.click(restore);
    expect(props.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ "--primary": "oklch(0.68 0.15 275)" }) }),
    );
  });

  it("阴影预设：非预设值显示自定义，选预设回传对应 box-shadow", () => {
    const { props } = setup();
    const select = screen.getByTestId("theme-shadow-select") as HTMLSelectElement;
    // 包没写 --shadow → 回落深色内置阴影，恰好是预设"重"
    expect(select.value).toBe("heavy");
    fireEvent.change(select, { target: { value: "none" } });
    expect(props.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ "--shadow": "none" }) }),
    );
  });

  it("分组可折叠", () => {
    setup();
    const header = screen.getByText("主色 / 强调").closest("button")!;
    expect(screen.getByTestId("theme-swatch-primary")).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByTestId("theme-swatch-primary")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByTestId("theme-swatch-primary")).toBeInTheDocument();
  });

  it("全局色相滑杆显示主导色相；全灰阶时禁用", () => {
    const { props, rerender } = setup();
    // fixture 只覆盖 3 个 token，其余回落深色内置（ring 225 / selected 235 / accent 240 成簇），主导色相在蓝区
    const readout = screen.getByText(/^\d+°$/);
    const deg = Number(readout.textContent!.replace("°", ""));
    expect(deg).toBeGreaterThan(200);
    expect(deg).toBeLessThan(290);
    const greyTokens: Record<string, string> = {};
    for (const k of THEME_TOKEN_KEYS) greyTokens[k] = k === "--shadow" ? "none" : "oklch(0.5 0 0)";
    rerender(
      <ThemeStudioDrawer {...props} session={{ ...props.session!, draft: { ...props.session!.draft, tokens: greyTokens } }} />,
    );
    expect(screen.getByText("无主题色")).toBeInTheDocument();
    expect(screen.getByTestId("theme-studio-hue")).toHaveAttribute("data-disabled");
  });
});
