/**
 * 预览文本（v0.28.0）：read_text_file（本地/SFTP 均可，预览门控只放行本地）。
 * 大小上限由调用方（PreviewBody）把关；这里负责加载态与 lossy 提示。
 * 渲染截断（v0.28.1）：整段大文本在 break-all <pre> 里的换行布局会长时间占住
 * 主线程（1MB 日志可达秒级），期间任何交互（右键菜单/点击）都被拖慢——
 * 预览只渲染前 RENDER_CAP 字节，超出给出提示。
 */
import { useEffect, useState } from "react";
import { readTextFile } from "@/lib/api";
import { cn } from "@/lib/utils";

const RENDER_CAP = 256 * 1024;

export function TextView({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const [state, setState] = useState<{
    text: string;
    lossy: boolean;
    truncated: boolean;
    /** v0.30 后端实际采用的解码；UTF-16 时给提示（Windows 工具写出的 ini/reg 常见） */
    encoding: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setState(null);
    setFailed(false);
    let cancelled = false;
    readTextFile(path)
      .then((r) => {
        if (!cancelled) {
          const truncated = r.text.length > RENDER_CAP;
          setState({
            text: truncated ? r.text.slice(0, RENDER_CAP) : r.text,
            lossy: r.lossy,
            truncated,
            encoding: r.encoding ?? "UTF-8",
          });
        }
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
      {state.encoding.startsWith("UTF-16") && (
        <div className="border-b bg-muted/40 px-3 py-1 text-[10px] text-muted-foreground">
          已按 {state.encoding} 解码（Windows 记事本 / PowerShell 写出的配置常见编码）
        </div>
      )}
      {state.lossy && (
        <div className="border-b bg-muted/40 px-3 py-1 text-[10px] text-muted-foreground">
          文件含非 {state.encoding} 字节，按近似字符显示
        </div>
      )}
      {state.truncated && (
        <div className="border-b bg-muted/40 px-3 py-1 text-[10px] text-muted-foreground">
          文件较大，仅预览前 256 KB，完整内容请用外部应用打开
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
