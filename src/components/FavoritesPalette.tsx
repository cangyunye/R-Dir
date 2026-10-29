import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, RotateCw, Star, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/format";
import { searchFavorites } from "@/lib/favorites";
import type { TabFavorite } from "@/lib/types";
import { useModalLayer } from "@/hooks/useModalLayer";

/** 行内操作按钮（更新为当前标签 / 重命名 / 删除）：激活行常显，其余 hover 显示 */
function RowAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </button>
  );
}

/** 高亮匹配字符（positions 为 UTF-16 下标，与 fuzzyMatch 同口径；仿 QuickJump） */
function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {text.split("").map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold text-primary">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

/**
 * 收藏夹面板：标签布局的命名收藏（受控组件，逻辑在 App）。
 * 搜索 = 收藏名称 + 各窗格路径的 fzf 子序列匹配（fuzzy 打分取最高，见 lib/favorites）；
 * 结构仿 CommandPalette（Radix Dialog + 顶部输入 + ↑↓/Enter/Esc + zoom 折算）。
 */
export function FavoritesPalette({
  open,
  onOpenChange,
  favorites,
  onOpenFavorite,
  onAddFavorite,
  onRenameFavorite,
  onRemoveFavorite,
  onUpdateFavorite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  favorites: TabFavorite[];
  onOpenFavorite: (id: string) => void;
  onAddFavorite: () => void;
  onRenameFavorite: (id: string, name: string) => void;
  onRemoveFavorite: (id: string) => void;
  onUpdateFavorite: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /** 行内重命名会话：{收藏 id, 草稿}；Enter 提交 / Esc 或失焦取消（空名取消） */
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // v0.34.1 弹层栈登记：Esc 由 Radix 处理，登记只为让下层弹层（设置等）让位
  useModalLayer("favorites", 50, open);

  const rows = useMemo(() => searchFavorites(favorites, query), [favorites, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setRenaming(null);
    }
  }, [open]);

  // 过滤结果变化后，选中项夹紧到有效范围
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // ↑↓ 移动选中项时滚进可视区
  useEffect(() => {
    document
      .querySelector(`[data-fav-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]);

  const run = (id: string) => {
    onOpenChange(false);
    onOpenFavorite(id);
  };

  const confirmRename = () => {
    if (renaming) onRenameFavorite(renaming.id, renaming.draft);
    setRenaming(null);
    inputRef.current?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        style={{
          width: "calc(min(680px, 92vw) / var(--rdir-zoom, 1))",
          maxHeight: "calc(72vh / var(--rdir-zoom, 1))",
        }}
        className="top-[10%] flex translate-y-0 flex-col gap-0 overflow-hidden p-0 [&_[data-slot=dialog-close]]:hidden"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">收藏夹（标签布局）</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Star className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (rows.length) setActive((a) => (a + 1) % rows.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (rows.length)
                  setActive((a) => (a - 1 + rows.length) % rows.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const row = rows[active];
                if (row) run(row.item.id);
              }
            }}
            placeholder="搜索收藏（名称或窗格路径）…"
            className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.map((row, idx) => {
            const fav = row.item;
            const isRenaming = renaming?.id === fav.id;
            const paneCount = fav.tab.panes.length;
            return (
              <div
                key={fav.id}
                data-fav-idx={idx}
                data-testid="fav-row"
                onMouseEnter={() => setActive(idx)}
                onClick={() => {
                  if (!isRenaming) run(fav.id);
                }}
                className={cn(
                  "group flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left",
                  idx === active
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/60",
                )}
              >
                <Star className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renaming.draft}
                    onChange={(e) => setRenaming({ id: fav.id, draft: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        confirmRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setRenaming(null);
                        inputRef.current?.focus();
                      }
                    }}
                    onBlur={confirmRename}
                    className="h-6 w-full rounded-sm border bg-background px-1.5 text-sm outline-none"
                  />
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        <Highlight text={fav.name} positions={row.namePositions} />
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        <Highlight text={row.path} positions={row.pathPositions} />
                        {paneCount > 1 ? ` · +${paneCount - 1} 窗格` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                      {formatTime(Date.parse(fav.updatedAt))}
                    </span>
                    <div
                      className={cn(
                        "flex shrink-0 items-center gap-0.5",
                        idx === active ? "flex" : "hidden group-hover:flex",
                      )}
                    >
                      <RowAction
                        title="用当前标签更新此收藏"
                        onClick={() => onUpdateFavorite(fav.id)}
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                      </RowAction>
                      <RowAction title="重命名" onClick={() => setRenaming({ id: fav.id, draft: fav.name })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </RowAction>
                      <RowAction title="删除收藏" onClick={() => onRemoveFavorite(fav.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </RowAction>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              {favorites.length === 0
                ? "暂无收藏：右键标签页「收藏此标签页」，或用下方按钮收藏当前标签"
                : "无匹配收藏"}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2">
          <button
            type="button"
            onClick={onAddFavorite}
            className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            收藏当前标签页
          </button>
          <span className="text-[11px] text-muted-foreground">
            {favorites.length} 项收藏 · ↑↓ 选择 · ↵ 打开
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
