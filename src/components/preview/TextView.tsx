/**
 * 预览文本（v0.28.0）：read_text_file（本地/SFTP 均可，预览门控只放行本地）。
 * 大小上限由调用方（PreviewBody）把关；这里负责加载态与 lossy 提示。
 */
import { useEffect, useState } from "react";
import { readTextFile } from "@/lib/api";
import { cn } from "@/lib/utils";

export function TextView({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const [state, setState] = useState<{ text: string; lossy: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setState(null);
    setFailed(false);
    let cancelled = false;
    readTextFile(path)
      .then((r) => {
        if (!cancelled) setState({ text: r.text, lossy: r.lossy });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return (
      <div className={cn("flex h-full items-center justify-center p-4 text-xs text-muted-foreground", className)}>
        文本读取失败
      </div>
    );
  }
  if (!state) {
    return <div className={cn("h-full w-full animate-pulse bg-muted/40", className)} />;
  }
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid="preview-text">
      {state.lossy && (
        <div className="border-b bg-muted/40 px-3 py-1 text-[10px] text-muted-foreground">
          文件含非 UTF-8 字节，按近似字符显示
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
          {state.text}
        </pre>
      </div>
    </div>
  );
}
