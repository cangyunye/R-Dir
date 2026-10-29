import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsDialog } from "./SettingsDialog";
import type { OpenerItem } from "@/lib/openerApi";

const zed: OpenerItem = {
  id: "custom:1",
  name: "Zed",
  kind: "custom",
  detected: true,
  exec: "/Applications/Zed.app",
  cli: false,
  extensions: ["json", "yaml"],
};

function setup(over: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  const onRemoveOpener = vi.fn();
  const onSetOpenerExtensions = vi.fn();
  const onAddOpener = vi.fn();
  const onThemeModeChange = vi.fn();
  render(
    <SettingsDialog
      open
      onClose={() => {}}
      themeMode="light"
      onThemeModeChange={onThemeModeChange}
      onBindingsChanged={() => {}}
      previewEnabled={false}
      onPreviewEnabledChange={() => {}}
      previewWidth={360}
      onPreviewWidthChange={() => {}}
      plugins={[]}
      onTogglePlugin={() => {}}
      uiFontSize={15}
      onUiFontChange={() => {}}
      uiFontFamily="system"
      onUiFontFamilyChange={() => {}}
      fontFamilies={[{ id: "system", label: "系统默认" }]}
      openers={[zed]}
      quickTools={[]}
      editorSuggestions={[]}
      onAddQuickTool={() => {}}
      onAddSuggestedTool={() => {}}
      onRemoveQuickTool={() => {}}
      onMoveQuickTool={() => {}}
      onAddOpener={onAddOpener}
      onRemoveOpener={onRemoveOpener}
      onSetOpenerExtensions={onSetOpenerExtensions}
      appName="R-Dir"
      appVersion="0.0.0-test"
      onOpenRepo={() => {}}
      onOpenDocs={() => {}}
      onCheckUpdate={() => {}}
      onOpenFavorites={() => {}}
      {...over}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "打开方式" }));
  return { onRemoveOpener, onSetOpenerExtensions, onAddOpener, onThemeModeChange };
}

describe("SettingsDialog 打开方式分区", () => {
  it("展示名称与已关联扩展名", () => {
    setup();
    expect(screen.getByText("Zed")).toBeInTheDocument();
    expect(screen.getByText("json")).toBeInTheDocument();
    expect(screen.getByText("yaml")).toBeInTheDocument();
  });

  it("移除扩展名 → onSetOpenerExtensions 传剩余列表", () => {
    const { onSetOpenerExtensions } = setup();
    fireEvent.click(screen.getAllByTitle("移除该扩展名")[0]);
    expect(onSetOpenerExtensions).toHaveBeenCalledWith("custom:1", ["yaml"]);
  });

  it("新增扩展名 → 归一化后合并", () => {
    const { onSetOpenerExtensions } = setup();
    const input = screen.getByPlaceholderText(/如 json/);
    fireEvent.change(input, { target: { value: " .TOML " } });
    fireEvent.submit(input.closest("form")!);
    expect(onSetOpenerExtensions).toHaveBeenCalledWith("custom:1", ["json", "yaml", "toml"]);
  });

  it("逗号/空格分隔可一次加多个扩展名", () => {
    const { onSetOpenerExtensions } = setup();
    const input = screen.getByPlaceholderText(/如 json/);
    fireEvent.change(input, { target: { value: "toml, .XML   ini" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSetOpenerExtensions).toHaveBeenCalledWith("custom:1", [
      "json",
      "yaml",
      "toml",
      "xml",
      "ini",
    ]);
  });

  it("删除打开方式 → onRemoveOpener(id)", () => {
    const { onRemoveOpener } = setup();
    fireEvent.click(screen.getByTitle("删除此打开方式"));
    expect(onRemoveOpener).toHaveBeenCalledWith("custom:1");
  });

  it("空列表显示引导文案", () => {
    setup({ openers: [] });
    expect(screen.getByText(/还没有自定义打开方式/)).toBeInTheDocument();
  });
});

describe("SettingsDialog 收藏夹分区", () => {
  it("左栏含「收藏夹」分区,点按钮关闭设置并 onOpenFavorites", () => {
    const onOpenFavorites = vi.fn();
    const onClose = vi.fn();
    setup({ onOpenFavorites, onClose });
    fireEvent.click(screen.getByRole("button", { name: "收藏夹" }));
    fireEvent.click(screen.getByRole("button", { name: /打开收藏夹面板/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenFavorites).toHaveBeenCalled();
  });
});

describe("SettingsDialog 关于分区", () => {
  it("显示应用名与版本（随 tag 同步）", () => {
    setup({ appName: "R-Dir", appVersion: "9.9.9" });
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    expect(screen.getByText("版本 v9.9.9 · Tauri 2 + React")).toBeInTheDocument();
  });
});

describe("SettingsDialog 外观：颜色模式三态", () => {
  it("浅色/深色/跟随系统三段钮，当前模式高亮（aria-pressed）", () => {
    setup({ themeMode: "system" });
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    expect(screen.getByRole("button", { name: /浅色/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: /跟随系统/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("点「跟随系统」→ onThemeModeChange(\"system\")", () => {
    const { onThemeModeChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /跟随系统/ }));
    expect(onThemeModeChange).toHaveBeenCalledWith("system");
  });

  it("点「深色」→ onThemeModeChange(\"dark\")", () => {
    const { onThemeModeChange } = setup({ themeMode: "system" });
    fireEvent.click(screen.getByRole("button", { name: /深色/ }));
    expect(onThemeModeChange).toHaveBeenCalledWith("dark");
  });
});

describe("SettingsDialog 常用工具：启动参数（v0.31.1）", () => {
  const gitBash = {
    id: "qt:gb",
    name: "Git Bash",
    exec: "C:\\Program Files\\Git\\git-bash.exe",
    args: "",
    detected: true,
  };

  it("每个工具有启动参数输入框，显示已保存值", () => {
    setup({ quickTools: [{ ...gitBash, args: "--cd=$pwd" }] });
    const input = screen.getByTestId("quick-tool-args-qt:gb") as HTMLInputElement;
    expect(input.value).toBe("--cd=$pwd");
  });

  it("修改后回车 → onSetQuickToolArgs(id, 去首尾空白)", () => {
    const onSetQuickToolArgs = vi.fn();
    setup({ quickTools: [gitBash], onSetQuickToolArgs });
    const input = screen.getByTestId("quick-tool-args-qt:gb");
    fireEvent.change(input, { target: { value: "  --cd={dir}  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetQuickToolArgs).toHaveBeenCalledWith("qt:gb", "--cd={dir}");
  });

  it("值未变化时失焦不提交；改动后失焦提交", () => {
    const onSetQuickToolArgs = vi.fn();
    setup({ quickTools: [{ ...gitBash, args: "-x" }], onSetQuickToolArgs });
    const input = screen.getByTestId("quick-tool-args-qt:gb") as HTMLInputElement;
    fireEvent.blur(input);
    expect(onSetQuickToolArgs).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.blur(input);
    expect(onSetQuickToolArgs).toHaveBeenCalledWith("qt:gb", "changed");
  });

  it("说明文案列出占位符", () => {
    setup({ quickTools: [gitBash] });
    expect(screen.getByText("$pwd")).toBeInTheDocument();
    expect(screen.getByText("{path}")).toBeInTheDocument();
  });
});
