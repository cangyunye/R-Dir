/**
 * 预览文本（v0.28.0）：read_text_file（本地/SFTP 均可，预览门控只放行本地）。
 * 大小上限由调用方（PreviewBody）把关；这里负责加载态与 lossy 提示。
 * 渲染截断（v0.28.1）：整段大文本在 break-all <pre> 里的换行布局会长时间占住
 * 主线程（1MB 日志可达秒级），期间任何交互（右键菜单/点击）都被拖慢——
 * 预览只渲染前 RENDER_CAP 字节，超出给出提示。
 * 文本可选中（v0.41）：select-text 显式放行选中（防上游加 select-none 后回退），
 * 右键走应用内菜单（复制选区 / 全选）——桌面 WebView 的默认菜单被 App 全局
 * contextmenu 兜底屏蔽（只放行编辑上下文），<pre> 不在其中，必须自绘。
 */
import { useEffect, useRef, useState } from "react";
import { Clipboard, TextSelect } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { readTextFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/LanguageProvider";

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
  /** v0.41 最近一次选区缓存：右键的 mousedown 在部分平台（Linux/Win Chromium）会把
   *  选区先清掉再弹菜单，onOpenChange 瞬间快照会拿到空串——改经 selectionchange
   *  持续记录本 <pre> 内的选区，「复制」用缓存值（ macOS 保选区语义下缓存即当前值）。
   *  hasSel 走 state：JSX 的 disabled 是上次渲染的快照，ref 变化不会触发菜单内容重渲染 */
  const selRef = useRef("");
  const [hasSel, setHasSel] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const t = useT();

  useEffect(() => {
    const onSelChange = () => {
      const sel = window.getSelection();
      if (sel && sel.toString() && preRef.current?.contains(sel.anchorNode)) {
        selRef.current = sel.toString();
        setHasSel(true);
      }
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, []);

  const selectAll = () => {
    const pre = preRef.current;
    if (!pre) return;
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

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
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* select-text：显式放行选中复制；拖拽选中不被右键菜单触发器干扰 */}
          <div className="min-h-0 flex-1 select-text overflow-auto p-3">
            <pre
              ref={preRef}
              className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground select-text"
            >
              {state.text}
            </pre>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-36">
          <ContextMenuItem
            onSelect={() => {
              const text = selRef.current;
              if (text) navigator.clipboard?.writeText(text).catch(() => {});
            }}
            disabled={!hasSel}
          >
            <Clipboard className="mr-2 h-4 w-4" /> {t("复制")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={selectAll}>
            <TextSelect className="mr-2 h-4 w-4" /> {t("全选")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
