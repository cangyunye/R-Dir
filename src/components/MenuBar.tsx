import { useState } from "react";
import {
  Check,
  Clipboard,
  Copy,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Home,
  Info,
  LayoutPanelLeft,
  LayoutPanelTop,
  Moon,
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
  CopyPlus,
  X,
  ArrowLeftRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ACTIONS, bindingOf, formatBinding } from "@/lib/keymap";

export interface MenuActions {
  // 标签
  onNewTab: () => void;
  onCloseTab: () => void;
  onQuit: () => void;
  // 导航
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onHome: () => void;
  onRefresh: () => void;
  // 查看
  onToggleHidden: () => void;
  onToggleSearch: () => void;
  showHidden: boolean;
  searchOpen: boolean;
  /** v0.14 显示文件扩展名开关 */
  onToggleExtensions: () => void;
  showExtensions: boolean;
  // 文件操作
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onRename: () => void;
  canRename: boolean;
  onDelete: () => void;
  canDelete: boolean;
  onNewFolder: () => void;
  onNewFile: () => void;
  onCopyPath: () => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onDuplicate: () => void;
  canDuplicate: boolean;
  onToggleProperties: () => void;
  // 分屏
  onSplitRow: () => void;
  onSplitCol: () => void;
  onClosePane: () => void;
  canClosePane: boolean;
  onFocusNextPane: () => void;
  // 视图 / 全局
  dark: boolean;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  /** 键位版本号：自定义键位变化时递增，仅用于触发菜单快捷键提示重渲染 */
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

function MenuButton({
  label,
  open,
  onOpenChange,
  onHover,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onHover: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild onMouseEnter={onHover}>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs font-normal"
        >
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MenuBar(actions: MenuActions) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const openFor = (label: string) => ({
    open: openMenu === label,
    onOpenChange: (o: boolean) => setOpenMenu(o ? label : null),
    // 经典菜单栏行为：必须先点击打开一个菜单，之后悬停才能切换；未打开时悬停不触发
    onHover: () => {
      if (openMenu !== null) setOpenMenu(label);
    },
  });

  return (
    <div
      className="flex h-7 items-center gap-0.5 border-b bg-muted/40 px-1.5 select-none"
      data-keymap-version={actions.keymapVersion ?? 0}
    >
      <MenuButton label="文件" {...openFor("文件")}>
        <DropdownMenuItem onClick={actions.onNewTab}>
          <Plus className="mr-2 h-4 w-4" /> 新建标签页
          <Shortcut id="newTab" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onCloseTab}>
          <X className="mr-2 h-4 w-4" /> 关闭标签页
          <Shortcut id="closeTab" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={actions.onNewFolder}>
          <FolderPlus className="mr-2 h-4 w-4" /> 新建文件夹
          <Shortcut id="newFolder" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onNewFile}>
          <FilePlus2 className="mr-2 h-4 w-4" /> 新建文件
          <Shortcut id="newFile" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={actions.onQuit}>
          <X className="mr-2 h-4 w-4" /> 退出
        </DropdownMenuItem>
      </MenuButton>

      <MenuButton label="编辑" {...openFor("编辑")}>
        <DropdownMenuItem onClick={actions.onUndo} disabled={!actions.canUndo}>
          <Undo2 className="mr-2 h-4 w-4" /> 撤销
          <Shortcut id="undo" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onRedo} disabled={!actions.canRedo}>
          <Redo2 className="mr-2 h-4 w-4" /> 重做
          <Shortcut id="redo" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={actions.onCopy}>
          <Copy className="mr-2 h-4 w-4" /> 复制
          <Shortcut id="copy" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onCut}>
          <Scissors className="mr-2 h-4 w-4" /> 剪切
          <Shortcut id="cut" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onPaste} disabled={!actions.canPaste}>
          <Clipboard className="mr-2 h-4 w-4" /> 粘贴
          <Shortcut id="paste" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onDuplicate} disabled={!actions.canDuplicate}>
          <CopyPlus className="mr-2 h-4 w-4" /> 复制到当前目录
          <Shortcut id="duplicate" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={actions.onRename} disabled={!actions.canRename}>
          <Pencil className="mr-2 h-4 w-4" /> 重命名
          <Shortcut id="rename" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={actions.onDelete}
          disabled={!actions.canDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" /> 删除（回收站）
          <Shortcut id="delete" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onCopyPath}>
          <Clipboard className="mr-2 h-4 w-4" /> 复制路径
          <Shortcut id="copyPath" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onToggleProperties}>
          <Info className="mr-2 h-4 w-4" /> 属性栏
          <Shortcut id="properties" />
        </DropdownMenuItem>
      </MenuButton>

      <MenuButton label="查看" {...openFor("查看")}>
        <DropdownMenuItem onClick={actions.onToggleHidden}>
          <Check
            className={actions.showHidden ? "mr-2 h-4 w-4" : "mr-2 h-4 w-4 opacity-0"}
          />
          显示隐藏文件
          <Shortcut id="toggleHidden" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onToggleExtensions}>
          <Check
            className={actions.showExtensions ? "mr-2 h-4 w-4" : "mr-2 h-4 w-4 opacity-0"}
          />
          显示文件扩展名
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onToggleSearch}>
          <Search className="mr-2 h-4 w-4" /> 切换搜索面板
          <Shortcut id="focusSearch" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onToggleTheme}>
          <Moon className="mr-2 h-4 w-4" /> 切换主题（当前：{actions.dark ? "深色" : "浅色"}）
          <Shortcut id="toggleTheme" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={actions.onRefresh}>
          <RefreshCw className="mr-2 h-4 w-4" /> 刷新
          <Shortcut id="refresh" />
        </DropdownMenuItem>
      </MenuButton>

      <MenuButton label="转到" {...openFor("转到")}>
        <DropdownMenuItem onClick={actions.onBack}>
          <RotateCcw className="mr-2 h-4 w-4" /> 后退
          <Shortcut id="goBack" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onForward}>
          <RotateCw className="mr-2 h-4 w-4" /> 前进
          <Shortcut id="goForward" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onUp}>
          <FolderOpen className="mr-2 h-4 w-4" /> 上级目录
          <Shortcut id="goUp" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onHome}>
          <Home className="mr-2 h-4 w-4" /> 主目录
          <Shortcut id="goHome" />
        </DropdownMenuItem>
      </MenuButton>

      <MenuButton label="窗格" {...openFor("窗格")}>
        <DropdownMenuItem onClick={actions.onSplitRow}>
          <LayoutPanelLeft className="mr-2 h-4 w-4" /> 左右分屏
          <Shortcut id="splitRow" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onSplitCol}>
          <LayoutPanelTop className="mr-2 h-4 w-4" /> 上下分屏
          <Shortcut id="splitCol" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onClosePane} disabled={!actions.canClosePane}>
          <PanelRightClose className="mr-2 h-4 w-4" /> 关闭当前窗格
          <Shortcut id="closePane" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.onFocusNextPane}>
          <ArrowLeftRight className="mr-2 h-4 w-4" /> 聚焦下一窗格
          <Shortcut id="focusNextPane" />
        </DropdownMenuItem>
      </MenuButton>

      <MenuButton label="帮助" {...openFor("帮助")}>
        <DropdownMenuLabel>R-Dir</DropdownMenuLabel>
        <DropdownMenuItem onClick={actions.onOpenSettings}>
          <Settings className="mr-2 h-4 w-4" /> 设置（快捷键录制与主题）
          <Shortcut id="openSettings" />
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Info className="mr-2 h-4 w-4" /> 版本 0.14.0（Tauri 2 + React）
        </DropdownMenuItem>
      </MenuButton>

      {/* 右上角主题切换（日 / 月）+ 设置 */}
      <div className="ml-auto flex items-center gap-0.5">
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
          {actions.dark ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
