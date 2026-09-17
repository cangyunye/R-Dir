import { useEffect } from "react";
import { Keyboard, X } from "lucide-react";
import { ACTIONS, bindingOf, formatBinding } from "@/lib/keymap";

/**
 * 设置 / 快捷键一览对话框（P1 只读版）。
 * P2 将在此加入按键录制与配置持久化。
 */
export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const groups = [...new Set(ACTIONS.map((a) => a.group))];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Keyboard className="h-4 w-4" /> 快捷键一览
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭（Esc）"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            {navigator.userAgent.includes("Mac")
              ? "当前平台：macOS（⌘ 为主修饰键）"
              : "当前平台：Windows（Ctrl 为主修饰键）"}
            。键位可在后续版本中自定义。
          </p>
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="mb-1.5 text-xs font-semibold text-primary">{g}</div>
              <div className="overflow-hidden rounded-md border">
                {ACTIONS.filter((a) => a.group === g).map((a, i, arr) => (
                  <div
                    key={a.id}
                    className={
                      "flex items-center justify-between gap-3 px-3 py-1.5 text-xs " +
                      (i < arr.length - 1 ? "border-b " : "") +
                      (i % 2 === 0 ? "bg-muted/30" : "")
                    }
                  >
                    <span className="truncate text-foreground">{a.label}</span>
                    <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                      {formatBinding(bindingOf(a))}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
