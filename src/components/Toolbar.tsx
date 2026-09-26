import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  CornerUpLeft,
  Folder,
  Link2,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { completePath } from "@/lib/api";

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
  /** 搜索按钮右侧的插槽（如「已连接窗格」下拉） */
  trailing?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(path);
  const [completions, setCompletions] = useState<string[]>([]);
  const [compIndex, setCompIndex] = useState(-1);
  const [compOpen, setCompOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(path), [path]);

  // 外部聚焦信号 → 聚焦地址栏输入框
  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusTick]);

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

      <form
        className="relative ml-1 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (compOpen && compIndex >= 0 && completions[compIndex]) {
            choose(completions[compIndex], true);
          } else if (draft.trim()) {
            onNavigate(draft.trim());
            closeCompletion();
          }
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
              // 延迟关闭，允许点击下拉项
              window.setTimeout(() => {
                setDraft(path);
                closeCompletion();
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
