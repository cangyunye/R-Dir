import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  CornerUpLeft,
  Folder,
  Link2,
  Pencil,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { completePath } from "@/lib/api";
import { splitPathSegments } from "@/lib/path-segments";

/** 彩虹分段配色：固定色相环（低透明度着色，明暗主题自适应） */
function segmentHue(i: number): number {
  const HUES = [4, 28, 46, 88, 160, 200, 236, 276, 320];
  return HUES[i % HUES.length];
}

export function Toolbar({
  canBack,
  canForward,
  onBack,
  onForward,
  onUp,
  onRefresh,
  path,
  cwd,
  onNavigate,
  searchOpen,
  onToggleSearch,
  /** v0.18 同步比对（底部实时面板）激活状态与切换 */
  syncDiffActive,
  onToggleSyncDiff,
  focusTick,
  leafIsFile = false,
  trailing,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  path: string;
  cwd: string;
  onNavigate: (path: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  syncDiffActive: boolean;
  onToggleSyncDiff: () => void;
  /** 快捷键聚焦信号（Ctrl+L / ⌘+L） */
  focusTick: number;
  /** 地址栏当前展示的是单选文件路径（末段点击=回到其所在目录） */
  leafIsFile?: boolean;
  /** 搜索按钮右侧的插槽（如「已连接窗格」下拉） */
  trailing?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const [completions, setCompletions] = useState<string[]>([]);
  const [compIndex, setCompIndex] = useState(-1);
  const [compOpen, setCompOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(path), [path]);

  // 外部聚焦信号 → 切到编辑模式并聚焦地址栏输入框
  useEffect(() => {
    if (focusTick > 0) {
      setEditing(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [focusTick]);

  // 面包屑模式：路径变化（含首次进入）自动滚动到末段
  useEffect(() => {
    if (!editing) {
      const el = crumbsRef.current;
      if (el) el.scrollLeft = el.scrollWidth;
    }
  }, [path, editing]);

  const enterEdit = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const fetchCompletions = useCallback(
    (value: string) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (!value.trim()) {
        setCompletions([]);
        setCompOpen(false);
        return;
      }
      timerRef.current = window.setTimeout(async () => {
        try {
          const items = await completePath(value, cwd);
          setCompletions(items);
          setCompIndex(-1);
          setCompOpen(items.length > 0);
        } catch {
          setCompletions([]);
          setCompOpen(false);
        }
      }, 120);
    },
    [cwd],
  );

  const closeCompletion = useCallback(() => {
    setCompletions([]);
    setCompOpen(false);
    setCompIndex(-1);
  }, []);

  /** navigateNow=true 直接跳转；false 仅补全到地址栏继续编辑 */
  const choose = useCallback(
    (p: string, navigateNow: boolean) => {
      if (navigateNow) {
        onNavigate(p);
        setDraft(p);
        closeCompletion();
      } else {
        setDraft(p);
        closeCompletion();
        inputRef.current?.focus();
      }
    },
    [onNavigate, closeCompletion],
  );

  return (
    <div className="flex h-10 items-center gap-1 border-b bg-muted/20 px-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onBack}
        disabled={!canBack}
        title="后退"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onForward}
        disabled={!canForward}
        title="前进"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onUp}
        title="上级目录"
      >
        <CornerUpLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onRefresh}
        title="刷新"
      >
        <RefreshCw className="h-4 w-4" />
      </Button>

      {/* 编辑输入框常驻挂载（value 供外部断言/恢复），面包屑模式下隐藏 */}
      <form
        className={cn("relative ml-1 flex-1", !editing && "hidden")}
        onSubmit={(e) => {
          e.preventDefault();
          if (compOpen && compIndex >= 0 && completions[compIndex]) {
            choose(completions[compIndex], true);
          } else if (draft.trim()) {
            onNavigate(draft.trim());
            closeCompletion();
          }
          setEditing(false);
        }}
      >
        <div className="relative">
          <Input
            ref={inputRef}
            id="rdir-addr-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              fetchCompletions(e.target.value);
            }}
            onBlur={() => {
              // 延迟关闭，允许点击下拉项；若 150ms 内已重新聚焦（Esc 后立刻点铅笔/Ctrl+L），
              // 说明用户又进入了编辑，放弃本次收起
              window.setTimeout(() => {
                if (document.activeElement === inputRef.current) return;
                setDraft(path);
                closeCompletion();
                setEditing(false);
              }, 150);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && compOpen && completions.length > 0) {
                e.preventDefault();
                setCompIndex((i) => Math.min(i + 1, completions.length - 1));
              } else if (e.key === "ArrowUp" && compOpen) {
                e.preventDefault();
                setCompIndex((i) => Math.max(i - 1, -1));
              } else if (e.key === "Tab" && compOpen && completions.length > 0) {
                e.preventDefault();
                const idx = compIndex >= 0 ? compIndex : 0;
                choose(completions[idx], false);
              } else if (e.key === "Escape") {
                closeCompletion();
                setDraft(path);
                setEditing(false);
              }
            }}
            className="h-7 pr-12 text-xs"
            placeholder="输入路径后回车跳转，Tab 补全目录"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-6 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            title={draft.trim() && draft.trim() !== path ? "刷新到输入路径" : "刷新当前目录"}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (draft.trim() && draft.trim() !== path) {
                onNavigate(draft.trim());
              } else {
                onRefresh();
              }
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
            <ArrowDownToLine className="h-3.5 w-3.5 opacity-50" />
          </span>
        </div>

        {compOpen && completions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-lg">
            {completions.map((p, i) => (
              <button
                key={p}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(p, true);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                  i === compIndex ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{p}</span>
              </button>
            ))}
          </div>
        )}
      </form>

      {!editing && (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-pathbar="" className="relative ml-1 flex min-w-0 flex-1 items-center">
            <div
              ref={crumbsRef}
              className="flex min-w-0 flex-1 items-center overflow-x-auto py-0.5 [scrollbar-width:thin]"
              onMouseDown={(e) => {
                // 点击空白处进入编辑模式（分段点击由按钮自身处理）
                if (e.target === e.currentTarget) enterEdit();
              }}
            >
              {splitPathSegments(path).map((seg, i, arr) => {
                const isLast = i === arr.length - 1;
                const hue = segmentHue(i);
                return (
                  <button
                    key={`${seg.target}:${i}`}
                    type="button"
                    title={seg.target}
                    onClick={() => {
                      // 末段是单选文件时，点击回到其所在目录
                      onNavigate(isLast && leafIsFile ? seg.target.slice(0, seg.target.length - seg.label.length - 1) || seg.target : seg.target);
                      setEditing(false);
                    }}
                    className={cn(
                      "mx-px flex h-[22px] shrink-0 cursor-default items-center text-[11px] leading-none text-foreground/90",
                      "transition-[filter] hover:brightness-110",
                      isLast && "font-semibold text-foreground",
                    )}
                    style={{
                      background: `hsl(${hue} 65% 55% / ${isLast ? 0.3 : 0.16})`,
                      clipPath:
                        i === 0
                          ? "polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%)"
                          : "polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%, 7px 50%)",
                      paddingLeft: i === 0 ? 10 : 15,
                      paddingRight: 10,
                    }}
                  >
                    <span className="max-w-44 truncate">{seg.label}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              data-pathbar-edit=""
              onMouseDown={(e) => {
                // 用 mousedown 而非 click：click 是组合事件，若中途 React 重渲染替换了
                // 按钮节点，click 不会派发，导致偶发点铅笔没反应
                e.preventDefault();
                enterEdit();
              }}
              title="编辑路径（可复制）"
              className="ml-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-40">
          <ContextMenuItem onClick={enterEdit}>
            <Pencil className="mr-2 h-4 w-4" /> 编辑路径（可复制）
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              navigator.clipboard?.writeText(path).catch(() => {});
            }}
          >
            <Clipboard className="mr-2 h-4 w-4" /> 复制路径
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7", syncDiffActive && "bg-accent text-accent-foreground")}
        onClick={onToggleSyncDiff}
        title={syncDiffActive ? "断开同步比对" : "同步比对（左右窗格）"}
      >
        <Link2 className="h-4 w-4" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7", searchOpen && "bg-accent text-accent-foreground")}
        onClick={onToggleSearch}
        title="搜索（当前层）"
      >
        <Search className="h-4 w-4" />
      </Button>

      {trailing}
    </div>
  );
}
