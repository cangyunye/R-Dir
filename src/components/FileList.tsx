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
  Settings2,
  Share2,
  Star,
  Trash2,
  Plus,
  FileArchive,
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
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TAG_DEFS, tagLabel, type FileTags, type TagNames } from "@/lib/persist";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { OpenerItem, ShellItem } from "@/lib/openerApi";
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

/** 打开方式：只显示用户通过“选择其他应用…”注册的自定义工具。
 * 说明：内置工具与系统默认应用依赖跨平台路径探测（mac .app / win 注册表），
 * 存在大量寻址盲区（如 Edge 实际安装名为 Microsoft Edge.app），误报“未安装”，
 * 故 v0.4 起移除所有内置探测展示，右键“打开”即系统默认方式（可靠），
 * 其余工具由用户自行注册。 */
function openersForEntry(openers: OpenerItem[]): OpenerItem[] {
  return openers.filter((o) => o.kind === "custom");
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
  onMiddleOpen,
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
  onShareDir,
  onPaste,
  canPaste,
  onSelectAll,
  onInvertSelection,
  fileTags,
  tagNames,
  onRenameTag,
  customQuick,
  onToggleTag,
  onToggleQuick,
  currentDir,
  pluginOpener,
  pluginTerminal,
  openers,
  shells,
  onOpenWith,
  onOpenTerminal,
  onAddCustomOpener,
  dragTarget,
  dragOp,
  showHidden,
  renaming,
  onRenameCommit,
  onRenameCancel,
  isActive,
  onActivate,
  zoom,
  onZoomChange,
  onBack,
  onForward,
  onCompress,
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
  /** 鼠标中键点击目录：在新建标签页中打开该目录 */
  onMiddleOpen: (path: string) => void;
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
  /** v0.7：右键「分享此目录」 */
  onShareDir: (dir: string) => void;
  onPaste: () => void;
  canPaste: boolean;
  onSelectAll: () => void;
  onInvertSelection: () => void;
  fileTags: FileTags;
  tagNames: TagNames;
  onRenameTag: (tagId: string, label: string) => void;
  customQuick: string[];
  onToggleTag: (path: string, tagId: string) => void;
  onToggleQuick: (path: string) => void;
  currentDir: string;
  /** v0.5 插件启用状态（false 时隐藏对应右键入口） */
  pluginOpener: boolean;
  pluginTerminal: boolean;
  /** v0.4 打开方式数据与回调 */
  openers: OpenerItem[];
  shells: ShellItem[];
  onOpenWith: (toolId: string, path: string) => void;
  onOpenTerminal: (shellId: string, path: string) => void;
  onAddCustomOpener: () => Promise<void>;
  dragTarget: boolean;
  dragOp: "copy" | "move";
  showHidden: boolean;
  renaming: RenameState | null;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  isActive: boolean;
  onActivate: () => void;
  /** v0.8 窗口级缩放（0.5–2.0）与 Ctrl+滚轮回调 */
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** v0.8 鼠标侧键：后退 / 前进（button 3 / 4） */
  onBack: () => void;
  onForward: () => void;
  /** v0.8 压缩为 zip / tar / tgz（仅打包） */
  onCompress: (paths: string[], format: "zip" | "tar" | "tgz") => void;
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
  /** 慢速双击重命名：记录上次单击的条目与时间 */
  const lastClickRef = useRef<{ path: string; time: number } | null>(null);
  /** 键盘快速定位：输入缓冲 + 3 秒超时重置 */
  const listScrollRef = useRef<HTMLDivElement>(null);
  /** v0.8.3 虚拟滚动：固定行高，只渲染可视区 +/- buffer 行 */
  const ROW_HEIGHT = 26;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
  };
  // 标签重命名对话框（v0.6.4）
  const [renameTagOpen, setRenameTagOpen] = useState(false);
  const [renameTagId, setRenameTagId] = useState<string>("red");
  const [renameTagInput, setRenameTagInput] = useState("");
  const openRenameTagDialog = () => {
    setRenameTagId("red");
    setRenameTagInput(tagLabel(TAG_DEFS[0], tagNames));
    setRenameTagOpen(true);
  };
  const submitRenameTag = () => {
    const label = renameTagInput.trim();
    if (!label) return;
    onRenameTag(renameTagId, label);
    setRenameTagOpen(false);
  };
  const typeAheadRef = useRef("");
  const typeAheadTimer = useRef<number | null>(null);
  const [typeAhead, setTypeAhead] = useState("");
  const [typeAheadFading, setTypeAheadFading] = useState(false);
  /** v0.8 缩放百分比提示（Ctrl+滚轮后显示，1.2s 淡出） */
  const [zoomTip, setZoomTip] = useState<number | null>(null);
  const zoomTipTimer = useRef<number | null>(null);
  const showZoomTip = (z: number) => {
    setZoomTip(z);
    if (zoomTipTimer.current) window.clearTimeout(zoomTipTimer.current);
    zoomTipTimer.current = window.setTimeout(() => setZoomTip(null), 1200);
  };
  const handleTypeAhead = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;
    const ch = e.key.toLowerCase();
    if (typeAheadTimer.current) window.clearTimeout(typeAheadTimer.current);
    typeAheadRef.current += ch;
    const buf = typeAheadRef.current;
    setTypeAhead(buf);
    setTypeAheadFading(false);
    // 2 秒未输入：重置缓冲并开始淡出提示
    typeAheadTimer.current = window.setTimeout(() => {
      typeAheadRef.current = "";
      setTypeAheadFading(true);
      window.setTimeout(() => setTypeAhead(""), 500);
    }, 2000);
    const idx = sorted.findIndex((x) => x.name.toLowerCase().startsWith(buf));
    if (idx >= 0) {
      onSelect(sorted[idx], false);
      const el = listScrollRef.current;
      if (el) {
        const target = idx * ROW_HEIGHT;
        const top = el.scrollTop;
        const bottom = top + el.clientHeight - ROW_HEIGHT;
        if (target < top) el.scrollTop = target;
        else if (target > bottom) el.scrollTop = target - el.clientHeight + ROW_HEIGHT * 2;
      }
    }
  };
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
    <>
      <Dialog open={renameTagOpen} onOpenChange={setRenameTagOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名标签</DialogTitle>
            <DialogDescription>自定义标签显示名称（不影响已标记的文件）</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-1.5">
            {TAG_DEFS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setRenameTagId(t.id);
                  setRenameTagInput(tagLabel(t, tagNames));
                }}
                className={cn(
                  "h-5 w-5 rounded-full transition-transform",
                  renameTagId === t.id && "scale-125 ring-2 ring-ring ring-offset-2",
                )}
                style={{ background: t.color }}
                title={tagLabel(t, tagNames)}
              />
            ))}
          </div>
          <Input
            value={renameTagInput}
            onChange={(e) => setRenameTagInput(e.target.value)}
            placeholder="标签名称"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRenameTag();
              if (e.key === "Escape") setRenameTagOpen(false);
            }}
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRenameTagOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={submitRenameTag} disabled={!renameTagInput.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div
        ref={containerRef}
        data-pane-id={paneId}
        style={{ zoom }}
        onWheel={(e) => {
          // v0.8 Ctrl+滚轮：窗口级缩放（与浏览器一致），阻止默认滚动
          if (!e.ctrlKey) return;
          e.preventDefault();
          const step = e.deltaY < 0 ? 0.1 : -0.1;
          const next = Math.min(2, Math.max(0.5, Math.round((zoom + step) * 10) / 10));
          if (next !== zoom) {
            onZoomChange(next);
            showZoomTip(next);
          }
        }}
        onAuxClick={(e) => {
          // v0.8 鼠标侧键：后退(3) / 前进(4)，行为同浏览器
          if (e.button === 3) {
            e.preventDefault();
            onBack();
          } else if (e.button === 4) {
            e.preventDefault();
            onForward();
          }
        }}
      onMouseDownCapture={(e) => {
        // 地址栏聚焦时：点击窗格空白保持地址栏光标；点击文件/文件夹行才允许移交焦点
        const ae = document.activeElement as HTMLElement | null;
        if (ae?.id === "rdir-addr-input" && !(e.target as HTMLElement).closest("[data-path]")) {
          e.preventDefault();
        }
      }}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background transition-shadow",
        isActive ? "shadow-[inset_0_0_0_1px_hsl(var(--ring)/0.35)]" : "shadow-[inset_0_0_0_1px_transparent]",
        dragTarget && "shadow-[inset_0_0_0_2px_hsl(var(--primary)/0.7)]",
      )}
      onClick={onActivate}
    >
      {/* 键盘快速定位提示：面板中央大字号，输入后 2 秒淡出 */}
      {typeAhead && (
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-primary/25 bg-background/85 px-5 py-3 text-3xl font-bold text-primary shadow-lg backdrop-blur-sm transition-opacity duration-500",
            typeAheadFading ? "opacity-0" : "opacity-100",
          )}
        >
          定位：{typeAhead}
        </div>
      )}
      {/* v0.8 缩放百分比提示：面板中央，1.2s 淡出 */}
      {zoomTip !== null && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-primary/25 bg-background/85 px-4 py-1.5 text-xl font-semibold text-primary shadow-lg backdrop-blur-sm">
          {Math.round(zoomTip * 100)}%
        </div>
      )}
      {/* 空白处右键：新建 / 粘贴 / 全选等（行上右键由行内菜单接管） */}
      <ContextMenu modal={false}>
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
        ref={listScrollRef}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto pb-8 outline-none select-none"
        onMouseDown={startRubber}
        onMouseDownCapture={(e) => {
          // 地址栏聚焦时保持光标；点击输入框/文本域不抢焦点；否则聚焦列表以接收键盘快速定位
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.id === "rdir-addr-input") return;
          if ((e.target as HTMLElement).closest("input,textarea")) return;
          listScrollRef.current?.focus({ preventScroll: true });
        }}
        onKeyDown={handleTypeAhead}
        onScroll={onListScroll}
      >
        {dragTarget && (
          <div className="sticky top-0 z-10 flex h-6 items-center justify-center bg-primary/10 text-[11px] font-medium text-primary">
            {dragOp === "copy" ? "复制到此处（按住 Option 切换移动）" : "移动到此处"}
          </div>
        )}
        {/* v0.8.3 虚拟滚动：只渲染可视区 +/- buffer 行 */}
        {(() => {
          const BUFFER = 6;
          const total = sorted.length;
          const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
          const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + BUFFER);
          const padTop = start * ROW_HEIGHT;
          const padBottom = (total - end) * ROW_HEIGHT;
          return (
            <>
              {padTop > 0 && <div style={{ height: padTop }} />}
              {sorted.slice(start, end).map((entry) => {
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
                    // 慢速双击（Finder 风格）：两次独立单击同一条目、间隔 >450ms → 重命名
                    if (e.detail === 1) {
                      const now = Date.now();
                      const last = lastClickRef.current;
                      if (last && last.path === entry.path && now - last.time > 450 && now - last.time < 3000) {
                        lastClickRef.current = null;
                        onRename(entry);
                        return;
                      }
                      lastClickRef.current = { path: entry.path, time: now };
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
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      if (entry.is_dir) onMiddleOpen(entry.path);
                    }
                  }}
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
                  style={{
                    gridTemplateColumns: COLUMNS.map((c) => c.width).join(" "),
                    height: ROW_HEIGHT,
                  }}
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
              <ContextMenuContent className="min-w-48" collisionPadding={10} style={{ maxHeight: "calc(100vh - 20px)", overflowY: "auto" }}>
                <ContextMenuItem onClick={() => onOpen(entry)}>
                  <FolderInput className="mr-2 h-4 w-4" /> 打开
                </ContextMenuItem>
                {!entry.is_dir && pluginOpener && (
                  <>
                    <ContextMenuSeparator />
                    <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      打开方式
                    </div>
                    {(() => {
                      const customs = openersForEntry(openers);
                      return customs.length === 0 ? (
                        <ContextMenuItem disabled>
                          未注册打开方式，可点击下方“选择其他应用…”添加
                        </ContextMenuItem>
                      ) : (
                        customs.map((o) => (
                          <ContextMenuItem key={o.id} onClick={() => onOpenWith(o.id, entry.path)}>
                            <span className="mr-2 h-3 w-3 rounded-sm border border-muted-foreground/30" />
                            <span className="flex-1">{o.name}</span>
                          </ContextMenuItem>
                        ))
                      );
                    })()}
                    <ContextMenuItem onClick={() => void onAddCustomOpener()}>
                      <Plus className="mr-2 h-4 w-4" /> 选择其他应用…
                    </ContextMenuItem>
                  </>
                )}
                {entry.is_dir && pluginTerminal && (
                  <>
                    <ContextMenuSeparator />
                    <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      在此处打开终端
                    </div>
                    {shells.map((sh) => (
                      <ContextMenuItem
                        key={sh.id}
                        disabled={!sh.detected}
                        onClick={() => onOpenTerminal(sh.id, entry.path)}
                      >
                        <span className="flex-1">{sh.name}</span>
                        {!sh.detected && (
                          <span className="text-[10px] text-muted-foreground">未安装</span>
                        )}
                      </ContextMenuItem>
                    ))}
                  </>
                )}
                {entry.is_dir && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => onShareDir(entry.path)}>
                      <Share2 className="mr-2 h-4 w-4" /> 分享此目录…
                    </ContextMenuItem>
                  </>
                )}
                <ContextMenuSeparator />
                {/* v0.8 压缩为（仅打包；平铺避免 WKWebView 子菜单失效） */}
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  压缩为
                </div>
                <ContextMenuItem onClick={() => onCompress(targets, "zip")}>
                  <FileArchive className="mr-2 h-4 w-4" /> zip
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onCompress(targets, "tar")}>
                  <FileArchive className="mr-2 h-4 w-4" /> tar（仅打包）
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onCompress(targets, "tgz")}>
                  <FileArchive className="mr-2 h-4 w-4" /> tgz（tar + gzip）
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
                {/* 标签（Finder 风格，直接平铺避免 WKWebView 子菜单点击失效） */}
                <ContextMenuSeparator />
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  标签
                </div>
                {TAG_DEFS.map((t) => {
                  const checked = (fileTags[entry.path] ?? []).includes(t.id);
                  return (
                    <ContextMenuItem
                      key={t.id}
                      onSelect={() => onToggleTag(entry.path, t.id)}
                    >
                      <span
                        className="mr-2 h-3 w-3 rounded-full"
                        style={{ background: t.color }}
                      />
                      {tagLabel(t, tagNames)}
                      {checked && <Check className="ml-auto h-3.5 w-3.5" />}
                    </ContextMenuItem>
                  );
                })}
                <ContextMenuItem onSelect={() => openRenameTagDialog()}>
                  <Settings2 className="mr-2 h-4 w-4" /> 重命名标签…
                </ContextMenuItem>
                <ContextMenuSeparator />
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
              {padBottom > 0 && <div style={{ height: padBottom }} />}
            </>
          );
        })()}
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
        <ContextMenuContent className="min-w-48" collisionPadding={10} style={{ maxHeight: "calc(100vh - 20px)", overflowY: "auto" }}>
          {pluginTerminal && (
            <>
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                在此处打开终端
              </div>
              {shells.map((sh) => (
                <ContextMenuItem
                  key={sh.id}
                  disabled={!sh.detected}
                  onClick={() => onOpenTerminal(sh.id, currentDir)}
                >
                  <span className="flex-1">{sh.name}</span>
                  {!sh.detected && (
                    <span className="text-[10px] text-muted-foreground">未安装</span>
                  )}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
            </>
          )}
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
          <ContextMenuItem onClick={() => onShareDir(currentDir)}>
            <Share2 className="mr-2 h-4 w-4" /> 分享此目录…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> 刷新
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
    </>
  );
}
