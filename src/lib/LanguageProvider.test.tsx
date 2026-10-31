import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider, useI18n } from "./LanguageProvider";
import type { ReactNode } from "react";

function wrapper(language: "zh" | "en") {
  return ({ children }: { children: ReactNode }) => (
    <LanguageProvider language={language}>{children}</LanguageProvider>
  );
}

describe("LanguageProvider", () => {
  it("无 Provider 时用 Context 默认值：t 原样返回 key（单测直渲染组件的场景）", () => {
    const { result } = renderHook(() => useI18n().t("界面语言"));
    expect(result.current).toBe("界面语言");
  });

  it("zh：key 即原文", () => {
    const { result } = renderHook(() => useI18n().t("界面语言"), { wrapper: wrapper("zh") });
    expect(result.current).toBe("界面语言");
  });

  it("en：查内置 en 包 strings 翻译", () => {
    const { result } = renderHook(() => useI18n().t("界面语言"), { wrapper: wrapper("en") });
    expect(result.current).toBe("Language");
  });

  it("en：terr 码查内置 en 包 errors 表，详情保留", () => {
    const { result } = renderHook(() => useI18n().terr("CANCELLED|用户取消"), {
      wrapper: wrapper("en"),
    });
    expect(result.current).toBe("Cancelled：用户取消");
  });

  it("en：包内缺失 key 回退中文原文", () => {
    const { result } = renderHook(() => useI18n().t("尚未翻译的文案"), { wrapper: wrapper("en") });
    expect(result.current).toBe("尚未翻译的文案");
  });
});
