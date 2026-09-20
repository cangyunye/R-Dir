import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PaneNode, PaneState, SplitDir } from "@/lib/types";
import type { FileTags } from "@/lib/persist";
import { FileList, type RenameState } from "@/components/FileList";
import { PropertiesBar } from "@/components/PropertiesBar";
import { TagView } from "@/components/TagView";
import type { TagNames } from "@/lib/persist";
import type { FileEntry, SortKey } from "@/lib/types";
import type { OpenerItem, ShellItem } from "@/lib/openerApi";

export interface PaneHandlers {
  onSort: (paneId: number, key: SortKey) => void;
  onSelect: (paneId: number, entry: FileEntry, additive: boolean) => void;
  onSelectRange: (paneId: number, paths: string[]) => void;
  onClearSelection: (paneId: number) => void;
  onOpen: (paneId: number, entry: FileEntry) => void;
  /** 鼠标中键点击目录：在新建标签页中打开该目录 */
  onMiddleOpen: (paneId: number, path: string) => void;
  /** v0.4 打开方式：用指定工具打开路径 */
  /** v0.4 打开方式 / 终端数据 */
  openers: OpenerItem[];
  /** v0.5 插件启用状态 */
  pluginOpener: boolean;
  pluginTerminal: boolean;
  shells: ShellItem[];
  /** v0.4 在此处打开终端 */
  onOpenWith: (toolId: string, path: string) => void;
  onOpenTerminal: (shellId: string, path: string) => void;
  /** v0.4 添加自定义打开方式（文件选择器 + 命名） */
  onAddCustomOpener: () => Promise<void>;
  onCopy: (paneId: number, paths: string[]) => void;
  onCut: (paneId: number, paths: string[]) => void;
  onDelete: (paneId: number, paths: string[]) => void;
  onRename: (paneId: number, entry: FileEntry) => void;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onCopyPath: (path: string) => void;
  onRefresh: (paneId: number) => void;
  /** 跨窗格拖拽：从 sourcePaneId 拖入目标窗格 */
  onDropPaths: (
    sourcePaneId: number,
    paths: string[],
    op: "copy" | "move",
    targetPaneId: number,
  ) => void;
  /** 拖拽悬停目标变化 */
  onDragOverChange: (target: { targetPaneId: number; op: "copy" | "move" } | null) => void;
  onActivate: (paneId: number) => void;
  onRatioChange: (splitId: number, ratio: number) => void;
  /** 空白右键菜单（作用于指定窗格） */
  onNewFolder: (paneId: number) => void;
  onNewFile: (paneId: number) => void;
  /** v0.7：分享此目录（右键） */
  onShareDir: (dir: string) => void;
  onPaste: (paneId: number) => void;
  onSelectAll: (paneId: number) => void;
  onInvertSelection: (paneId: number) => void;
  /** 标签与快捷访问 */
  onToggleTag: (path: string, tagId: string) => void;
  onToggleQuick: (path: string) => void;
  /** v0.8 窗口缩放（Ctrl+滚轮） */
  onZoomChange: (paneId: number, zoom: number) => void;
  /** v0.8 鼠标侧键：后退 / 前进 */
  onBack: () => void;
  onForward: () => void;
  /** v0.8 压缩为 zip / tar / tgz（仅打包） */
  onCompress: (paneId: number, paths: string[], format: "zip" | "tar" | "tgz") => void;
}

function PaneView({
  pane,
  showHidden,
  showProperties,
  renaming,
  isActive,
  dragOver,
  canPaste,
  fileTags,
  tagNames,
  onRenameTag,
  customQuick,
  onOpenTagFile,
  onExitTag,
  activeStyle,
  handlers,
}: {
  pane: PaneState;
  showHidden: boolean;
  activeStyle: "waterfall" | "lift" | "none";
  showProperties: boolean;
  renaming: RenameState | null;
  isActive: boolean;
  dragOver: { targetPaneId: number; op: "copy" | "move" } | null;
  canPaste: boolean;
  fileTags: FileTags;
  tagNames: TagNames;
  onRenameTag: (tagId: string, label: string) => void;
  customQuick: string[];
  onOpenTagFile: (path: string) => void;
  onExitTag: (paneId: number) => void;
  handlers: PaneHandlers;
}) {
  const h = handlers;
  const showingTag = pane.tagId ?? null;
  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-background", isActive && activeStyle === "waterfall" && "shadow-[inset_0_2px_0_0_hsl(var(--primary)/0.3)]", isActive && activeStyle === "lift" && "ring-1 ring-primary/50 shadow-[0_8px_24px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.1)] -translate-y-[1px]")}>
      {isActive && activeStyle === "waterfall" && <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-12 bg-gradient-to-b from-sky-400/25 via-sky-400/8 to-transparent" />}
      {pane.loading && (
        <div className="absolute inset-x-0 top-0 z-10 flex h-6 items-center justify-center gap-2 bg-background/80 text-xs text-muted-foreground backdrop-blur-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载…
        </div>
      )}
      {showingTag ? (
        <TagView
          tagId={showingTag}
          fileTags={fileTags}
          tagNames={tagNames}
          currentPath={pane.path}
          onOpen={onOpenTagFile}
          onExit={() => onExitTag(pane.id)}
          isActive={isActive}
        />
      ) : (
        <FileList
        paneId={pane.id}
        entries={pane.entries}
        sortKey={pane.sortKey}
        sortDir={pane.sortDir}
        onSort={(key) => h.onSort(pane.id, key)}
        selection={pane.selection}
        onSelect={(e, a) => h.onSelect(pane.id, e, a)}
        onSelectRange={(paths) => h.onSelectRange(pane.id, paths)}
        onClearSelection={() => h.onClearSelection(pane.id)}
        onOpen={(e) => h.onOpen(pane.id, e)}
        onMiddleOpen={(p) => h.onMiddleOpen(pane.id, p)}
        currentDir={pane.path}
        pluginOpener={h.pluginOpener}
        pluginTerminal={h.pluginTerminal}
        openers={h.openers}
        shells={h.shells}
        onOpenWith={(toolId, p) => h.onOpenWith(toolId, p)}
        onOpenTerminal={(shellId, p) => h.onOpenTerminal(shellId, p)}
        onAddCustomOpener={h.onAddCustomOpener}
        onCopy={(p) => h.onCopy(pane.id, p)}
        onCut={(p) => h.onCut(pane.id, p)}
        onDelete={(p) => h.onDelete(pane.id, p)}
        onRename={(e) => h.onRename(pane.id, e)}
        onCopyPath={h.onCopyPath}
        onRefresh={() => h.onRefresh(pane.id)}
        onDropPaths={(src, paths, op, target) => h.onDropPaths(src, paths, op, target)}
        onDragOverChange={h.onDragOverChange}
        onNewFolder={() => h.onNewFolder(pane.id)}
        onNewFile={() => h.onNewFile(pane.id)}
        onShareDir={(dir) => h.onShareDir(dir)}
        onPaste={() => h.onPaste(pane.id)}
        canPaste={canPaste}
        onSelectAll={() => h.onSelectAll(pane.id)}
        onInvertSelection={() => h.onInvertSelection(pane.id)}
        fileTags={fileTags}
        tagNames={tagNames}
        onRenameTag={onRenameTag}
        customQuick={customQuick}
        onToggleTag={h.onToggleTag}
        onToggleQuick={h.onToggleQuick}
        dragTarget={dragOver?.targetPaneId === pane.id}
        dragOp={dragOver?.targetPaneId === pane.id ? dragOver.op : "copy"}
        showHidden={showHidden}
        renaming={renaming}
        onRenameCommit={h.onRenameCommit}
        onRenameCancel={h.onRenameCancel}
        isActive={isActive}
        onActivate={() => h.onActivate(pane.id)}
        zoom={pane.zoom}
        onZoomChange={(z) => h.onZoomChange(pane.id, z)}
        onBack={h.onBack}
        onForward={h.onForward}
        onCompress={(paths, fmt) => h.onCompress(pane.id, paths, fmt)}
      />
      )}
      {showProperties && <PropertiesBar entries={pane.entries} selection={pane.selection} />}
    </div>
  );
}

function SplitDivider({
  dir,
  ratio,
  splitId,
  onRatioChange,
}: {
  dir: SplitDir;
  ratio: number;
  splitId: number;
  onRatioChange: (splitId: number, ratio: number) => void;
}) {
  const [drag, setDrag] = useState<{
    startPos: number;
    size: number;
    startRatio: number;
    dir: SplitDir;
  } | null>(null);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const pos = drag.dir === "row" ? e.clientX : e.clientY;
      const delta = pos - drag.startPos;
      onRatioChange(splitId, drag.startRatio + delta / drag.size);
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, splitId, onRatioChange]);

  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        const parent = e.currentTarget.parentElement;
        if (!parent) return;
        const size = dir === "row" ? parent.clientWidth : parent.clientHeight;
        setDrag({
          startPos: dir === "row" ? e.clientX : e.clientY,
          size: Math.max(size, 1),
          startRatio: ratio,
          dir,
        });
      }}
      className={cn(
        "z-10 shrink-0 bg-border transition-colors hover:bg-primary/40 active:bg-primary/60",
        dir === "row"
          ? "w-1 cursor-col-resize"
          : "h-1 cursor-row-resize",
      )}
      title="拖拽调整分割比例"
    />
  );
}

export function SplitView({
  node,
  panes,
  activePaneId,
  showHidden,
  showProperties,
  canPaste,
  renaming,
  dragOver,
  fileTags,
  tagNames,
  onRenameTag,
  customQuick,
  onOpenTagFile,
  onExitTag,
  activeStyle,
  handlers,
}: {
  node: PaneNode;
  panes: Record<number, PaneState>;
  activePaneId: number;
  showHidden: boolean;
  showProperties: boolean;
  canPaste: boolean;
  renaming: RenameState | null;
  dragOver: { targetPaneId: number; op: "copy" | "move" } | null;
  fileTags: FileTags;
  tagNames: TagNames;
  onRenameTag: (tagId: string, label: string) => void;
  customQuick: string[];
  onOpenTagFile: (path: string) => void;
  onExitTag: (paneId: number) => void;
  activeStyle: "waterfall" | "lift" | "none";
  handlers: PaneHandlers;
}) {
  if (node.type === "pane") {
    const pane = panes[node.paneId];
    if (!pane) return null;
    return (
      <PaneView
        pane={pane}
        showHidden={showHidden}
        showProperties={showProperties}
        renaming={renaming}
        isActive={pane.id === activePaneId}
        dragOver={dragOver}
        canPaste={canPaste}
        fileTags={fileTags}
        tagNames={tagNames}
        onRenameTag={onRenameTag}
        customQuick={customQuick}
        onOpenTagFile={onOpenTagFile}
        onExitTag={onExitTag}
        activeStyle={activeStyle}
        handlers={handlers}
      />
    );
  }
  const isRow = node.dir === "row";
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1", isRow ? "flex-row" : "flex-col")}>
      <div
        className={cn("flex min-h-0 min-w-0", isRow ? "flex-1 flex-col" : "flex-1 flex-row")}
        style={{ flexGrow: node.ratio, flexBasis: 0 }}
      >
        <SplitView
          node={node.a}
          panes={panes}
          activePaneId={activePaneId}
          showHidden={showHidden}
          showProperties={showProperties}
          canPaste={canPaste}
          renaming={renaming}
          dragOver={dragOver}
          fileTags={fileTags}
          tagNames={tagNames}
          onRenameTag={onRenameTag}
          customQuick={customQuick}
          onOpenTagFile={onOpenTagFile}
          onExitTag={onExitTag}
          activeStyle={activeStyle}
          handlers={handlers}
        />
      </div>
      <SplitDivider
        dir={node.dir}
        ratio={node.ratio}
        splitId={node.id}
        onRatioChange={handlers.onRatioChange}
      />
      <div
        className={cn("flex min-h-0 min-w-0", isRow ? "flex-1 flex-col" : "flex-1 flex-row")}
        style={{ flexGrow: 1 - node.ratio, flexBasis: 0 }}
      >
        <SplitView
          node={node.b}
          panes={panes}
          activePaneId={activePaneId}
          showHidden={showHidden}
          showProperties={showProperties}
          canPaste={canPaste}
          renaming={renaming}
          dragOver={dragOver}
          fileTags={fileTags}
          tagNames={tagNames}
          onRenameTag={onRenameTag}
          customQuick={customQuick}
          onOpenTagFile={onOpenTagFile}
          onExitTag={onExitTag}
          activeStyle={activeStyle}
          handlers={handlers}
        />
      </div>
    </div>
  );
}
