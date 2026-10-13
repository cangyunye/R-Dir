/**
 * 条目级右键菜单内容（v0.27.0 从 FileList 行菜单抽出，FileList 与 IconGrid 共用）。
 *
 * 只含「单个条目」的菜单项；空白处菜单（新建/粘贴/全选/整理图标等）由各视图自带。
 * 展开态（MenuGroup 折叠组）由使用方持有 expandedMenu 状态传入，同一窗格内互斥展开。
 */
import {
  Check,
  Clipboard,
  Copy,
  FileArchive,
  FileDiff,
  FolderInput,
  GitCompare,
  Crosshair,
  ExternalLink,
  Info,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Scissors,
  Share2,
  Star,
  TerminalSquare,
  Trash2,
  Tag as TagIcon,
  Undo2,
  Redo2,
} from "lucide-react";
import type { FileEntry } from "@/lib/types";
import type { FileTags, TagNames } from "@/lib/persist";
import { TAG_DEFS, tagLabel, type TagDef } from "@/lib/persist";
import type { OpenerItem, ShellItem } from "@/lib/openerApi";
import { openersForEntry } from "@/lib/openers";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { MenuGroup } from "@/components/MenuGroup";
import type { RenameState } from "@/components/FileList";

export interface EntryMenuProps {
  entry: FileEntry;
  /** 携带的操作目标（已选中 = 全部选中项，否则 = 单条目） */
  targets: string[];
  entries: FileEntry[];
  paneId: number;
  /** v0.27 菜单动作扩展点：视图可追加自定义项（如大图标的「整理图标」） */
  headerExtras?: React.ReactNode;
  footerExtras?: React.ReactNode;
  // 数据
  pluginOpener: boolean;
  pluginTerminal: boolean;
  openers: OpenerItem[];
  shells: ShellItem[];
  fileTags: FileTags;
  /** 全量标签 = 预设 + 自定义（v0.28.0；缺省回落预设） */
  tags?: TagDef[];
  tagNames: TagNames;
  customQuick: string[];
  compareBase?: { path: string; name: string } | null;
  renaming: RenameState | null;
  canUndo: boolean;
  canRedo: boolean;
  // 动作
  expandedMenu: string | null;
  onToggleGroup: (id: string) => void;
  onOpen: (entry: FileEntry) => void;
  onOpenWith: (toolId: string, path: string) => void;
  onAddCustomOpener: (path?: string, ext?: string) => Promise<void>;
  onOpenTerminal: (shellId: string, path: string) => void;
  onShareDir: (dir: string) => void;
  onCompress: (paths: string[], format: "zip" | "tar" | "tgz") => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (paths: string[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopyPath: (path: string) => void;
  onSetCompareBase?: (entry: FileEntry, paneId: number) => void;
  onCompareWithBase?: (entry: FileEntry) => void;
  onComparePick?: (entry: FileEntry) => void;
  onCompareSelected?: (paths: [string, string]) => void;
  onViewPatch?: (path: string) => void;
  onToggleTag: (path: string, tagId: string) => void;
  onToggleQuick: (path: string) => void;
  onRefresh: () => void;
  onProperties: (entries: FileEntry[]) => void;
}

export function EntryContextMenuContent({
  entry,
  targets,
  entries,
  paneId,
  headerExtras,
  footerExtras,
  pluginOpener,
  pluginTerminal,
  openers,
  shells,
  fileTags,
  tags: tagsProp,
  tagNames,
  customQuick,
  compareBase,
  renaming,
  canUndo,
  canRedo,
  expandedMenu,
  onToggleGroup,
  onOpen,
  onOpenWith,
  onAddCustomOpener,
  onOpenTerminal,
  onShareDir,
  onCompress,
  onCopy,
  onCut,
  onRename,
  onDelete,
  onUndo,
  onRedo,
  onCopyPath,
  onSetCompareBase,
  onCompareWithBase,
  onComparePick,
  onCompareSelected,
  onViewPatch,
  onToggleTag,
  onToggleQuick,
  onRefresh,
  onProperties,
}: EntryMenuProps) {
  return (
    <ContextMenuContent
      className="min-w-48"
      collisionPadding={10}
      onCloseAutoFocus={(e) => {
        // 右键「重命名」时焦点要留给行内 RenameInput；
        // 阻止 radix 关闭菜单后把焦点恢复到触发元素（会抢走输入框焦点）
        if (renaming?.path === entry.path) e.preventDefault();
      }}
    >
      {headerExtras}
      <ContextMenuItem onClick={() => onOpen(entry)}>
        <FolderInput className="mr-2 h-4 w-4" /> 打开
      </ContextMenuItem>
      {!entry.is_dir && pluginOpener && (
        <MenuGroup
          id="openWith"
          label="打开方式"
          icon={<ExternalLink className="mr-2 h-4 w-4" />}
          expanded={expandedMenu === "openWith"}
          onToggle={onToggleGroup}
        >
          {(() => {
            const customs = openersForEntry(openers, entry.extension);
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
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void onAddCustomOpener(entry.path, entry.extension)}>
            <Plus className="mr-2 h-4 w-4" /> 选择其他应用…
          </ContextMenuItem>
        </MenuGroup>
      )}
      {entry.is_dir && pluginTerminal && (
        <MenuGroup
          id="terminal"
          label="在此处打开终端"
          icon={<TerminalSquare className="mr-2 h-4 w-4" />}
          expanded={expandedMenu === "terminal"}
          onToggle={onToggleGroup}
        >
          {shells.map((sh) => (
            <ContextMenuItem
              key={sh.id}
              disabled={!sh.detected}
              onClick={() => onOpenTerminal(sh.id, entry.path)}
            >
              <span className="flex-1">{sh.name}</span>
              {!sh.detected && <span className="text-[10px] text-muted-foreground">未安装</span>}
            </ContextMenuItem>
          ))}
        </MenuGroup>
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
      <MenuGroup
        id="compress"
        label="压缩为"
        icon={<FileArchive className="mr-2 h-4 w-4" />}
        expanded={expandedMenu === "compress"}
        onToggle={onToggleGroup}
      >
        <ContextMenuItem onClick={() => onCompress(targets, "zip")}>
          <FileArchive className="mr-2 h-4 w-4" /> zip
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCompress(targets, "tar")}>
          <FileArchive className="mr-2 h-4 w-4" /> tar（仅打包）
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCompress(targets, "tgz")}>
          <FileArchive className="mr-2 h-4 w-4" /> tgz（tar + gzip）
        </ContextMenuItem>
      </MenuGroup>
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
      <ContextMenuItem onClick={onUndo} disabled={!canUndo}>
        <Undo2 className="mr-2 h-4 w-4" /> 撤销
      </ContextMenuItem>
      <ContextMenuItem onClick={onRedo} disabled={!canRedo}>
        <Redo2 className="mr-2 h-4 w-4" /> 重做
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCopyPath(entry.path)}>
        <Clipboard className="mr-2 h-4 w-4" /> 复制路径
      </ContextMenuItem>
      {!entry.is_dir && (onSetCompareBase || onCompareWithBase || onComparePick) && (
        <MenuGroup
          id="compare"
          label="比较"
          icon={<GitCompare className="mr-2 h-4 w-4" />}
          expanded={expandedMenu === "compare"}
          onToggle={onToggleGroup}
        >
          {targets.length === 2 &&
            targets.every((p) => {
              const t = entries.find((x) => x.path === p);
              return !!t && !t.is_dir;
            }) && (
              <ContextMenuItem onClick={() => onCompareSelected?.(targets as [string, string])}>
                <GitCompare className="mr-2 h-4 w-4" /> 比较所选两个文件
              </ContextMenuItem>
            )}
          <ContextMenuItem onClick={() => onSetCompareBase?.(entry, paneId)}>
            <Crosshair className="mr-2 h-4 w-4" />
            {compareBase?.path === entry.path ? "取消比较基准" : "设为比较基准"}
          </ContextMenuItem>
          <ContextMenuItem disabled={!compareBase} onClick={() => onCompareWithBase?.(entry)}>
            <GitCompare className="mr-2 h-4 w-4" /> 与基准比较
            {!compareBase && (
              <span className="ml-1 text-[10px] text-muted-foreground">（先设基准）</span>
            )}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onComparePick?.(entry)}>
            <ListTree className="mr-2 h-4 w-4" /> 与另一文件比较…
          </ContextMenuItem>
          {(entry.extension === "patch" || entry.extension === "diff") && (
            <ContextMenuItem onClick={() => onViewPatch?.(entry.path)}>
              <FileDiff className="mr-2 h-4 w-4" /> 查看 Diff
            </ContextMenuItem>
          )}
        </MenuGroup>
      )}
      <ContextMenuSeparator />
      <MenuGroup
        id="tags"
        label="标签"
        icon={<TagIcon className="mr-2 h-4 w-4" />}
        expanded={expandedMenu === "tags"}
        onToggle={onToggleGroup}
      >
        {(tagsProp ?? TAG_DEFS).map((t) => {
          const checked = (fileTags[entry.path] ?? []).includes(t.id);
          return (
            <ContextMenuItem key={t.id} onSelect={() => onToggleTag(entry.path, t.id)}>
              <span className="mr-2 h-3 w-3 rounded-full" style={{ background: t.color }} />
              {tagLabel(t, tagNames)}
              {checked && <Check className="ml-auto h-3.5 w-3.5" />}
            </ContextMenuItem>
          );
        })}
      </MenuGroup>
      <ContextMenuItem onClick={() => onToggleQuick(entry.path)}>
        <Star className="mr-2 h-4 w-4" />
        {customQuick.includes(entry.path) ? "从快捷访问移除" : "添加到快捷访问"}
      </ContextMenuItem>
      {footerExtras}
      <ContextMenuItem onClick={onRefresh}>
        <RefreshCw className="mr-2 h-4 w-4" /> 刷新
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() =>
          onProperties(
            targets
              .map((p) => entries.find((x) => x.path === p))
              .filter((e): e is FileEntry => !!e),
          )
        }
      >
        <Info className="mr-2 h-4 w-4" /> 属性
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
