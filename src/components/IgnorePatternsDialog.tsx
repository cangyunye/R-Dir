import { useEffect, useRef, useState } from "react";
import { EyeOff, X } from "lucide-react";
import { prefixIgnorePattern } from "@/lib/text-diff";
import { useModalLayer } from "@/hooks/useModalLayer";
import { isTopModalLayer } from "@/lib/modal-stack";
import { useT } from "@/lib/LanguageProvider";

/** v0.47 忽略正则预设（Rust regex 与 JS RegExp 公共子集，无环视）：
    每种时间格式独立成预设，label 直接写明格式形态（不让人猜正则），
    examples 行内直接可见（可匹配的变体，如毫秒/时区/非补零）；
    hint 非空时行内注明风险（Epoch 可能误伤普通长数字，故独立 opt-in）。 */
const DIFF_IGNORE_PRESETS: {
  label: string;
  pattern: string;
  hint?: string;
  /** 会忽略的示例（字面量展示，无需翻译） */
  examples: string[];
}[] = [
  {
    label: "日期时间（2024-01-01 12:00:00）",
    pattern:
      "\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}[T ]\\d{1,2}:\\d{2}:\\d{2}(?:[.,]\\d{1,9})?(?:Z|[+-]\\d{2}:?\\d{2})?",
    examples: ["2024-01-01 12:00:00.123", "2024-01-01T12:00:00Z", "2024/1/5 9:00:00"],
  },
  {
    label: "日期（2024-01-01）",
    pattern: "\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}",
    examples: ["2024-01-01", "2024/1/5"],
  },
  {
    label: "时间（12:00:00）",
    pattern: "\\d{1,2}:\\d{2}:\\d{2}(?:[.,]\\d{1,9})?",
    examples: ["12:00:00", "9:05:00.500"],
  },
  {
    label: "syslog 时间（Jan 01 12:00:00）",
    pattern: "[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}",
    examples: ["Jan 01 12:00:00", "Dec  5 09:00:00"],
  },
  {
    label: "紧凑时间（20240101 120000）",
    pattern: "\\b\\d{8}[ T]\\d{6}(?:[.,]\\d+)?\\b",
    examples: ["20240101 120000", "20240101T120000.123"],
  },
  {
    label: "Epoch 时间戳（秒/毫秒）",
    // 秒（10 位，2013–2033）/ 毫秒（13 位），带词边界；普通长数字 ID 不受影响除非恰好同宽
    pattern: "\\b1[5-9]\\d{8}\\b|\\b1[5-9]\\d{11}\\b",
    hint: "可能误伤恰好 10/13 位的普通数字（如长 ID），仅确认日志为 Epoch 时间时启用",
    examples: ["1718159623（秒）", "1718159623123（毫秒）"],
  },
  {
    label: "UUID",
    pattern:
      "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    examples: ["550e8400-e29b-41d4-a716-446655440000"],
  },
];

/**
 * 忽略正则编辑模态框（v0.47）：替代旧内嵌面板（面板太挤、预设难放下）。
 * 左 = 正则编辑（每行一条，随窗伸缩）+ 行首分隔符助手；
 * 右 = 预设菜单（每行一种格式，示例行内可见，不用悬停猜正则）。
 * 应用 = 先关本框再走 TextDiffDialog.applyIgnoreText（有未保存修改先确认）；
 * 取消/Esc/点遮罩 = 丢弃草稿（草稿只存在于本框内）。
 */
export function IgnorePatternsDialog({
  initialValue,
  onApply,
  onClose,
}: {
  initialValue: string;
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const [prefixDelim, setPrefixDelim] = useState("");
  const t = useT();
  // 弹层栈登记：z-90 叠在比对窗（z-85）之上，Esc 由本框优先消费
  useModalLayer("textDiffIgnore", 90, true);

  // Esc 关闭（栈顶仲裁；比对窗先注册的监听器看到本框在栈顶会自动让位）
  const escRef = useRef<(e: KeyboardEvent) => void>(() => {});
  escRef.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!isTopModalLayer("textDiffIgnore")) return;
    if (e.key === "Escape") onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => escRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 追加一条正则（预设按钮 / 分隔符助手同一路径；已有内容先换行） */
  const append = (pattern: string) =>
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${pattern}` : pattern));

  const insertPrefix = () => {
    const p = prefixIgnorePattern(prefixDelim);
    if (p) append(p);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        style={{
          width: "calc(min(1080px, 95vw) / var(--rdir-zoom, 1))",
          height: "calc(min(600px, 82vh) / var(--rdir-zoom, 1))",
        }}
      >
        {/* 头：标题 + 说明 */}
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <EyeOff className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-sm font-semibold">{t("正则忽略")}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {t("比较时忽略匹配的文本（每行一条正则，同时应用于两侧）；应用后重新比较")}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("关闭")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 主体：左编辑 + 右预设菜单 */}
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              autoFocus
              placeholder={t("例如：\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}")}
              className="min-h-0 w-full flex-1 resize-none rounded border bg-transparent px-2 py-1.5 font-mono text-xs leading-5 outline-none focus:ring-1 focus:ring-primary/50"
            />
            {/* 行首分隔符助手：字面量输入生成「忽略行首到首次出现该分隔符为止」的锚定正则，
                忽略时间戳+级别等行首元数据；正则照旧进左侧 textarea，可见可改 */}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="shrink-0 text-muted-foreground">{t("忽略行首到首次出现")}</span>
              <input
                value={prefixDelim}
                onChange={(e) => setPrefixDelim(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    insertPrefix();
                  }
                }}
                placeholder={t("分隔符，如 ] 或 -（字面量，自动转义）")}
                className="w-44 rounded border bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary/50"
              />
              <button
                onClick={insertPrefix}
                disabled={!prefixDelim.trim()}
                title={t("生成「忽略行首到首次出现该分隔符为止」的正则；行内不含分隔符的行不受影响")}
                className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                + {t("插入")}
              </button>
              <span className="text-[10px] text-muted-foreground">
                {t("示例：[2024-01-01 10:00:00] [INFO] 正文，输入 ] → 保留 [INFO] 正文")}
              </span>
            </div>
          </div>

          {/* 右：预设菜单（每行一种格式，示例行内可见；超高滚动） */}
          <div className="flex w-[360px] shrink-0 flex-col border-l pl-3">
            <div className="mb-1.5 shrink-0 text-[11px] text-muted-foreground">
              {t("预设（点击追加到左侧）")}
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
              {DIFF_IGNORE_PRESETS.map((p) => (
                <div key={p.label} className="rounded border px-2 py-1.5">
                  <button
                    onClick={() => append(p.pattern)}
                    title={p.hint ? `${t(p.hint)}\n${p.pattern}` : p.pattern}
                    className="block max-w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] hover:bg-accent hover:text-foreground"
                  >
                    + {t(p.label)}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.examples.map((ex) => (
                      <code
                        key={ex}
                        className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {ex}
                      </code>
                    ))}
                  </div>
                  {p.hint && (
                    <div className="mt-1 text-[10px] leading-4 text-amber-600 dark:text-amber-500">
                      {t(p.hint)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 底：持久化说明 + 取消/应用（应用 = 关闭本框后走确认/重比流程） */}
        <div className="flex items-center gap-2 border-t px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {t("规则跨重启持久化")}
          </span>
          <button
            onClick={onClose}
            className="rounded px-2 py-0.5 text-xs hover:bg-accent hover:text-foreground"
          >
            {t("取消")}
          </button>
          <button
            onClick={() => {
              onClose();
              onApply(draft);
            }}
            className="rounded border bg-primary/10 px-3 py-0.5 text-xs hover:bg-primary/20"
          >
            {t("应用")}
          </button>
        </div>
      </div>
    </div>
  );
}
