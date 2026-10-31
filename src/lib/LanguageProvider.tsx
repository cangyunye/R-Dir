/**
 * 语言状态 Provider：受控模式——App 持有 language state（落盘 rfm.language），
 * 这里经 Context 分发绑定了当前包的 t/terr；切换语言 = 换 Context value，全树重渲染。
 * Context 带默认值（zh 原样透传）：组件单测不包 Provider 时行为与迁移前完全一致。
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import enPack from "@rdir/l10n/packs/en.json";
import {
  setPack,
  t as translate,
  terr as translateError,
  type Language,
  type Pack,
} from "./i18n";

/** 构建期内置语言包表；zh 不需要包（key 即中文原文），新增内置语言在此挂载 */
const BUILTIN_PACKS: Record<Exclude<Language, "zh">, Pack> = { en: enPack };

function packFor(language: Language): Pack | null {
  return language === "zh" ? null : (BUILTIN_PACKS[language] ?? null);
}

type I18nContextValue = {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  terr: (msg: string) => string;
};

const I18nContext = createContext<I18nContextValue>({
  language: "zh",
  setLanguage: () => {},
  t: (key, params) => translate(key, params, null),
  terr: (msg) => translateError(msg, null),
});

export function LanguageProvider({
  language,
  onLanguageChange,
  children,
}: {
  language: Language;
  /** 切换回调（App 负责落盘 rfm.language）；缺省时仅切换 Context 不持久化 */
  onLanguageChange?: (lang: Language) => void;
  children: ReactNode;
}) {
  const pack = packFor(language);

  // 同步模块级包：React 树外的 t()/terr() 调用（如非组件层工具函数）取到当前语言
  useEffect(() => {
    setPack(pack);
  }, [pack]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage: (lang) => onLanguageChange?.(lang),
      t: (key, params) => translate(key, params, pack),
      terr: (msg) => translateError(msg, pack),
    }),
    [language, onLanguageChange, pack],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 取完整 i18n 上下文（当前语言 + 切换回调 + 绑定当前包的 t/terr） */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** 取绑定当前语言包的 t（文案迁移主入口） */
export function useT() {
  return useI18n().t;
}
