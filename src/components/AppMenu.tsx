import { useState } from "react";
import {
  ArrowLeftRight,
  Check,
  Clipboard,
  Command,
  Copy,
  CopyPlus,
  Download,
  FileDiff,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  GitCompare,
  Globe,
  Info,
  LayoutPanelLeft,
  LayoutPanelTop,
  Link2,
  Link2Off,
  Moon,
  MoreVertical,
  PanelRightClose,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scissors,
  Search,
  Settings,
  Sun,
  Trash2,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ACTIONS, bindingOf, formatBinding } from "@/lib/keymap";
import pkg from "../../package.json";

export interface AppMenuActions {
  // 文件
  onNewTab: () => void;
  onCloseTab: () => void;
  onQuit: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  // 编辑
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onDuplicate: () => void;
  canDuplicate: boolean;
  onRename: () => void;
  canRename: boolean;
  onDelete: () => void;
  canDelete: boolean;
  onCopyPath: () => void;
  onToggleProperties: () => void;
  // 查看
  onToggleHidden: () => void;
  showHidden: boolean;
  onToggleExtensions: () => void;
  showExtensions: boolean;
  onToggleSearch: () => void;
  onRefresh: () => void;
  // 转到
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onHome: () => void;
  // 窗格
  onSplitRow: () => void;
  onSplitCol: () => void;
  onClosePane: () => void;
  canClosePane: boolean;
  onFocusNextPane: () => void;
  // 工具
  onOpenDiff: () => void;
  /** v0.18 同步比对（底部实时面板）：开启/断开链接 */
  onOpenSyncDiff: () => void;
  syncDiffActive: boolean;
  /** v0.19 Git Diff 粘贴导入 */
  onOpenGitDiff: () => void;
  // 帮助 / 右上角常驻
  onOpenSettings: () => void;
  onCheckUpdate: () => void;
  onOpenRepo: () => void;
  appName: string;
  appVersion: string;
  dark: boolean;
  onToggleTheme: () => void;
  /** 打开命令面板 */
  onOpenPalette: () => void;
  /** 键位版本号：自定义键位变化时递增，仅用于触发快捷键提示重渲染 */
  keymapVersion?: number;
}

/** 菜单项右侧的快捷键提示（按当前平台显示已配置键位） */
function Shortcut({ id }: { id: string }) {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) return null;
  return (
    <span className="ml-auto pl-6 font-mono text-[10px] tabular-nums text-muted-foreground">
      {formatBinding(bindingOf(a))}
    </span>
  );
}

/** 图标槽：统一 16px 占位保证文字对齐；checked 场景由 Check 占位 */
function IconSlot({
  icon,
  checked,
}: {
  icon: React.ReactNode;
  checked?: boolean;
}) {
  if (checked !== undefined) {
    return <Check className={cn("mr-2 h-4 w-4", !checked && "opacity-0")} />;
  }
  return (
    <span className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">
      {icon}
    </span>
  );
}

function Item({
  icon,
  label,
  shortcutId,
  disabled,
  danger,
  checked,
  onClick,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  shortcutId?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onClick={onClick}
      className={danger ? "text-destructive focus:text-destructive" : undefined}
    >
      <IconSlot icon={icon} checked={checked} />
      {label}
      {shortcutId ? <Shortcut id={shortcutId} /> : null}
    </DropdownMenuItem>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground">
      {children}
    </DropdownMenuLabel>
  );
}

/**
 * 右上角常驻区：设置 / 主题切换 / ⋮ 应用菜单。
 * v0.20 撤掉常驻菜单条后的完整功能入口：命令面板覆盖高频动作（Ctrl+K），
 * ⋮ 菜单平铺保留全部功能用于发现（原 MenuBar 七个下拉摊平为分组列表）。
 */
export function AppMenu(actions: AppMenuActions) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-0.5" data-keymap-version={actions.keymapVersion ?? 0}>
      <button
        onClick={actions.onOpenSettings}
        title="设置（快捷键录制）"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Settings className="h-4 w-4" />
      </button>
      <button
        onClick={actions.onToggleTheme}
        title={actions.dark ? "切换到浅色主题" : "切换到深色主题"}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {actions.dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            title="应用菜单"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[300px]"
          // 根 zoom 时 70vh 会被放大，按 --rdir-zoom 折算封顶（同右键菜单的处理）
          style={{ maxHeight: "calc(70vh / var(--rdir-zoom, 1))" }}
        >
          <Item
            icon={<Command />}
            label="命令面板"
            shortcutId="commandPalette"
            onClick={actions.onOpenPalette}
          />
          <DropdownMenuSeparator />

          <GroupLabel>文件</GroupLabel>
          <Item icon={<Plus />} label="新建标签页" shortcutId="newTab" onClick={actions.onNewTab} />
          <Item icon={<X />} label="关闭标签页" shortcutId="closeTab" onClick={actions.onCloseTab} />
          <Item icon={<FolderPlus />} label="新建文件夹" shortcutId="newFolder" onClick={actions.onNewFolder} />
          <Item icon={<FilePlus2 />} label="新建文件" shortcutId="newFile" onClick={actions.onNewFile} />
          <DropdownMenuSeparator />
          <Item icon={<X />} label="退出" onClick={actions.onQuit} />

          <GroupLabel>编辑</GroupLabel>
          <Item icon={<Undo2 />} label="撤销" shortcutId="undo" disabled={!actions.canUndo} onClick={actions.onUndo} />
          <Item icon={<Redo2 />} label="重做" shortcutId="redo" disabled={!actions.canRedo} onClick={actions.onRedo} />
          <DropdownMenuSeparator />
          <Item icon={<Copy />} label="复制" shortcutId="copy" onClick={actions.onCopy} />
          <Item icon={<Scissors />} label="剪切" shortcutId="cut" onClick={actions.onCut} />
          <Item icon={<Clipboard />} label="粘贴" shortcutId="paste" disabled={!actions.canPaste} onClick={actions.onPaste} />
          <Item
            icon={<CopyPlus />}
            label="复制到当前目录"
            shortcutId="duplicate"
            disabled={!actions.canDuplicate}
            onClick={actions.onDuplicate}
          />
          <DropdownMenuSeparator />
          <Item icon={<Pencil />} label="重命名" shortcutId="rename" disabled={!actions.canRename} onClick={actions.onRename} />
          <Item
            icon={<Trash2 />}
            label="删除（回收站）"
            shortcutId="delete"
            disabled={!actions.canDelete}
            danger
            onClick={actions.onDelete}
          />
          <Item icon={<Clipboard />} label="复制路径" shortcutId="copyPath" onClick={actions.onCopyPath} />
          <Item icon={<Info />} label="属性栏" shortcutId="properties" onClick={actions.onToggleProperties} />

          <GroupLabel>查看</GroupLabel>
          <Item icon={null} label="显示隐藏文件" shortcutId="toggleHidden" checked={actions.showHidden} onClick={actions.onToggleHidden} />
          <Item icon={null} label="显示文件扩展名" checked={actions.showExtensions} onClick={actions.onToggleExtensions} />
          <Item icon={<Search />} label="切换搜索面板" shortcutId="focusSearch" onClick={actions.onToggleSearch} />
          <DropdownMenuSeparator />
          <Item icon={<RefreshCw />} label="刷新" shortcutId="refresh" onClick={actions.onRefresh} />

          <GroupLabel>转到</GroupLabel>
          <Item icon={<RotateCcw />} label="后退" shortcutId="goBack" onClick={actions.onBack} />
          <Item icon={<RotateCw />} label="前进" shortcutId="goForward" onClick={actions.onForward} />
          <Item icon={<FolderOpen />} label="上级目录" shortcutId="goUp" onClick={actions.onUp} />
          <Item icon={<FolderOpen />} label="主目录" shortcutId="goHome" onClick={actions.onHome} />

          <GroupLabel>窗格</GroupLabel>
          <Item icon={<LayoutPanelLeft />} label="左右分屏" shortcutId="splitRow" onClick={actions.onSplitRow} />
          <Item icon={<LayoutPanelTop />} label="上下分屏" shortcutId="splitCol" onClick={actions.onSplitCol} />
          <Item
            icon={<PanelRightClose />}
            label="关闭当前窗格"
            shortcutId="closePane"
            disabled={!actions.canClosePane}
            onClick={actions.onClosePane}
          />
          <Item icon={<ArrowLeftRight />} label="聚焦下一窗格" shortcutId="focusNextPane" onClick={actions.onFocusNextPane} />

          <GroupLabel>工具</GroupLabel>
          <Item icon={<GitCompare />} label="差异比对（左右窗格）…" onClick={actions.onOpenDiff} />
          <Item
            icon={actions.syncDiffActive ? <Link2Off /> : <Link2 />}
            label={actions.syncDiffActive ? "断开同步比对" : "同步比对（左右窗格）"}
            onClick={actions.onOpenSyncDiff}
          />
          <Item icon={<FileDiff />} label="打开 Git Diff…" onClick={actions.onOpenGitDiff} />

          <GroupLabel>帮助</GroupLabel>
          <DropdownMenuLabel className="px-2 font-normal text-muted-foreground">
            {actions.appName}
          </DropdownMenuLabel>
          <Item icon={<Settings />} label="设置（快捷键录制与主题）" shortcutId="openSettings" onClick={actions.onOpenSettings} />
          <Item icon={<Download />} label="检查更新…" onClick={actions.onCheckUpdate} />
          <Item icon={<Globe />} label="GitHub 仓库" onClick={actions.onOpenRepo} />
          <Item icon={<Info />} label={<>版本 {actions.appVersion || pkg.version}（Tauri 2 + React）</>} disabled onClick={() => {}} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
