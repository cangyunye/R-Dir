import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBinding } from "@/lib/keymap";

/** 命令面板条目：ACTIONS 注册表动作 + 无默认键位的应用命令（退出 / 比对工具 / 检查更新…） */
export interface CommandItem {
  id: string;
  label: string;
  group: string;
  /** 当前平台原始绑定串（如 "mod+shift+n"），展示时经 formatBinding 格式化 */
  binding?: string;
}

/**
 * 命令面板：列表由 keymap.ts 的 ACTIONS 注册表驱动，与快捷键分发、设置里的
 * 键位一览同源；动作执行复用 App 的 actionsRef 分发表，语义与按键触发完全一致。
 * 尺寸按 --rdir-zoom 折算（portal 弹层在根 zoom 下视口被放大，同 DiffDialog）。
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  onRun: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      `${it.label} ${it.group} ${it.binding ?? ""}`.toLowerCase().includes(q),
    );
  }, [items, query]);

  // 分组保持首次出现顺序（Map 有序），组内条目保持注册表顺序
  const groups = useMemo(() => {
    const byGroup = new Map<string, { it: CommandItem; idx: number }[]>();
    filtered.forEach((it, idx) => {
      const arr = byGroup.get(it.group);
      if (arr) arr.push({ it, idx });
      else byGroup.set(it.group, [{ it, idx }]);
    });
    return [...byGroup.entries()].map(([group, its]) => ({ group, its }));
  }, [filtered]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // 过滤结果变化后，选中项夹紧到有效范围
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // ↑↓ 移动选中项时滚进可视区
  useEffect(() => {
    document
      .querySelector(`[data-cmd-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, filtered.length]);

  const run = (it: CommandItem) => {
    onOpenChange(false);
    onRun(it.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        style={{
          width: "calc(min(620px, 92vw) / var(--rdir-zoom, 1))",
          maxHeight: "calc(76vh / var(--rdir-zoom, 1))",
        }}
        className="top-[10%] flex translate-y-0 flex-col gap-0 overflow-hidden p-0 [&_[data-slot=dialog-close]]:hidden"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (filtered.length) setActive((a) => (a + 1) % filtered.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (filtered.length)
                  setActive((a) => (a - 1 + filtered.length) % filtered.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const it = filtered[active];
                if (it) run(it);
              }
            }}
            placeholder="搜索命令…（↑↓ 选择，回车执行）"
            className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.map((g) => (
            <div key={g.group} role="group" aria-label={g.group}>
              <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground">
                {g.group}
              </div>
              {g.its.map(({ it, idx }) => (
                <button
                  key={it.id}
                  type="button"
                  data-cmd-idx={idx}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => run(it)}
                  className={cn(
                    "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm",
                    idx === active
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground",
                  )}
                >
                  <span className="truncate">{it.label}</span>
                  {it.binding ? (
                    <span className="ml-auto shrink-0 pl-4 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {formatBinding(it.binding)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              无匹配命令
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
