import {
  Copy,
  Download,
  Film,
  Folder,
  FolderHeart,
  FolderOpen,
  HardDrive,
  Home,
  Image,
  Info,
  MonitorSmartphone,
  Music,
  Pencil,
  Plug,
  SquarePlus,
  Star,
  Tag,
  TerminalSquare,
  Trash2,
  Unplug,
  User,
  X,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { hasScheme } from "@/lib/cmdline";
import type { QuickAccessItem, SftpServerView, VolumeInfo } from "@/lib/types";
import type { ShellItem } from "@/lib/openerApi";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuGroup } from "@/components/MenuGroup";
import { TAG_DEFS, tagLabel, type TagNames } from "@/lib/persist";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { basename } from "@/lib/format";

const QUICK_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  home: Home,
  desktop: User,
  documents: Folder,
  downloads: Download,
  pictures: Image,
  music: Music,
  movies: Film,
};

const QUICK_LABELS: Record<string, string> = {
  home: "主目录",
  desktop: "桌面",
  documents: "文档",
  downloads: "下载",
  pictures: "图片",
  music: "音乐",
  movies: "影片",
};

function isActive(current: string, target: string): boolean {
  if (current === target) return true;
  // macOS 根目录 "/" 前缀匹配所有路径，特殊处理
  if (target === "/") return false;
  return current.startsWith(target + "/") || current.startsWith(target + "\\");
}

/** 服务器按分组聚合（保持原始顺序，空分组名 → "默认"） */
function groupServers(servers: SftpServerView[]): [string, SftpServerView[]][] {
  const order: string[] = [];
  const map = new Map<string, SftpServerView[]>();
  for (const sv of servers) {
    const g = sv.group || "默认";
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(sv);
  }
  return order.map((g) => [g, map.get(g)!]);
}

export function Sidebar({
  quickAccess,
  volumes,
  currentPath,
  onNavigate,
  onMiddleOpen,
  customQuick,
  onRemoveQuick,
  tagCounts,
  tagNames,
  onRenameTag,
  activeTagId,
  onSelectTag,
  sftpServers,
  onSftpOpen,
  onSftpDisconnect,
  onSftpEdit,
  onSftpRemove,
  shells,
  pluginTerminal = true,
  onOpenTerminal,
  onPropertiesDir,
  onCopyPath,
}: {
  quickAccess: QuickAccessItem[];
  volumes: VolumeInfo[];
  currentPath: string;
  onNavigate: (path: string) => void;
  /** 鼠标中键点击项：在新建标签页中打开该路径 */
  onMiddleOpen: (path: string) => void;
  /** 用户自定义快捷访问（右键文件 → 添加到快速访问） */
  customQuick: string[];
  onRemoveQuick: (path: string) => void;
  /** 每个标签下的文件数量 */
  tagCounts: Record<string, number>;
  tagNames: TagNames;
  onRenameTag: (tagId: string, label: string) => void;
  activeTagId: string | null;
  onSelectTag: (tagId: string) => void;
  /** SFTP 远程服务器（v0.2） */
  sftpServers: SftpServerView[];
  onSftpOpen: (sv: SftpServerView) => void;
  onSftpDisconnect: (id: string) => void;
  onSftpEdit: (sv: SftpServerView) => void;
  onSftpRemove: (sv: SftpServerView) => void;
  /** v0.25.1 侧边栏右键菜单：在此路径打开终端（可选，缺省不展示终端组） */
  shells?: ShellItem[];
  pluginTerminal?: boolean;
  onOpenTerminal?: (shellId: string, path: string) => void;
  onPropertiesDir?: (dir: string) => void;
  onCopyPath?: (path: string) => void;
}) {
  const copyPath = onCopyPath ?? ((p: string) => navigator.clipboard?.writeText(p).catch(() => {}));
  // 右键菜单里「在此打开终端」折叠组的展开状态（同一时刻只有一个菜单打开）
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  // 标签重命名（v0.6.4 右键侧边栏标签）
  const [renameTagOpen, setRenameTagOpen] = useState(false);
  const [renameTagId, setRenameTagId] = useState<string>("red");
  const [renameTagInput, setRenameTagInput] = useState("");
  const openRenameTag = (id: string) => {
    const def = TAG_DEFS.find((t) => t.id === id) ?? TAG_DEFS[0];
    setRenameTagId(id);
    setRenameTagInput(tagLabel(def, tagNames));
    setRenameTagOpen(true);
  };
  const submitRenameTag = () => {
    const label = renameTagInput.trim();
    if (!label) return;
    onRenameTag(renameTagId, label);
    setRenameTagOpen(false);
  };
  const groupedServers = groupServers(sftpServers);

  // 侧边栏路径项共用的右键菜单段：终端折叠组（词汇表与文件列表空白菜单一致）
  const termGroup = (path: string) =>
    pluginTerminal && shells && shells.length > 0 && onOpenTerminal ? (
      <>
        <MenuGroup
          id="terminal"
          label="在此打开终端"
          icon={<TerminalSquare className="mr-2 h-4 w-4" />}
          expanded={expandedMenu === "terminal"}
          onToggle={(id) => setExpandedMenu(expandedMenu === id ? null : id)}
        >
          {shells.map((sh) => (
            <ContextMenuItem
              key={sh.id}
              disabled={!sh.detected}
              onClick={() => onOpenTerminal(sh.id, path)}
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
    ) : null;

  // 路径项通用菜单：打开 / 新标签页打开 / 复制路径 / 终端 / 属性（自定义项多一个移除）
  const dirMenuItems = (path: string, remove?: () => void) => (
    <>
      <ContextMenuItem onClick={() => onNavigate(path)}>
        <FolderOpen className="mr-2 h-4 w-4" /> 打开
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onMiddleOpen(path)}>
        <SquarePlus className="mr-2 h-4 w-4" /> 在新标签页打开
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copyPath(path)}>
        <Copy className="mr-2 h-4 w-4" /> 复制路径
      </ContextMenuItem>
      {!hasScheme(path) && termGroup(path)}
      {onPropertiesDir && !hasScheme(path) && (
        <ContextMenuItem onClick={() => onPropertiesDir(path)}>
          <Info className="mr-2 h-4 w-4" /> 属性
        </ContextMenuItem>
      )}
      {remove && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={remove}>
            <X className="mr-2 h-4 w-4" /> 从快速访问移除
          </ContextMenuItem>
        </>
      )}
    </>
  );
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
    <ScrollArea className="w-44 shrink-0 border-r bg-sidebar">
      <div className="flex flex-col gap-4 p-2">
        {/* 快速访问（内置 + 用户自定义） */}
        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <FolderHeart className="h-3.5 w-3.5" /> 快速访问
          </div>
          {quickAccess.map((item) => {
            const Icon = QUICK_ICONS[item.key] ?? Folder;
            const label = QUICK_LABELS[item.key] ?? item.path;
            return (
              <ContextMenu key={item.key} onOpenChange={(o) => !o && setExpandedMenu(null)}>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => onNavigate(item.path)}
                    onAuxClick={(e) => e.button === 1 && (e.preventDefault(), onMiddleOpen(item.path))}
                    title={item.path}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                      isActive(currentPath, item.path)
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{label}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-44" collisionPadding={10}>
                  {dirMenuItems(item.path)}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {/* 用户自定义快捷访问（在快捷访问下方） */}
          {customQuick.length > 0 && (
            <div className="mt-1 border-t pt-1">
              {customQuick.map((p) => {
                const name = basename(p) || p;
                return (
                  <div
                    key={p}
                    className="group relative"
                  >
                    <ContextMenu onOpenChange={(o) => !o && setExpandedMenu(null)}>
                      <ContextMenuTrigger asChild>
                        <button
                          onClick={() => onNavigate(p)}
                          onAuxClick={(e) => e.button === 1 && (e.preventDefault(), onMiddleOpen(p))}
                          title={p}
                          className={cn(
                            "flex w-full items-center gap-2 rounded py-1.5 pr-6 pl-2 text-left text-xs",
                            isActive(currentPath, p)
                              ? "bg-accent text-accent-foreground"
                              : "text-foreground hover:bg-muted",
                          )}
                        >
                          <Star className="h-4 w-4 shrink-0 text-folder" />
                          <span className="min-w-0 truncate">{name}</span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="min-w-44" collisionPadding={10}>
                        {dirMenuItems(p, () => onRemoveQuick(p))}
                      </ContextMenuContent>
                    </ContextMenu>
                    <button
                      onClick={() => onRemoveQuick(p)}
                      title="从快捷访问移除"
                      className="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 标签（Finder 风格，位于快捷访问下方、磁盘上方） */}
        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <Tag className="h-3.5 w-3.5" /> 标签
          </div>
          {TAG_DEFS.map((t) => {
            const count = tagCounts[t.id] ?? 0;
            const active = activeTagId === t.id;
            return (
              <ContextMenu key={t.id}>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => onSelectTag(t.id)}
                    onAuxClick={(e) => e.button === 1 && (e.preventDefault(), onMiddleOpen(`tags://${t.id}`))}
                    title={`查看「${tagLabel(t, tagNames)}」标签的文件${count > 0 ? `（${count} 项）` : ""}`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                      active
                        ? "bg-accent text-accent-foreground"
                        : count === 0
                          ? "text-muted-foreground/70 hover:bg-muted"
                          : "text-foreground hover:bg-muted",
                    )}
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ background: t.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">{tagLabel(t, tagNames)}</span>
                    {count > 0 && (
                      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                        {count}
                      </span>
                    )}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-44" collisionPadding={10}>
                  <ContextMenuItem onClick={() => onMiddleOpen(`tags://${t.id}`)}>
                    <SquarePlus className="mr-2 h-4 w-4" /> 在新标签页打开
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => openRenameTag(t.id)}>
                    <Pencil className="mr-2 h-4 w-4" /> 重命名…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" /> 磁盘 / 卷
          </div>
          {volumes.map((vol) => (
            <ContextMenu key={vol.path} onOpenChange={(o) => !o && setExpandedMenu(null)}>
              <ContextMenuTrigger asChild>
                <button
                  onClick={() => onNavigate(vol.path)}
                  onAuxClick={(e) => e.button === 1 && (e.preventDefault(), onMiddleOpen(vol.path))}
                  title={vol.path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                    isActive(currentPath, vol.path)
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-muted",
                  )}
                >
                    <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{vol.name}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="min-w-44" collisionPadding={10}>
                {dirMenuItems(vol.path)}
              </ContextMenuContent>
            </ContextMenu>
          ))}
          {volumes.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">未检测到磁盘</div>
          )}
        </div>

        {/* SFTP 远程服务器（v0.2，内置插件；支持分组） */}
        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <MonitorSmartphone className="h-3.5 w-3.5" /> 远程服务器
          </div>
          {sftpServers.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              地址栏输入 sftp:// 连接
            </div>
          )}
          {groupedServers.map(([group, servers]) => (
            <div key={group} className="mb-0.5">
              <div className="flex items-center gap-1 px-2 pt-0.5 pb-0.5 text-[10px] font-medium text-muted-foreground/80">
                <span className="min-w-0 truncate">{group || "默认"}</span>
                <span className="tabular-nums text-[9px] text-muted-foreground/60">
                  {servers.length}
                </span>
              </div>
              {servers.map((sv) => (
                <div key={sv.id} className="group relative">
                  <ContextMenu onOpenChange={(o) => !o && setExpandedMenu(null)}>
                    <ContextMenuTrigger asChild>
                      <button
                        onClick={() => onSftpOpen(sv)}
                        onAuxClick={(e) =>
                          e.button === 1 &&
                          (e.preventDefault(), onMiddleOpen(`sftp://${sv.user}@${sv.host}:${sv.port}/`))
                        }
                        title={`${sv.user}@${sv.host}:${sv.port}${sv.connected ? "（已连接）" : ""} · 右键操作`}
                        className={cn(
                          "flex w-full items-center gap-2 rounded py-1.5 pr-6 pl-2 text-left text-xs",
                          isActive(currentPath, `sftp://${sv.user}@${sv.host}:${sv.port}/`)
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground hover:bg-muted",
                        )}
                      >
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            sv.connected ? "bg-ok" : "bg-muted-foreground/40",
                          )}
                        />
                        <span className="min-w-0 truncate">{sv.name}</span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="min-w-44" collisionPadding={10}>
                      {!sv.connected && (
                        <ContextMenuItem onClick={() => onSftpOpen(sv)}>
                          <Plug className="mr-2 h-4 w-4" /> 连接
                        </ContextMenuItem>
                      )}
                      {sv.connected && (
                        <ContextMenuItem onClick={() => onSftpDisconnect(sv.id)}>
                          <Unplug className="mr-2 h-4 w-4" /> 断开连接
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onClick={() => onSftpEdit(sv)}>
                        <Pencil className="mr-2 h-4 w-4" /> 编辑…
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onClick={() => onSftpRemove(sv)}>
                        <Trash2 className="mr-2 h-4 w-4" /> 删除服务器配置
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {sv.connected && (
                    <button
                      onClick={() => onSftpDisconnect(sv.id)}
                      title="断开连接"
                      className="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </ScrollArea>
    </>
  );
}
