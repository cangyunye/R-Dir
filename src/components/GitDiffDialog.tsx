import { useState } from "react";
import { ClipboardPaste, FileDiff, X } from "lucide-react";
import { parseUnifiedDiff } from "@/lib/text-diff";
import { Button } from "@/components/ui/button";

/**
 * Git Diff 粘贴导入（v0.19）：把 git diff 输出 / patch 文本粘进来直接渲染左右差异。
 * 纯解析、不依赖本机 git；`.patch`/`.diff` 文件请用右键「查看 Diff」。
 */
export function GitDiffDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    if (!text.trim()) return;
    if (parseUnifiedDiff(text).length === 0) {
      setError("未识别出 diff 内容：需要 unified diff 格式（@@ 开头的 hunk），如 `git diff` 的输出");
      return;
    }
    onConfirm(text);
  };

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        style={{
          width: "calc(min(760px, 95vw) / var(--rdir-zoom, 1))",
          height: "calc(70vh / var(--rdir-zoom, 1))",
        }}
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <FileDiff className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">打开 Git Diff…</span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b px-4 py-1.5 text-[11px] text-muted-foreground">
          粘贴 <span className="font-mono">git diff</span> 输出或 patch 内容（支持多文件），解析后左右对照显示。
        </div>
        <div className="min-h-0 flex-1 p-3">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            placeholder={"diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n…"}
            className="h-full w-full resize-none rounded border bg-muted/20 p-2 font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary"
            spellCheck={false}
          />
        </div>
        {error && <div className="border-t px-4 py-1.5 text-[11px] text-destructive">{error}</div>}
        <div className="flex items-center gap-2 border-t px-4 py-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => {
              void navigator.clipboard
                ?.readText()
                .then((t) => {
                  if (t) {
                    setText(t);
                    setError(null);
                  }
                })
                .catch(() => setError("读取剪贴板失败（可在文本框中 Ctrl+V 粘贴）"));
            }}
          >
            <ClipboardPaste className="h-3.5 w-3.5" /> 从剪贴板粘贴
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button size="sm" disabled={!text.trim()} onClick={confirm}>
              解析并比较
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
