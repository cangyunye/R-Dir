import { Fragment, memo, useEffect, useState } from "react";
import {
  ChevronRight,
  Copy,
  Info,
  LayoutGrid,
  List,
  Loader2,
  SquarePlus,
  TerminalSquare,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { hasScheme } from "@/lib/cmdline";
import { splitPathSegments } from "@/lib/path-segments";
import type { IconSize, PaneNode, PaneState, SplitDir, ViewMode } from "@/lib/types";
import type { IconPositionMap } from "@/lib/api";
import type { FileTags, TagDef } from "@/lib/persist";
import { FileList, type RenameState } from "@/components/FileList";
import { IconGrid } from "@/components/IconGrid";
import { PropertiesBar } from "@/components/PropertiesBar";
import { TagView } from "@/components/TagView";
import { MenuGroup } from "@/components/MenuGroup";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { TagNames } from "@/lib/persist";
import type { FileEntry, SortKey } from "@/lib/types";
import type { DiffMarkMap, LinkSide } from "@/lib/sync-link";
import type { OpenerItem, ShellItem } from "@/lib/openerApi";

export interface PaneHandlers {
  onSort: (paneId: number, key: SortKey) => void;
  onSelect: (paneId: number, entry: FileEntry, additive: boolean) => void;
  onSelectRange: (paneId: number, paths: string[]) => void;
  onClearSelection: (paneId: number) => void;
  onOpen: (paneId: number, entry: FileEntry) => void;
  /** 用系统关联程序打开文件（搜索结果 / 标签视图双击） */
  onOpenFile: (path: string) => void;
  /** 在激活窗格中定位条目：目录进入，文件跳转所在目录并选中 */
  onRevealPath: (path: string, isDir: boolean) => void;
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
  onAddCustomOpener: (path?: string, ext?: string) => Promise<void>;
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
  /** 撤销 / 重做（右键菜单入口，全局操作栈） */
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
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
  /** v0.16 右键「属性」 */
  onProperties: (entries: FileEntry[]) => void;
  /** v0.17 空白处右键「属性（当前目录）」 */
  onPropertiesDir: (dir: string) => void;
  /** v0.18 空白处右键「与另一窗格差异比对…」 */
  onDiff: () => void;
  /** v0.18 空白处右键「同步比对（左右窗格）」：开启/断开链接 */
  onSyncDiff: () => void;
  /** v0.25 窗格头面包屑：在指定窗格内导航（并激活该窗格） */
  onNavigatePane: (paneId: number, path: string) => void;
  /** v0.25 窗格头关闭钮：关闭指定窗格 */
  onClosePane: (paneId: number) => void;
  /** v0.27 视图模式切换（每窗格独立，随会话保存） */
  onViewModeChange: (paneId: number, mode: ViewMode) => void;
  /** v0.27 大图标/画廊图标档位 */
  onIconSizeChange: (paneId: number, size: IconSize) => void;
  /** v0.27 大图标自由摆放：设置当前目录条目槽位 */
  onSetIconPosition: (dir: string, name: string, slot: [number, number]) => void;
  /** v0.27 整理图标：清空当前目录摆放记录 */
  onClearIconPositions: (dir: string) => void;
  /** v0.27 图标位置表（全部目录） */
  iconPositions: IconPositionMap;
  /** v0.27.1 自动排列目录集合（开启后忽略自由摆放） */
  autoArrangeDirs: string[];
  /** v0.27.1 切换目录的自动排列 */
  onToggleAutoArrange: (dir: string) => void;
  /** v0.27 拖到文件夹图标上：移入/复制该目录 */
  onDropIntoDir: (sourcePaneId: number, paths: string[], op: "copy" | "move", destDir: string) => void;
  /** v0.19 文本比较基准（跨窗格全局状态） */
  onSetCompareBase: (entry: FileEntry, paneId: number) => void;
  onCompareWithBase: (entry: FileEntry) => void;
  onComparePick: (entry: FileEntry) => void;
  onCompareSelected: (paths: [string, string]) => void;
  onViewPatch: (path: string) => void;
}

/** v0.25 窗格头：每窗格独立的路径面包屑（对齐升级原型 pane-head）。
 * 点击段在该窗格内导航并激活；非活动窗格整条弱化；多窗格时右侧有关闭钮。
 * 标签虚拟视图不渲染（TagView 自带带退出按钮的横幅）。
 * v0.25.1 右键菜单：空白处=窗格级操作（复制路径/终端/属性/关闭窗格），
 * 分段上=该层级操作（新标签页打开/复制此层级路径）。 */
function PaneHead({
  path,
  isActive,
  closable,
  viewMode,
  onViewModeChange,
  onNavigate,
  onClose,
  handlers: h,
  paneId,
}: {
  path: string;
  isActive: boolean;
  closable: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onNavigate: (path: string) => void;
  onClose: () => void;
  handlers: PaneHandlers;
  paneId: number;
}) {
  const segs = splitPathSegments(path);
  // 右键落在哪个分段上（null=空白处）；菜单关闭时复位
  const [segmentTarget, setSegmentTarget] = useState<string | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const seg = splitPathSegments(segmentTarget ?? path).at(-1);
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          setSegmentTarget(null);
          setTermOpen(false);
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          data-pane-head=""
          className={cn(
            "flex h-7 shrink-0 items-center gap-0.5 border-b bg-sidebar px-1.5 text-xs select-none",
            isActive ? "text-foreground" : "text-muted-foreground",
          )}
          onContextMenu={(e) => {
            // 右键落在分段上记录该层路径，其余（padding/空白/按钮）清空。
            // 挂在根节点：padding 区的右键不经过面包屑容器，挂里面会残留上次状态
            setSegmentTarget(
              (e.target as HTMLElement).closest("[data-panehead-seg]")?.getAttribute("data-panehead-seg") ?? null,
            );
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
            {segs.map((s, i) => (
              <Fragment key={`${s.target}:${i}`}>
                {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
                <button
                  type="button"
                  data-panehead-seg={s.target}
                  title={s.target}
                  onClick={() => onNavigate(s.target)}
                  className={cn(
                    "shrink-0 cursor-default rounded px-1 py-0.5 text-[11px] leading-none transition-colors hover:bg-muted",
                    i === 0
                      ? "font-medium text-primary hover:text-primary"
                      : "hover:text-foreground",
                  )}
                >
                  <span className="max-w-40 truncate">{s.label}</span>
                </button>
              </Fragment>
            ))}
          </div>
          {/* v0.27 视图切换（详情/大图标，访达式段钮）。
              画廊模式代码已就绪但 v0.27 暂不开放（缩略图覆盖面尚不足以与
              大图标拉开差距），放开时把 gallery 项加回数组即可。 */}
          <div
            className="mr-1 flex shrink-0 items-center gap-0.5 rounded-md border border-transparent p-0.5"
            role="group"
            aria-label="视图模式"
            data-view-switch=""
          >
            {(
              (
                [
                  ["details", <List key="l" className="h-3.5 w-3.5" />, "详情列表"],
                  ["icons", <LayoutGrid key="g" className="h-3.5 w-3.5" />, "大图标"],
                  // ["gallery", <GalleryVerticalEnd key="v" className="h-3.5 w-3.5" />, "画廊"],
                ] as [ViewMode, React.ReactNode, string][]
              ).filter(([mode]) => mode !== "gallery")
            ).map(([mode, icon, label]) => (
              <button
                key={mode}
                type="button"
                title={`${label}（Alt+${mode === "details" ? 1 : mode === "icons" ? 2 : 3}）`}
                aria-pressed={viewMode === mode}
                data-view-mode={mode}
                onClick={(e) => {
                  e.stopPropagation();
                  onViewModeChange(mode);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={cn(
                  "rounded p-0.5 transition-colors",
                  viewMode === mode
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {icon}
              </button>
            ))}
          </div>
          {closable && (
            <button
              type="button"
              title="关闭窗格"
              onClick={onClose}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48" collisionPadding={10}>
        {segmentTarget && seg && (
          <>
            <ContextMenuItem onClick={() => h.onMiddleOpen(paneId, segmentTarget)}>
              <SquarePlus className="mr-2 h-4 w-4" /> 在新标签页打开「{seg.label}」
            </ContextMenuItem>
            <ContextMenuItem onClick={() => h.onCopyPath(segmentTarget)}>
              <Copy className="mr-2 h-4 w-4" /> 复制此层级路径
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={() => h.onCopyPath(path)}>
          <Copy className="mr-2 h-4 w-4" /> 复制窗格路径
        </ContextMenuItem>
        {h.pluginTerminal && h.shells.length > 0 && (
          <>
            <MenuGroup
              id="terminal"
              label="在此窗格打开终端"
              icon={<TerminalSquare className="mr-2 h-4 w-4" />}
              expanded={termOpen}
              onToggle={() => setTermOpen((v) => !v)}
            >
              {h.shells.map((sh) => (
                <ContextMenuItem
                  key={sh.id}
                  disabled={!sh.detected}
                  onClick={() => h.onOpenTerminal(sh.id, path)}
                >
                  <span className="flex-1">{sh.name}</span>
                  {!sh.detected && (
                    <span className="text-[10px] text-muted-foreground">未安装</span>
                  )}
                </ContextMenuItem>
              ))}
            </MenuGroup>
            <ContextMenuSeparator />
          </>
        )}
        {!hasScheme(path) && (
          <ContextMenuItem onClick={() => h.onPropertiesDir(path)}>
            <Info className="mr-2 h-4 w-4" /> 属性（当前目录）
          </ContextMenuItem>
        )}
        {closable && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onClose}>
              <X className="mr-2 h-4 w-4" /> 关闭窗格
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// memo：App 层的 handlers 已 useMemo 稳定，传输进度等无关状态更新不再重渲染窗格
// （否则每次 App 渲染都会重建 FileList 的全部内联回调与每行右键菜单子树）。
const PaneView = memo(function PaneView({
  pane,
  showHidden,
  showExtensions,
  showProperties,
  previewSpace,
  renaming,
  isActive,
  dragOver,
  canPaste,
  fileTags,
  tags,
  tagNames,
  onRenameTag,
  customQuick,
  onOpenTagFile,
  onExitTag,
  highlight,
  diffMarks,
  linkBadge,
  compareBase,
  handlers,
}: {
  pane: PaneState;
  showHidden: boolean;
  /** v0.14 显示文件扩展名 */
  showExtensions: boolean;
  /** 多窗格时给活动窗格加立体感描边（单窗格不需要） */
  highlight: boolean;
  showProperties: boolean;
  /** v0.28 预览栏启用时空格让位给「切换预览」（列表/网格不再用空格切换选中） */
  previewSpace: boolean;
  renaming: RenameState | null;
  isActive: boolean;
  dragOver: { targetPaneId: number; op: "copy" | "move" } | null;
  canPaste: boolean;
  fileTags: FileTags;
  /** 全量标签 = 预设 + 自定义（v0.28.0） */
  tags: TagDef[];
  tagNames: TagNames;
  onRenameTag: (tagId: string, label: string) => void;
  customQuick: string[];
  onOpenTagFile: (path: string) => void;
  onExitTag: (paneId: number) => void;
  /** v0.18 同步比对标注入（窗格不在比对层时为 undefined） */
  diffMarks?: DiffMarkMap;
  linkBadge?: LinkSide;
  /** v0.19 文本比较基准（跨窗格全局状态） */
  compareBase?: { path: string; name: string } | null;
  handlers: PaneHandlers;
}) {
  const h = handlers;
  const showingTag = pane.tagId ?? null;
  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-background transition-shadow", isActive && highlight && "shadow-[0_4px_18px_rgba(15,23,42,0.10)] dark:shadow-[0_4px_18px_rgba(0,0,0,0.45)] -translate-y-[1px]")}>
      {pane.loading && (
        <div className="absolute inset-x-0 top-0 z-10 flex h-6 items-center justify-center gap-2 bg-background/80 text-xs text-muted-foreground backdrop-blur-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载…
        </div>
      )}
      {showingTag ? (
        <TagView
          tagId={showingTag}
          fileTags={fileTags}
          tags={tags}
          tagNames={tagNames}
          currentPath={pane.path}
          showExtensions={showExtensions}
          onOpen={onOpenTagFile}
          onOpenFile={h.onOpenFile}
          onReveal={h.onRevealPath}
          onToggleTag={h.onToggleTag}
          onCopyPath={h.onCopyPath}
          onToggleQuick={h.onToggleQuick}
          customQuick={customQuick}
          onExit={() => onExitTag(pane.id)}
          isActive={isActive}
        />
      ) : (
        <>
          <PaneHead
            path={pane.path}
            isActive={isActive}
            closable={highlight}
            viewMode={pane.viewMode}
            onViewModeChange={(mode) => h.onViewModeChange(pane.id, mode)}
            onNavigate={(p) => h.onNavigatePane(pane.id, p)}
            onClose={() => h.onClosePane(pane.id)}
            handlers={h}
            paneId={pane.id}
          />
          {pane.viewMode === "details" ? (
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
        onUndo={h.onUndo}
        onRedo={h.onRedo}
        canUndo={h.canUndo}
        canRedo={h.canRedo}
        onSelectAll={() => h.onSelectAll(pane.id)}
        onInvertSelection={() => h.onInvertSelection(pane.id)}
        fileTags={fileTags}
        tags={tags}
        tagNames={tagNames}
        onRenameTag={onRenameTag}
        customQuick={customQuick}
        onToggleTag={h.onToggleTag}
        onToggleQuick={h.onToggleQuick}
        dragTarget={dragOver?.targetPaneId === pane.id}
        dragOp={dragOver?.targetPaneId === pane.id ? dragOver.op : "copy"}
        showHidden={showHidden}
        showExtensions={showExtensions}
        spaceTogglesPreview={previewSpace}
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
        onProperties={h.onProperties}
        onPropertiesDir={h.onPropertiesDir}
        onDiff={h.onDiff}
        onSyncDiff={h.onSyncDiff}
        compareBase={compareBase}
        onSetCompareBase={h.onSetCompareBase}
        onCompareWithBase={h.onCompareWithBase}
        onComparePick={h.onComparePick}
        onCompareSelected={h.onCompareSelected}
        onViewPatch={h.onViewPatch}
        diffMarks={diffMarks}
          linkBadge={linkBadge}
        />
          ) : (
          <IconGrid
            paneId={pane.id}
            mode={pane.viewMode === "gallery" ? "gallery" : "icons"}
            iconSize={pane.iconSize}
            onIconSizeChange={(size) => h.onIconSizeChange(pane.id, size)}
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
            onCopy={(p) => h.onCopy(pane.id, p)}
            onCut={(p) => h.onCut(pane.id, p)}
            onDelete={(p) => h.onDelete(pane.id, p)}
            onRename={(e) => h.onRename(pane.id, e)}
            onRenameCommit={h.onRenameCommit}
            onRenameCancel={h.onRenameCancel}
            onCopyPath={h.onCopyPath}
            onRefresh={() => h.onRefresh(pane.id)}
            onShareDir={(dir) => h.onShareDir(dir)}
            onDropPaths={(src, paths, op, target) => h.onDropPaths(src, paths, op, target)}
            onDropIntoDir={(paths, op, dir) => h.onDropIntoDir(pane.id, paths, op, dir)}
            onDragOverChange={h.onDragOverChange}
            onNewFolder={() => h.onNewFolder(pane.id)}
            onNewFile={() => h.onNewFile(pane.id)}
            onPaste={() => h.onPaste(pane.id)}
            canPaste={canPaste}
            onUndo={h.onUndo}
            onRedo={h.onRedo}
            canUndo={h.canUndo}
            canRedo={h.canRedo}
            onSelectAll={() => h.onSelectAll(pane.id)}
            onInvertSelection={() => h.onInvertSelection(pane.id)}
            fileTags={fileTags}
            tags={tags}
            tagNames={tagNames}
            customQuick={customQuick}
            onToggleTag={h.onToggleTag}
            onToggleQuick={h.onToggleQuick}
            currentDir={pane.path}
            pluginOpener={h.pluginOpener}
            pluginTerminal={h.pluginTerminal}
            openers={h.openers}
            shells={h.shells}
            onOpenWith={(toolId, p) => h.onOpenWith(toolId, p)}
            onOpenTerminal={(shellId, p) => h.onOpenTerminal(shellId, p)}
            onAddCustomOpener={h.onAddCustomOpener}
            dragTarget={dragOver?.targetPaneId === pane.id}
            dragOp={dragOver?.targetPaneId === pane.id ? dragOver.op : "copy"}
            showHidden={showHidden}
            showExtensions={showExtensions}
            spaceTogglesPreview={previewSpace}
            renaming={renaming}
            isActive={isActive}
            onActivate={() => h.onActivate(pane.id)}
            zoom={pane.zoom}
            onBack={h.onBack}
            onForward={h.onForward}
            onCompress={(paths, fmt) => h.onCompress(pane.id, paths, fmt)}
            onProperties={h.onProperties}
            onPropertiesDir={h.onPropertiesDir}
            onDiff={h.onDiff}
            compareBase={compareBase}
            onSetCompareBase={h.onSetCompareBase}
            onCompareWithBase={h.onCompareWithBase}
            onComparePick={h.onComparePick}
            onCompareSelected={h.onCompareSelected}
            onViewPatch={h.onViewPatch}
            iconPositions={h.iconPositions[pane.path] ?? {}}
            onSetIconPosition={(name, slot) => h.onSetIconPosition(pane.path, name, slot)}
            onClearIconPositions={() => h.onClearIconPositions(pane.path)}
            autoArrange={h.autoArrangeDirs.includes(pane.path)}
            onToggleAutoArrange={() => h.onToggleAutoArrange(pane.path)}
            linkBadge={linkBadge}
          />
          )}
        </>
      )}
      {showProperties && <PropertiesBar entries={pane.entries} selection={pane.selection} />}
    </div>
  );
});

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
  showExtensions,
  showProperties,
  previewSpace,
  canPaste,
  renaming,
  dragOver,
  fileTags,
  tags,
  tagNames,
  onRenameTag,
  customQuick,
  onOpenTagFile,
  onExitTag,
  highlight,
  diffMarksByPane,
  linkBadgeByPane,
  compareBase,
  handlers,
}: {
  node: PaneNode;
  panes: Record<number, PaneState>;
  activePaneId: number;
  showHidden: boolean;
  showExtensions: boolean;
  showProperties: boolean;
  /** v0.28 预览栏启用时空格让位给「切换预览」 */
  previewSpace: boolean;
  canPaste: boolean;
  renaming: RenameState | null;
  dragOver: { targetPaneId: number; op: "copy" | "move" } | null;
  fileTags: FileTags;
  /** 全量标签 = 预设 + 自定义（v0.28.0） */
  tags: TagDef[];
  tagNames: TagNames;
  onRenameTag: (tagId: string, label: string) => void;
  customQuick: string[];
  onOpenTagFile: (path: string) => void;
  onExitTag: (paneId: number) => void;
  highlight: boolean;
  /** v0.18 同步比对：窗格 → 行内标注 / 表头链接方位标识 */
  diffMarksByPane?: Record<number, DiffMarkMap>;
  linkBadgeByPane?: Record<number, LinkSide>;
  /** v0.19 文本比较基准（跨窗格全局状态） */
  compareBase?: { path: string; name: string } | null;
  handlers: PaneHandlers;
}) {
  if (node.type === "pane") {
    const pane = panes[node.paneId];
    if (!pane) return null;
    return (
      <PaneView
        pane={pane}
        showHidden={showHidden}
        showExtensions={showExtensions}
        showProperties={showProperties}
        previewSpace={previewSpace}
        renaming={renaming}
        isActive={pane.id === activePaneId}
        dragOver={dragOver}
        canPaste={canPaste}
        fileTags={fileTags}
        tags={tags}
        tagNames={tagNames}
        onRenameTag={onRenameTag}
        customQuick={customQuick}
        onOpenTagFile={onOpenTagFile}
        onExitTag={onExitTag}
        highlight={highlight}
        diffMarks={diffMarksByPane?.[node.paneId]}
        linkBadge={linkBadgeByPane?.[node.paneId]}
        compareBase={compareBase}
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
          showExtensions={showExtensions}
          showProperties={showProperties}
          previewSpace={previewSpace}
          canPaste={canPaste}
          renaming={renaming}
          dragOver={dragOver}
          fileTags={fileTags}
          tags={tags}
          tagNames={tagNames}
          onRenameTag={onRenameTag}
          customQuick={customQuick}
          onOpenTagFile={onOpenTagFile}
          onExitTag={onExitTag}
          highlight={highlight}
          diffMarksByPane={diffMarksByPane}
          linkBadgeByPane={linkBadgeByPane}
          compareBase={compareBase}
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
          showExtensions={showExtensions}
          showProperties={showProperties}
          previewSpace={previewSpace}
          canPaste={canPaste}
          renaming={renaming}
          dragOver={dragOver}
          fileTags={fileTags}
          tags={tags}
          tagNames={tagNames}
          onRenameTag={onRenameTag}
          customQuick={customQuick}
          onOpenTagFile={onOpenTagFile}
          onExitTag={onExitTag}
          highlight={highlight}
          diffMarksByPane={diffMarksByPane}
          linkBadgeByPane={linkBadgeByPane}
          compareBase={compareBase}
          handlers={handlers}
        />
      </div>
    </div>
  );
}
