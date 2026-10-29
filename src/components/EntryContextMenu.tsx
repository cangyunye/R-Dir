/**
 * 条目级右键菜单内容（v0.27.0 从 FileList 行菜单抽出，FileList 与 IconGrid 共用）。
 *
 * 只含「单个条目」的菜单项；空白处菜单（新建/粘贴/全选/整理图标等）由各视图自带。
 * 展开态（MenuGroup 折叠组）由使用方持有 expandedMenu 状态传入，同一窗格内互斥展开。
 */
import {
  ArchiveRestore,
  ArrowLeftRight,
  Check,
  CheckSquare,
  Clipboard,
  Copy,
  FileArchive,
  FileDiff,
  FilePlus2,
  FolderInput,
  FolderPlus,
  GitBranch,
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
  SquareCode,
  Star,
  TerminalSquare,
  Trash2,
  Tag as TagIcon,
  Undo2,
  Redo2,
  Link2,
} from "lucide-react";
import type { FileEntry } from "@/lib/types";
import type { FileTags, TagNames } from "@/lib/persist";
import { TAG_DEFS, tagLabel, type TagDef } from "@/lib/persist";
import type { OpenerItem, ShellItem, GitToolItem, QuickToolItem } from "@/lib/openerApi";
import { isSftpPath, isHttpPath } from "@/lib/sftp-path";
import { openersForEntry } from "@/lib/openers";
import { isArchiveExt } from "@/lib/filekind";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { MenuGroup } from "@/components/MenuGroup";
import { cn } from "@/lib/utils";
import type { RenameState } from "@/components/FileList";

// ───────────────── v0.29.0 常用工具条 ─────────────────

/** 色板：按应用名哈希取底色（同名恒定同色；阶段一字母色块，真图标提取留待后续版本） */
const QT_TILE_COLORS = [
  "#2563eb", "#0d9488", "#b45309", "#7c3aed",
  "#dc2626", "#0369a1", "#4d7c0f", "#be185d",
];

export function quickTileColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return QT_TILE_COLORS[h % QT_TILE_COLORS.length];
}

/** 图标缩写：两个词取词首字母（Visual Studio Code → VS），单词取前两个字母 */
export function quickInitials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const letters = name.replace(/[^A-Za-z0-9]/g, "");
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase();
  return (name.slice(0, 2) || "?").toUpperCase();
}

/**
 * 常用工具条（右键菜单第一行，横排小图标，Word 粘贴选项式交互）。
 * 点击 = 用该工具打开当前条目（目录=作为工作区，文件=打开文件）；
 * 尾部虚线「＋」跳转设置 → 常用工具。每个图标包一层 ContextMenuItem
 * 以获得 radix 的点击自动关菜单与键盘导航。
 * FileList 内联菜单与 IconGrid 共享组件共用本条。
 */
export function QuickToolsStrip({
  path,
  tools,
  onOpen,
  onConfigure,
}: {
  path: string;
  tools: QuickToolItem[];
  onOpen: (id: string, path: string) => void;
  onConfigure: () => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b px-1.5 py-1.5">
      {tools.map((t) => (
        <ContextMenuItem
          key={t.id}
          disabled={!t.detected}
          onSelect={() => onOpen(t.id, path)}
          title={t.detected ? `用 ${t.name} 打开` : `${t.name}（未找到可执行文件）`}
          className="h-auto w-auto min-w-0 gap-0 rounded-md p-0.5 focus:bg-transparent data-[highlighted]:bg-accent"
        >
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold tracking-tight text-white",
              !t.detected && "opacity-40",
            )}
            style={{ background: quickTileColor(t.name) }}
          >
            {quickInitials(t.name)}
          </span>
        </ContextMenuItem>
      ))}
      <ContextMenuItem
        onSelect={onConfigure}
        title="配置常用工具…"
        className="h-auto w-auto min-w-0 gap-0 rounded-md p-0.5"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded border border-dashed text-muted-foreground">
          <Plus className="h-3 w-3" />
        </span>
      </ContextMenuItem>
    </div>
  );
}

/** 常用条可见性：仅本地路径（工具只能开本地），受「打开方式」插件开关控制 */
export function quickStripVisible(pluginOpener: boolean, path: string): boolean {
  return pluginOpener && !isSftpPath(path) && !isHttpPath(path);
}

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
  /** v0.29.0 右键「用 VSCode 打开」（文件/目录均可；未探测到置灰） */
  vscodeDetected: boolean;
  onOpenVscode: (path: string) => void;
  /** v0.29.0 右键「Git 打开」折叠组（仅目录） */
  gitTools: GitToolItem[];
  onOpenGitTool: (toolId: string, path: string) => void;
  /** v0.29.0 常用工具条（菜单第一行横排图标；目录=工作区、文件=打开文件） */
  quickTools: QuickToolItem[];
  onOpenQuickTool: (id: string, path: string) => void;
  /** 常用条尾部的「＋」：打开设置 → 常用工具 */
  onConfigureQuickTools: () => void;
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
  /** v0.32 解压压缩包：here=智能落点 / folder=归档名文件夹 / choose=自选目录 */
  onExtract: (paths: string[], mode: "here" | "folder" | "choose") => void;
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
  vscodeDetected,
  onOpenVscode,
  gitTools,
  onOpenGitTool,
  quickTools,
  onOpenQuickTool,
  onConfigureQuickTools,
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
  onExtract,
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
  // VSCode 已进常用条 → 固定行去重隐藏（稳定 slug id "vscode"）
  const vscodeInQuick = quickTools.some((t) => t.id === "vscode");
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
      {quickStripVisible(pluginOpener, entry.path) && (
        <QuickToolsStrip
          path={entry.path}
          tools={quickTools}
          onOpen={onOpenQuickTool}
          onConfigure={onConfigureQuickTools}
        />
      )}
      {headerExtras}
      <ContextMenuItem onClick={() => onOpen(entry)}>
        <FolderInput className="mr-2 h-4 w-4" /> 打开
      </ContextMenuItem>
      {pluginOpener && !vscodeInQuick && (
        // v0.29.0 内置直启：文件=VSCode 打开该文件，目录=作为工作区打开；未安装置灰
        <ContextMenuItem
          disabled={!vscodeDetected}
          onClick={() => onOpenVscode(entry.path)}
        >
          <SquareCode className="mr-2 h-4 w-4" /> 用 Visual Studio Code 打开
          {!vscodeDetected && (
            <span className="ml-1 text-[10px] text-muted-foreground">未安装</span>
          )}
        </ContextMenuItem>
      )}
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
      {entry.is_dir && pluginTerminal && (
        // v0.29.0「Git 打开」：Git Bash / Git GUI / 常见 GUI 客户端（探测到才可点）
        <MenuGroup
          id="git"
          label="Git 打开"
          icon={<GitBranch className="mr-2 h-4 w-4" />}
          expanded={expandedMenu === "git"}
          onToggle={onToggleGroup}
        >
          {gitTools.length === 0 ? (
            <ContextMenuItem disabled>未检测到 Git 工具</ContextMenuItem>
          ) : (
            gitTools.map((t) => (
              <ContextMenuItem
                key={t.id}
                disabled={!t.detected}
                onClick={() => onOpenGitTool(t.id, entry.path)}
              >
                <span className="flex-1">{t.name}</span>
                {!t.detected && (
                  <span className="text-[10px] text-muted-foreground">未安装</span>
                )}
              </ContextMenuItem>
            ))
          )}
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
      {!entry.is_dir && isArchiveExt(entry.extension) && (
        // v0.32 解压折叠组（仅压缩包文件）：智能落点 / 归档名文件夹 / 自选目录
        <MenuGroup
          id="extract"
          label="解压"
          icon={<ArchiveRestore className="mr-2 h-4 w-4" />}
          expanded={expandedMenu === "extract"}
          onToggle={onToggleGroup}
        >
          <ContextMenuItem onClick={() => onExtract(targets, "here")}>解压到此处</ContextMenuItem>
          <ContextMenuItem onClick={() => onExtract(targets, "folder")}>
            解压到 {entry.name.replace(/\.[^.]+$/, "")}/
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onExtract(targets, "choose")}>解压到…</ContextMenuItem>
        </MenuGroup>
      )}
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

// ───────────────── v0.34.1 空白处右键菜单（从 FileList / IconGrid 空白菜单收敛） ─────────────────

/**
 * 空白处右键菜单共享内容：两个视图约 70% 相同的部分（常用工具条、终端组、新建、
 * 粘贴、撤销/重做、全选/反向选择、差异/同步比对、刷新、属性）。
 * 视图差异以插槽注入，保持渲染结果与抽取前逐字节一致：
 * - FileList：终端组图标 TerminalSquare、组后带分隔线、「分享此目录」（selectionExtras）
 * - IconGrid：终端组空图标且 shells 为空时隐藏、排序/图标大小/自动排列/整理图标（gridExtras）
 */
export function BlankContextMenuContent({
  currentDir,
  pluginOpener,
  pluginTerminal,
  showTerminal,
  terminalIcon,
  terminalSeparator,
  quickTools,
  onOpenQuickTool,
  onConfigureQuickTools,
  shells,
  gitBash,
  onOpenTerminal,
  onOpenGitTool,
  expandedMenu,
  onToggleGroup,
  onNewFolder,
  onNewFile,
  canPaste,
  onPaste,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSelectAll,
  onInvertSelection,
  onDiff,
  onSyncDiff,
  onRefresh,
  onPropertiesDir,
  gridExtras,
  selectionExtras,
}: {
  currentDir: string;
  pluginOpener: boolean;
  pluginTerminal: boolean;
  /** 终端组可见性：FileList = pluginTerminal；IconGrid = pluginTerminal && shells.length > 0 */
  showTerminal: boolean;
  /** 折叠组头图标（两视图不同：TerminalSquare / 占位 span） */
  terminalIcon: React.ReactNode;
  /** FileList 终端组后有分隔线，IconGrid 没有 */
  terminalSeparator: boolean;
  quickTools: QuickToolItem[];
  onOpenQuickTool: (id: string, path: string) => void;
  onConfigureQuickTools: () => void;
  shells: ShellItem[];
  /** Git Bash 特判：既是终端也是 Git 工具，收进终端组（两视图同） */
  gitBash?: GitToolItem;
  onOpenTerminal: (shellId: string, path: string) => void;
  onOpenGitTool: (toolId: string, path: string) => void;
  expandedMenu: string | null;
  onToggleGroup: (id: string) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  canPaste: boolean;
  onPaste: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSelectAll: () => void;
  onInvertSelection: () => void;
  onDiff: () => void;
  onSyncDiff: () => void;
  onRefresh: () => void;
  onPropertiesDir: (dir: string) => void;
  /** 「重做」分隔线之后、「全选」之前：IconGrid 的排序/图标大小/自动排列/整理图标 */
  gridExtras?: React.ReactNode;
  /** 「反向选择」分隔线之后、「差异比对」之前：FileList 的「分享此目录」 */
  selectionExtras?: React.ReactNode;
}) {
  return (
    <>
      {/* 常用工具条（与条目右键菜单第一行同款）：空白处 = 当前目录，一步用常用工具打开 */}
      {quickStripVisible(pluginOpener, currentDir) && (
        <QuickToolsStrip
          path={currentDir}
          tools={quickTools}
          onOpen={onOpenQuickTool}
          onConfigure={onConfigureQuickTools}
        />
      )}
      {pluginTerminal && showTerminal && (
        <>
          <MenuGroup
            id="terminalEmpty"
            label="在此处打开终端"
            icon={terminalIcon}
            expanded={expandedMenu === "terminalEmpty"}
            onToggle={onToggleGroup}
          >
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
            {/* Git Bash 本质是终端：空白处即当前目录内，同样可开（与目录右键「Git 打开」同源探测） */}
            {gitBash && (
              <ContextMenuItem
                disabled={!gitBash.detected}
                onClick={() => onOpenGitTool(gitBash.id, currentDir)}
              >
                <GitBranch className="mr-2 h-4 w-4" />
                <span className="flex-1">{gitBash.name}</span>
                {!gitBash.detected && (
                  <span className="text-[10px] text-muted-foreground">未安装</span>
                )}
              </ContextMenuItem>
            )}
          </MenuGroup>
          {terminalSeparator && <ContextMenuSeparator />}
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
      {/* 撤销 / 重做作用于全局操作栈（粘贴/移动/重命名/新建/删除） */}
      <ContextMenuItem onClick={onUndo} disabled={!canUndo}>
        <Undo2 className="mr-2 h-4 w-4" /> 撤销
      </ContextMenuItem>
      <ContextMenuItem onClick={onRedo} disabled={!canRedo}>
        <Redo2 className="mr-2 h-4 w-4" /> 重做
      </ContextMenuItem>
      <ContextMenuSeparator />
      {gridExtras}
      <ContextMenuItem onClick={onSelectAll}>
        <CheckSquare className="mr-2 h-4 w-4" /> 全选
      </ContextMenuItem>
      <ContextMenuItem onClick={onInvertSelection}>
        <CheckSquare className="mr-2 h-4 w-4" /> 反向选择
      </ContextMenuItem>
      <ContextMenuSeparator />
      {selectionExtras}
      {/* v0.18 与另一窗格差异比对（需活动标签正好两个本地窗格） */}
      <ContextMenuItem onClick={onDiff}>
        <ArrowLeftRight className="mr-2 h-4 w-4" /> 与另一窗格差异比对…
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* v0.18 同步比对（左右窗格）：开启/断开底部实时比对面板 */}
      <ContextMenuItem onClick={onSyncDiff}>
        <Link2 className="mr-2 h-4 w-4" /> 同步比对（左右窗格）
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRefresh}>
        <RefreshCw className="mr-2 h-4 w-4" /> 刷新
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* 空白处右键：统计「当前目录」属性（与地址栏显示的选中路径无关） */}
      <ContextMenuItem onClick={() => onPropertiesDir(currentDir)}>
        <Info className="mr-2 h-4 w-4" /> 属性（当前目录）
      </ContextMenuItem>
    </>
  );
}
