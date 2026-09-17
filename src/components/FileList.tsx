import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  CheckSquare,
  Clipboard,
  Copy,
  FilePlus2,
  FolderInput,
  FolderPlus,
  Pencil,
  RefreshCw,
  Scissors,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileEntry, SortDir, SortKey } from "@/lib/types";
import { formatSize, formatTime } from "@/lib/format";
import { FileIcon } from "@/components/FileIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { TAG_DEFS, type FileTags } from "@/lib/persist";
import { TagDots } from "@/components/TagView";

const COLUMNS: { key: SortKey | null; label: string; width: string }[] = [
  { key: "name", label: "名称", width: "minmax(0, 1fr)" },
  { key: "size", label: "大小", width: "84px" },
  { key: "modified", label: "修改时间", width: "132px" },
  { key: "type", label: "类型", width: "80px" },
  { key: null, label: "权限", width: "88px" },
];

function extLabel(entry: FileEntry): string {
  if (entry.is_dir) return "目录";
  if (entry.extension) return entry.extension.toUpperCase();
  return "文件";
}

/** 行内重命名输入框 */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // 延迟聚焦：避免右键菜单关闭时 radix 的焦点恢复抢先夺走输入框焦点（触发 onBlur 立即提交）
    const t = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 120);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onCommit(value)}
      className="h-6 min-w-0 flex-1 px-1.5 text-[13px]"
      spellCheck={false}
    />
  );
}

export interface RenameState {
  path: string;
  name: string;
}

export function FileList({
  paneId,
  entries,
  sortKey,
  sortDir,
  onSort,
  selection,
  onSelect,
  onSelectRange,
  onClearSelection,
  onOpen,
  onCopy,
  onCut,
  onDelete,
  onRename,
  onCopyPath,
  onRefresh,
  onDropPaths,
  onDragOverChange,
  onNewFolder,
  onNewFile,
  onPaste,
  canPaste,
  onSelectAll,
  onInvertSelection,
  fileTags,
  customQuick,
  onToggleTag,
  onToggleQuick,
  dragTarget,
  dragOp,
  showHidden,
  renaming,
  onRenameCommit,
  onRenameCancel,
  isActive,
  onActivate,
}: {
  paneId: number;
  entries: FileEntry[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  selection: string[];
  onSelect: (entry: FileEntry, additive: boolean) => void;
  onSelectRange: (paths: string[]) => void;
  onClearSelection: () => void;
  onOpen: (entry: FileEntry) => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onDelete: (paths: string[]) => void;
  onRename: (entry: FileEntry) => void;
  onCopyPath: (path: string) => void;
  onRefresh: () => void;
  /** 跨窗格拖拽落盘：targetPaneId 为鼠标松开时检测到的目标窗格 */
  onDropPaths: (
    sourcePaneId: number,
    paths: string[],
    op: "copy" | "move",
    targetPaneId: number,
  ) => void;
  onDragOverChange: (target: { targetPaneId: number; op: "copy" | "move" } | null) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onSelectAll: () => void;
  onInvertSelection: () => void;
  fileTags: FileTags;
  customQuick: string[];
  onToggleTag: (path: string, tagId: string) => void;
  onToggleQuick: (path: string) => void;
  dragTarget: boolean;
  dragOp: "copy" | "move";
  showHidden: boolean;
  renaming: RenameState | null;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  isActive: boolean;
  onActivate: () => void;
}) {
  const sorted = useMemo(() => {
    const visible = showHidden
      ? entries
      : entries.filter((e) => !e.name.startsWith("."));
    const dir = sortDir === "asc" ? 1 : -1;
    return [...visible].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
          break;
        case "size":
          cmp = a.size - b.size;
          break;
        case "modified":
          cmp = (a.modified ?? 0) - (b.modified ?? 0);
          break;
        case "type":
          cmp = extLabel(a).localeCompare(extLabel(b));
          break;
      }
      return cmp * dir;
    });
  }, [entries, sortKey, sortDir, showHidden]);

  const primary = selection.length > 0 ? selection[0] : null;
  /** Shift 范围选择的锚点 */
  const anchorRef = useRef<string | null>(null);
  /** 行拖拽的目标集合：已选中项按下时携带全部选中项 */
  const targetsFor = (entry: FileEntry): string[] =>
    propsRef.current.selection.includes(entry.path)
      ? propsRef.current.selection
      : [entry.path];

  // ---- 自实现拖拽 + 矩形框选（WKWebView 的 HTML5 DnD 不可靠） ----
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dragCandRef = useRef<{ x: number; y: number; paths: string[] } | null>(null);
  const dragActiveRef = useRef(false);
  const lastTargetRef = useRef<number | null>(null);
  const lastOpRef = useRef<"copy" | "move">("copy");
  const rubberRef = useRef<{
    x0: number;
    y0: number;
    additive: boolean;
    /** true = 从行上按下（未选中项），false = 从空白按下 */
    fromRow: boolean;
  } | null>(null);
  /** 框选激活后抑制随后的 click（避免单行选择覆盖框选结果） */
  const suppressClickRef = useRef(false);
  const [rubber, setRubber] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);

  // 用 ref 保存最新 props，避免监听器闭包拿到过期值
  const propsRef = useRef({
    onDropPaths,
    onDragOverChange,
    onClearSelection,
    onSelectRange,
    selection,
    paneId,
  });
  propsRef.current = { onDropPaths, onDragOverChange, onClearSelection, onSelectRange, selection, paneId };

  const cleanupDrag = () => {
    window.removeEventListener("mousemove", onWinMouseMove);
    window.removeEventListener("mouseup", onWinMouseUp);
    document.body.style.userSelect = "";
    dragActiveRef.current = false;
    lastTargetRef.current = null;
    lastOpRef.current = "copy";
    if (ghostRef.current) ghostRef.current.style.opacity = "0";
    propsRef.current.onDragOverChange(null);
  };

  const onWinMouseMove = (e: MouseEvent) => {
    const cand = dragCandRef.current;
    if (cand) {
      const dx = e.clientX - cand.x;
      const dy = e.clientY - cand.y;
      if (Math.hypot(dx, dy) > 5) {
        if (!dragActiveRef.current) {
          dragActiveRef.current = true;
          document.body.style.userSelect = "none";
          if (ghostRef.current) ghostRef.current.style.opacity = "1";
        }
        e.preventDefault();
        const op: "copy" | "move" = e.altKey ? "move" : "copy";
        if (ghostRef.current) {
          ghostRef.current.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
          ghostRef.current.textContent = `${op === "move" ? "移动" : "复制"} ${cand.paths.length} 项`;
        }
        // 目标窗格检测（仅变化时通知，避免高频重渲染）
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const paneEl = el?.closest?.("[data-pane-id]") as HTMLElement | null;
        const targetId = paneEl ? Number(paneEl.dataset.paneId) : null;
        if (targetId !== lastTargetRef.current || op !== lastOpRef.current) {
          lastTargetRef.current = targetId;
          lastOpRef.current = op;
          propsRef.current.onDragOverChange(
            targetId !== null ? { targetPaneId: targetId, op } : null,
          );
        }
      }
      return;
    }
    const rb = rubberRef.current;
    if (rb) {
      const cRect = containerRef.current?.getBoundingClientRect();
      if (cRect) {
        setRubber({
          left: Math.min(rb.x0, e.clientX) - cRect.left,
          top: Math.min(rb.y0, e.clientY) - cRect.top,
          right: Math.max(rb.x0, e.clientX) - cRect.left,
          bottom: Math.max(rb.y0, e.clientY) - cRect.top,
        });
      }
    }
  };

  const onWinMouseUp = (e: MouseEvent) => {
    const cand = dragCandRef.current;
    if (cand) {
      dragCandRef.current = null;
      const wasActive = dragActiveRef.current;
      if (wasActive) {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const paneEl = el?.closest?.("[data-pane-id]") as HTMLElement | null;
        const targetId = paneEl ? Number(paneEl.dataset.paneId) : null;
        const op = lastOpRef.current;
        cleanupDrag();
        if (targetId !== null && targetId !== propsRef.current.paneId && cand.paths.length > 0) {
          propsRef.current.onDropPaths(propsRef.current.paneId, cand.paths, op, targetId);
        }
      } else {
        cleanupDrag();
      }
      return;
    }
    const rb = rubberRef.current;
    if (rb) {
      rubberRef.current = null;
      const cRect = containerRef.current?.getBoundingClientRect();
      setRubber(null);
      cleanupDrag();
      if (!cRect) return;
      const rx0 = Math.min(rb.x0, e.clientX) - cRect.left;
      const rx1 = Math.max(rb.x0, e.clientX) - cRect.left;
      const ry0 = Math.min(rb.y0, e.clientY) - cRect.top;
      const ry1 = Math.max(rb.y0, e.clientY) - cRect.top;
      const moved = Math.hypot(e.clientX - rb.x0, e.clientY - rb.y0) > 3;
      if (!moved) {
        // 单击空白 → 取消选择；单击行 → 交给 click 正常选择
        if (!rb.fromRow) propsRef.current.onClearSelection();
        return;
      }
      // 框选已发生，抑制随后的 click（否则单行选择会覆盖框选结果）
      suppressClickRef.current = true;
      const hit: string[] = [];
      containerRef.current?.querySelectorAll<HTMLElement>("[data-path]").forEach((row) => {
        const r = row.getBoundingClientRect();
        const rel = {
          left: r.left - cRect.left,
          top: r.top - cRect.top,
          right: r.right - cRect.left,
          bottom: r.bottom - cRect.top,
        };
        if (rel.right >= rx0 && rel.left <= rx1 && rel.bottom >= ry0 && rel.top <= ry1) {
          const p = row.dataset.path;
          if (p) hit.push(p);
        }
      });
      if (rb.additive) {
        propsRef.current.onSelectRange([
          ...new Set([...propsRef.current.selection, ...hit]),
        ]);
      } else {
        propsRef.current.onSelectRange(hit);
      }
      return;
    }
    cleanupDrag();
  };

  const startRowPress = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const fromSelected = propsRef.current.selection.includes(entry.path);
    if (fromSelected) {
      // 从已选中项按下 → 文件拖拽（复制/移动）
      dragCandRef.current = { x: e.clientX, y: e.clientY, paths: targetsFor(entry) };
    } else {
      // 从未选中项按下 → 框选起点（Windows 资源管理器语义）
      rubberRef.current = {
        x0: e.clientX,
        y0: e.clientY,
        additive: e.metaKey || e.ctrlKey || e.shiftKey,
        fromRow: true,
      };
    }
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
  };

  const startRubber = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    rubberRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      additive: e.metaKey || e.ctrlKey || e.shiftKey,
      fromRow: false,
    };
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
  };

  return (
    <div
      ref={containerRef}
      data-pane-id={paneId}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background transition-shadow",
        isActive ? "shadow-[inset_0_0_0_1px_hsl(var(--ring)/0.35)]" : "shadow-[inset_0_0_0_1px_transparent]",
        dragTarget && "shadow-[inset_0_0_0_2px_hsl(var(--primary)/0.7)]",
      )}
      onClick={onActivate}
    >
      {/* 空白处右键：新建 / 粘贴 / 全选等（行上右键由行内菜单接管） */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* 表头 */}
      <div
        className="grid shrink-0 items-center border-b bg-muted/30 text-xs font-medium text-muted-foreground select-none"
        style={{ gridTemplateColumns: COLUMNS.map((c) => c.width).join(" ") }}
      >
        {COLUMNS.map((col) => (
          <button
            key={col.label}
            className={cn(
              "flex h-7 items-center gap-1 px-2 text-left hover:bg-muted/60",
              col.key === null && "cursor-default hover:bg-transparent",
            )}
            onClick={() => col.key && onSort(col.key)}
            disabled={col.key === null}
          >
            {col.label}
            {col.key &&
              (sortKey === col.key ? (
                sortDir === "asc" ? (
                  <ArrowUp className="h-3 w-3" />
                ) : (
                  <ArrowDown className="h-3 w-3" />
                )
              ) : (
                <ArrowUpDown className="h-3 w-3 opacity-30" />
              ))}
          </button>
        ))}
      </div>

      {/* 行 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto pb-8 outline-none select-none"
        onMouseDown={startRubber}
      >
        {dragTarget && (
          <div className="sticky top-0 z-10 flex h-6 items-center justify-center bg-primary/10 text-[11px] font-medium text-primary">
            {dragOp === "copy" ? "复制到此处（按住 Option 切换移动）" : "移动到此处"}
          </div>
        )}
        {sorted.map((entry) => {
          const selected = selection.includes(entry.path);
          const isPrimary = primary === entry.path;
          const isRenaming = renaming?.path === entry.path;
          const targets = selection.includes(entry.path) ? selection : [entry.path];
          return (
            <ContextMenu key={entry.path}>
              <ContextMenuTrigger asChild>
                <div
                  role="row"
                  tabIndex={0}
                  data-path={entry.path}
                  onMouseDown={(e) => startRowPress(e, entry)}
                  onClick={(e) => {
                    // 框选刚结束，抑制随后的 click，避免单行选择覆盖框选结果
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    if (e.shiftKey) {
                      e.preventDefault();
                      const anchor = anchorRef.current;
                      const anchorIdx = anchor ? sorted.findIndex((x) => x.path === anchor) : -1;
                      const clickIdx = sorted.findIndex((x) => x.path === entry.path);
                      if (anchorIdx >= 0 && clickIdx >= 0 && anchorIdx !== clickIdx) {
                        const [lo, hi] =
                          anchorIdx < clickIdx ? [anchorIdx, clickIdx] : [clickIdx, anchorIdx];
                        onSelectRange(sorted.slice(lo, hi + 1).map((x) => x.path));
                        return;
                      }
                      anchorRef.current = entry.path;
                      onSelect(entry, false);
                      return;
                    }
                    anchorRef.current = entry.path;
                    onSelect(entry, e.metaKey || e.ctrlKey);
                  }}
                  onDoubleClick={() => onOpen(entry)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(entry);
                    if (e.key === " ") {
                      e.preventDefault();
                      onSelect(entry, e.metaKey || e.ctrlKey);
                    }
                  }}
                  className={cn(
                    "grid cursor-default items-center border-b text-[13px] transition-colors",
                    selected ? "bg-primary/10" : "hover:bg-muted/40",
                    isPrimary && "ring-1 ring-inset ring-primary/40",
                  )}
                  style={{ gridTemplateColumns: COLUMNS.map((c) => c.width).join(" ") }}
                >
                  <div className="flex min-w-0 items-center gap-2 px-2 py-1">
                    <FileIcon entry={entry} size={16} className="shrink-0" />
                    <TagDots path={entry.path} fileTags={fileTags} />
                    {isRenaming ? (
                      <RenameInput
                        initial={renaming.name}
                        onCommit={(name) => onRenameCommit(entry.path, name)}
                        onCancel={onRenameCancel}
                      />
                    ) : (
                      <span
                        className={cn(
                          "truncate",
                          entry.is_dir && "font-medium",
                          entry.is_symlink && "italic",
                        )}
                        title={entry.name}
                      >
                        {entry.name}
                      </span>
                    )}
                  </div>
                  <div className="px-2 text-right tabular-nums text-muted-foreground">
                    {entry.is_dir ? "—" : formatSize(entry.size)}
                  </div>
                  <div className="px-2 tabular-nums text-muted-foreground">
                    {formatTime(entry.modified)}
                  </div>
                  <div className="px-2 text-muted-foreground">{extLabel(entry)}</div>
                  <div className="px-2 font-mono text-xs text-muted-foreground">
                    {entry.permissions}
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="min-w-48">
                <ContextMenuItem onClick={() => onOpen(entry)}>
                  <FolderInput className="mr-2 h-4 w-4" /> 打开
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onCopy(targets)}>
                  <Copy className="mr-2 h-4 w-4" /> 复制
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onCut(targets)}>
                  <Scissors className="mr-2 h-4 w-4" /> 剪切
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onRename(entry)}>
                  <Pencil className="mr-2 h-4 w-4" /> 重命名
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => onDelete(targets)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" /> 删除（回收站）
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onCopyPath(entry.path)}>
                  <Clipboard className="mr-2 h-4 w-4" /> 复制路径
                </ContextMenuItem>
                <ContextMenuSeparator />
                {/* 标签（Finder 风格） */}
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <Tag className="mr-2 h-4 w-4" /> 标签
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="min-w-40">
                    {TAG_DEFS.map((t) => {
                      const checked = (fileTags[entry.path] ?? []).includes(t.id);
                      return (
                        <ContextMenuItem
                          key={t.id}
                          onClick={() => onToggleTag(entry.path, t.id)}
                        >
                          <span
                            className="mr-2 h-3 w-3 rounded-full"
                            style={{ background: t.color }}
                          />
                          {t.label}
                          {checked && <Check className="ml-auto h-3.5 w-3.5" />}
                        </ContextMenuItem>
                      );
                    })}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                {/* 快捷访问（Finder 边栏式） */}
                <ContextMenuItem onClick={() => onToggleQuick(entry.path)}>
                  <Star className="mr-2 h-4 w-4" />
                  {customQuick.includes(entry.path) ? "从快捷访问移除" : "添加到快捷访问"}
                </ContextMenuItem>
                <ContextMenuItem onClick={onRefresh}>
                  <RefreshCw className="mr-2 h-4 w-4" /> 刷新
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {sorted.length === 0 && (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
            此目录为空
          </div>
        )}

        {/* 矩形框选 */}
        {rubber && (
          <div
            className="pointer-events-none absolute z-10 border border-primary/70 bg-primary/10"
            style={{
              left: rubber.left,
              top: rubber.top,
              width: Math.max(0, rubber.right - rubber.left),
              height: Math.max(0, rubber.bottom - rubber.top),
            }}
          />
        )}
      </div>

      {/* 拖拽幽灵标签（常驻 DOM，拖动时显示） */}
      <div
        ref={ghostRef}
        className="pointer-events-none fixed left-0 top-0 z-50 rounded-md border bg-popover px-2 py-1 text-xs opacity-0 shadow-lg"
        style={{ transform: "translate(0px, 0px)" }}
      >
        复制 0 项
      </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-48">
          <ContextMenuItem onClick={onNewFolder}>
            <FolderPlus className="mr-2 h-4 w-4" /> 新建文件夹
          </ContextMenuItem>
          <ContextMenuItem onClick={onNewFile}>
            <FilePlus2 className="mr-2 h-4 w-4" /> 新建文本文件
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onPaste} disabled={!canPaste}>
            <Clipboard className="mr-2 h-4 w-4" /> 粘贴
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onSelectAll}>
            <CheckSquare className="mr-2 h-4 w-4" /> 全选
          </ContextMenuItem>
          <ContextMenuItem onClick={onInvertSelection}>
            <CheckSquare className="mr-2 h-4 w-4" /> 反向选择
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> 刷新
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
