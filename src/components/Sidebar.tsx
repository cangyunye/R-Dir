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
  Plus,
  SquarePlus,
  Star,
  Tag,
  TerminalSquare,
  Trash2,
  Unplug,
  Upload,
  User,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import {
  MAX_TAGS,
  TAG_COLOR_PALETTE,
  makeTagId,
  tagLabel,
  entryDisplayName,
  type EntryAliases,
  type TagDef,
  type TagNames,
} from "@/lib/persist";
import { useT } from "@/lib/LanguageProvider";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const QUICK_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  home: Home,
  desktop: User,
  documents: Folder,
  downloads: Download,
  pictures: Image,
  music: Music,
  movies: Film,
};

// { id, label } 数组声明（label: 字面量可被 LITERAL_PROP_FILES 提取），还原查找表；
// 内置项显示名经 t() 翻译，自定义项回落路径（数据）
const QUICK_LABELS = Object.fromEntries(
  (
    [
      { id: "home", label: "主目录" },
      { id: "desktop", label: "桌面" },
      { id: "documents", label: "文档" },
      { id: "downloads", label: "下载" },
      { id: "pictures", label: "图片" },
      { id: "music", label: "音乐" },
      { id: "movies", label: "影片" },
    ] as { id: string; label: string }[]
  ).map((s) => [s.id, s.label]),
);

/** v0.31 侧边栏服务器拖拽换组的 DnD 标记类型（与文件拖拽/窗格交换分流互不干扰） */
const SERVER_DND_TYPE = "application/x-rdir-server-id";

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
  entryAliases,
  onRenameQuick,
  tagCounts,
  tags,
  tagNames,
  onRenameTag,
  onAddTag,
  onTagsFullHint,
  activeTagId,
  onSelectTag,
  sftpServers,
  onSftpOpen,
  onSftpDisconnect,
  onSftpEdit,
  onSftpRemove,
  onSftpAdd,
  onSftpExport,
  onSftpImport,
  onSftpClearTemp,
  onSftpSetGroup,
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
  /** v0.31.1 条目显示别名（标签视图里为只读后端条目改的名，这里同步显示）+ 快捷访问重命名显示名 */
  entryAliases?: EntryAliases;
  onRenameQuick?: (path: string, label: string) => void;
  /** 每个标签下的文件数量 */
  tagCounts: Record<string, number>;
  /** 全量标签 = 预设 + 用户自定义（v0.28.0 起支持新增） */
  tags: TagDef[];
  tagNames: TagNames;
  onRenameTag: (tagId: string, label: string) => void;
  /** 新增自定义标签（App 侧校验上限并提醒；返回 false = 已达上限，对话框保持打开） */
  onAddTag: (def: TagDef) => boolean;
  /** 悬停「+」时已达上限：App 弹提醒 */
  onTagsFullHint: () => void;
  activeTagId: string | null;
  onSelectTag: (tagId: string) => void;
  /** SFTP 远程服务器（v0.2） */
  sftpServers: SftpServerView[];
  onSftpOpen: (sv: SftpServerView) => void;
  onSftpDisconnect: (id: string) => void;
  onSftpEdit: (sv: SftpServerView) => void;
  onSftpRemove: (sv: SftpServerView) => void;
  /** v0.29.0 悬停分组名的「+」：新增 SFTP 服务器（弹连接对话框） */
  onSftpAdd: () => void;
  /** v0.31 分组名右键：导出/导入服务器清单、清理远程打开临时文件 */
  onSftpExport?: () => void;
  onSftpImport?: () => void;
  onSftpClearTemp?: () => void;
  /** v0.31 服务器分组整理：拖拽换组 / 分组整体重命名（ids 置为新组名；"" = 默认组） */
  onSftpSetGroup?: (ids: string[], group: string) => void;
  /** v0.25.1 侧边栏右键菜单：在此路径打开终端（可选，缺省不展示终端组） */
  shells?: ShellItem[];
  pluginTerminal?: boolean;
  onOpenTerminal?: (shellId: string, path: string) => void;
  onPropertiesDir?: (dir: string) => void;
  onCopyPath?: (path: string) => void;
}) {
  const copyPath = onCopyPath ?? ((p: string) => navigator.clipboard?.writeText(p).catch(() => {}));
  const t = useT();
  // 右键菜单里「在此打开终端」折叠组的展开状态（同一时刻只有一个菜单打开）
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  // 标签重命名（v0.6.4 右键侧边栏标签）
  const [renameTagOpen, setRenameTagOpen] = useState(false);
  const [renameTagId, setRenameTagId] = useState<string>("red");
  const [renameTagInput, setRenameTagInput] = useState("");
  // v0.28.0 重命名对话框输入框要稳拿焦点：radix 打开时的焦点管理会把焦点给色块按钮，
  // 裸 autoFocus 输了竞争——打字毫无反应（表现为「重命名失效」）。
  const renameInputRef = useRef<HTMLInputElement>(null);
  // 新增标签对话框（v0.28.0 悬停「+」）
  const [addTagOpen, setAddTagOpen] = useState(false);
  const [addTagName, setAddTagName] = useState("");
  const [addTagColor, setAddTagColor] = useState(TAG_COLOR_PALETTE[0]);
  const addTagInputRef = useRef<HTMLInputElement>(null);
  const openAddTag = () => {
    if (tags.length >= MAX_TAGS) {
      onTagsFullHint();
      return;
    }
    // 默认取一个未被占用的色
    const used = new Set(tags.map((tag) => tag.color));
    setAddTagColor(TAG_COLOR_PALETTE.find((c) => !used.has(c)) ?? TAG_COLOR_PALETTE[0]);
    setAddTagName("");
    setAddTagOpen(true);
  };
  const submitAddTag = () => {
    const label = addTagName.trim();
    if (!label) return;
    const ok = onAddTag({ id: makeTagId(), label, color: addTagColor });
    if (ok) setAddTagOpen(false);
  };
  const openRenameTag = (id: string) => {
    const def = tags.find((tag) => tag.id === id) ?? tags[0];
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
  // v0.31.1 快捷访问条目「重命名显示名」：只改侧栏显示的别名，不动本体（远程/只读条目也能改）
  const [renameQuickOpen, setRenameQuickOpen] = useState(false);
  const [renameQuickPath, setRenameQuickPath] = useState("");
  const [renameQuickInput, setRenameQuickInput] = useState("");
  const renameQuickInputRef = useRef<HTMLInputElement>(null);
  const openRenameQuick = (path: string) => {
    setRenameQuickPath(path);
    setRenameQuickInput(entryDisplayName(path, entryAliases ?? {}));
    setRenameQuickOpen(true);
  };
  const submitRenameQuick = () => {
    const label = renameQuickInput.trim();
    if (!label) return;
    onRenameQuick?.(renameQuickPath, label);
    setRenameQuickOpen(false);
  };
  // v0.31 服务器分组整理：分组名右键重命名（组内服务器整体换组）+ 拖拽换组悬停高亮
  const [renameGroupOpen, setRenameGroupOpen] = useState(false);
  const [renameGroupOld, setRenameGroupOld] = useState("");
  const [renameGroupInput, setRenameGroupInput] = useState("");
  const renameGroupInputRef = useRef<HTMLInputElement>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const openRenameGroup = (group: string) => {
    setRenameGroupOld(group);
    setRenameGroupInput(group); // 默认组（""）留空待填，其余预填现名
    setRenameGroupOpen(true);
  };
  const submitRenameGroup = () => {
    const name = renameGroupInput.trim();
    if (!name) return;
    // 分组按显示名对齐（空组名显示为「默认」）；改回「默认」= 解除分组（存空串）
    const value = name === "默认" ? "" : name;
    const ids = sftpServers
      .filter((s) => (s.group || "默认") === renameGroupOld)
      .map((s) => s.id);
    setRenameGroupOpen(false);
    if (ids.length === 0) return;
    onSftpSetGroup?.(ids, value);
  };
  // 对话框每次打开稳拿焦点（radix 焦点竞争后重试一次兜底）
  useEffect(() => {
    if (!renameTagOpen) return;
    const timer = window.setTimeout(() => renameInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [renameTagOpen]);
  useEffect(() => {
    if (!addTagOpen) return;
    const timer = window.setTimeout(() => addTagInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [addTagOpen]);
  useEffect(() => {
    if (!renameGroupOpen) return;
    const timer = window.setTimeout(() => renameGroupInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [renameGroupOpen]);
  const groupedServers = groupServers(sftpServers);

  // 侧边栏路径项共用的右键菜单段：终端折叠组（词汇表与文件列表空白菜单一致）
  const termGroup = (path: string) =>
    pluginTerminal && shells && shells.length > 0 && onOpenTerminal ? (
      <>
        <MenuGroup
          id="terminal"
          label={t("在此打开终端")}
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
                <span className="text-[10px] text-muted-foreground">{t("未安装")}</span>
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
        <FolderOpen className="mr-2 h-4 w-4" /> {t("打开")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onMiddleOpen(path)}>
        <SquarePlus className="mr-2 h-4 w-4" /> {t("在新标签页打开")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copyPath(path)}>
        <Copy className="mr-2 h-4 w-4" /> {t("复制路径")}
      </ContextMenuItem>
      {!hasScheme(path) && termGroup(path)}
      {onPropertiesDir && !hasScheme(path) && (
        <ContextMenuItem onClick={() => onPropertiesDir(path)}>
          <Info className="mr-2 h-4 w-4" /> {t("属性")}
        </ContextMenuItem>
      )}
      {remove && (
        <>
          <ContextMenuSeparator />
          {onRenameQuick && (
            <ContextMenuItem onClick={() => openRenameQuick(path)}>
              <Pencil className="mr-2 h-4 w-4" /> {t("重命名显示名…")}
            </ContextMenuItem>
          )}
          <ContextMenuItem variant="destructive" onClick={remove}>
            <X className="mr-2 h-4 w-4" /> {t("从快速访问移除")}
          </ContextMenuItem>
        </>
      )}
    </>
  );
  return (
    <>
    <Dialog open={renameQuickOpen} onOpenChange={setRenameQuickOpen}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          renameQuickInputRef.current?.focus();
          renameQuickInputRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("重命名显示名")}</DialogTitle>
          <DialogDescription className="break-all">
            {t("只改侧栏显示的名字，不改文件/目录本体；改回原名即清除别名。")}
            <br />
            {renameQuickPath}
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={renameQuickInputRef}
          value={renameQuickInput}
          onChange={(e) => setRenameQuickInput(e.target.value)}
          placeholder={t("显示名")}
          data-testid="rename-quick-input"
          onKeyDown={(e) => {
            // IME 组合中的回车是确认候选词，不作为提交（四处改名/新增输入框同）
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") submitRenameQuick();
            if (e.key === "Escape") setRenameQuickOpen(false);
          }}
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setRenameQuickOpen(false)}>
            {t("取消")}
          </Button>
          <Button size="sm" onClick={submitRenameQuick} disabled={!renameQuickInput.trim()}>
            {t("保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={renameTagOpen} onOpenChange={setRenameTagOpen}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(e) => {
          // 焦点必须落在输入框：交给本回调而非裸 autoFocus（radix 会把焦点给色块按钮）
          e.preventDefault();
          renameInputRef.current?.focus();
          renameInputRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("重命名标签")}</DialogTitle>
          <DialogDescription>{t("自定义标签显示名称（不影响已标记的文件）")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1.5">
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={() => {
                setRenameTagId(tag.id);
                setRenameTagInput(tagLabel(tag, tagNames));
              }}
              className={cn(
                "h-5 w-5 rounded-full transition-transform",
                renameTagId === tag.id && "scale-125 ring-2 ring-ring ring-offset-2",
              )}
              style={{ background: tag.color }}
              title={tagLabel(tag, tagNames)}
            />
          ))}
        </div>
        <Input
          ref={renameInputRef}
          value={renameTagInput}
          onChange={(e) => setRenameTagInput(e.target.value)}
          placeholder={t("标签名称")}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") submitRenameTag();
            if (e.key === "Escape") setRenameTagOpen(false);
          }}
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setRenameTagOpen(false)}>
            {t("取消")}
          </Button>
          <Button size="sm" onClick={submitRenameTag} disabled={!renameTagInput.trim()}>
            {t("保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* v0.31 重命名服务器分组：组内服务器整体换到新组名 */}
    <Dialog open={renameGroupOpen} onOpenChange={setRenameGroupOpen}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          renameGroupInputRef.current?.focus();
          renameGroupInputRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("重命名分组")}</DialogTitle>
          <DialogDescription>
            {t("将「{name}」组内的 {n} 台服务器整体移到新分组", {
              name: renameGroupOld || "默认",
              n: sftpServers.filter((s) => (s.group || "默认") === renameGroupOld).length,
            })}
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={renameGroupInputRef}
          value={renameGroupInput}
          onChange={(e) => setRenameGroupInput(e.target.value)}
          placeholder={t("新分组名")}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") submitRenameGroup();
            if (e.key === "Escape") setRenameGroupOpen(false);
          }}
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setRenameGroupOpen(false)}>
            {t("取消")}
          </Button>
          <Button size="sm" onClick={submitRenameGroup} disabled={!renameGroupInput.trim()}>
            {t("保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={addTagOpen} onOpenChange={setAddTagOpen}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          addTagInputRef.current?.focus();
          addTagInputRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("新增标签")}</DialogTitle>
          <DialogDescription>
            {t("最多 {n} 个标签（含预设），自定义标签可标记任意文件", { n: MAX_TAGS })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          {TAG_COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setAddTagColor(c)}
              className={cn(
                "h-5 w-5 rounded-full transition-transform",
                addTagColor === c && "scale-125 ring-2 ring-ring ring-offset-2",
              )}
              style={{ background: c }}
              title={c}
            />
          ))}
        </div>
        <Input
          ref={addTagInputRef}
          value={addTagName}
          onChange={(e) => setAddTagName(e.target.value)}
          placeholder={t("标签名称")}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") submitAddTag();
            if (e.key === "Escape") setAddTagOpen(false);
          }}
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setAddTagOpen(false)}>
            {t("取消")}
          </Button>
          <Button size="sm" onClick={submitAddTag} disabled={!addTagName.trim()}>
            {t("新增")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ScrollArea className="w-44 shrink-0 border-r bg-sidebar">
      <div className="flex flex-col gap-4 p-2">
        {/* 快速访问（内置 + 用户自定义） */}
        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <FolderHeart className="h-3.5 w-3.5" /> {t("快速访问")}
          </div>
          {quickAccess.map((item) => {
            const Icon = QUICK_ICONS[item.key] ?? Folder;
            const preset = QUICK_LABELS[item.key];
            const label = preset ? t(preset) : item.path;
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
                const name = entryDisplayName(p, entryAliases ?? {});
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
                      title={t("从快捷访问移除")}
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

        {/* 标签（Finder 风格，位于快捷访问下方、磁盘上方；悬停分组名显示「+」新增） */}
        <div>
          <div
            data-sidebar-tags-header=""
            className="group flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground"
          >
            <Tag className="h-3.5 w-3.5" /> {t("标签")}
            <button
              onClick={openAddTag}
              title={tags.length >= MAX_TAGS ? t("最多 {n} 个标签", { n: MAX_TAGS }) : t("新增标签")}
              className="ml-auto hidden rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {tags.map((tag) => {
            const count = tagCounts[tag.id] ?? 0;
            const active = activeTagId === tag.id;
            return (
              <ContextMenu key={tag.id}>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => onSelectTag(tag.id)}
                    onAuxClick={(e) => e.button === 1 && (e.preventDefault(), onMiddleOpen(`tags://${tag.id}`))}
                    title={
                      t("查看「{name}」标签的文件", { name: tagLabel(tag, tagNames) }) +
                      (count > 0 ? t("（{n} 项）", { n: count }) : "")
                    }
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
                      style={{ background: tag.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">{tagLabel(tag, tagNames)}</span>
                    {count > 0 && (
                      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                        {count}
                      </span>
                    )}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-44" collisionPadding={10}>
                  <ContextMenuItem onClick={() => onMiddleOpen(`tags://${tag.id}`)}>
                    <SquarePlus className="mr-2 h-4 w-4" /> {t("在新标签页打开")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => openRenameTag(tag.id)}>
                    <Pencil className="mr-2 h-4 w-4" /> {t("重命名…")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        <div>
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" /> {t("磁盘 / 卷")}
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
            <div className="px-2 py-1 text-xs text-muted-foreground">{t("未检测到磁盘")}</div>
          )}
        </div>

        {/* SFTP 远程服务器（v0.2，内置插件；支持分组；v0.29.0 悬停分组名显示「+」新增；
            v0.31 分组名右键 → 导出/导入清单、清理远程打开临时文件） */}
        <div>
          <ContextMenu onOpenChange={(o) => !o && setExpandedMenu(null)}>
            <ContextMenuTrigger asChild>
              <div
                data-sidebar-servers-header=""
                className="group flex cursor-default items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-muted-foreground"
              >
                <MonitorSmartphone className="h-3.5 w-3.5" /> {t("远程服务器")}
                <button
                  onClick={onSftpAdd}
                  title={t("添加 SFTP 服务器")}
                  className="ml-auto hidden rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </ContextMenuTrigger>
            {(onSftpExport || onSftpImport || onSftpClearTemp) && (
              <ContextMenuContent className="min-w-44" collisionPadding={10}>
                <ContextMenuItem onClick={onSftpAdd}>
                  <Plus className="mr-2 h-4 w-4" /> {t("添加 SFTP 服务器…")}
                </ContextMenuItem>
                {onSftpExport && (
                  <ContextMenuItem onClick={onSftpExport}>
                    <Download className="mr-2 h-4 w-4" /> {t("导出服务器列表…")}
                  </ContextMenuItem>
                )}
                {onSftpImport && (
                  <ContextMenuItem onClick={onSftpImport}>
                    <Upload className="mr-2 h-4 w-4" /> {t("导入服务器列表…")}
                  </ContextMenuItem>
                )}
                {onSftpClearTemp && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={onSftpClearTemp}>
                      <Trash2 className="mr-2 h-4 w-4" /> {t("清理远程临时文件")}
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            )}
          </ContextMenu>
          {sftpServers.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("地址栏输入 sftp:// 连接，或点上方 +")}
            </div>
          )}
          {groupedServers.map(([group, servers]) => (
            <div key={group} className="mb-0.5">
              <ContextMenu onOpenChange={(o) => !o && setExpandedMenu(null)}>
                <ContextMenuTrigger asChild>
                  <div
                    data-server-group={group || "默认"}
                    onDragOver={(e) => {
                      // 只接服务器行拖拽（独立标记类型），文件拖拽路过不响应
                      if (!onSftpSetGroup || !e.dataTransfer.types.includes(SERVER_DND_TYPE))
                        return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverGroup !== group) setDragOverGroup(group);
                    }}
                    onDragLeave={() =>
                      setDragOverGroup((cur) => (cur === group ? null : cur))
                    }
                    onDrop={(e) => {
                      setDragOverGroup(null);
                      if (!onSftpSetGroup) return;
                      const id = e.dataTransfer.getData(SERVER_DND_TYPE);
                      if (!id) return;
                      e.preventDefault();
                      e.stopPropagation(); // 不落入 window 级文件投放
                      // 分组 key 是显示名（空组名显示「默认」），落库还原为空串
                      onSftpSetGroup([id], group === "默认" ? "" : group);
                    }}
                    className={cn(
                      "flex cursor-default items-center gap-1 rounded px-2 pt-0.5 pb-0.5 text-[10px] font-medium text-muted-foreground/80 transition-colors",
                      dragOverGroup === group &&
                        "bg-primary/10 text-foreground ring-1 ring-primary/40",
                    )}
                    title={t("右键重命名分组；把服务器拖到分组名上可换组")}
                  >
                    <span className="min-w-0 truncate">{group === "默认" ? t("默认") : group}</span>
                    <span className="tabular-nums text-[9px] text-muted-foreground/60">
                      {servers.length}
                    </span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-44" collisionPadding={10}>
                  <ContextMenuItem onClick={() => openRenameGroup(group)}>
                    <Pencil className="mr-2 h-4 w-4" /> {t("重命名分组…")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
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
                        draggable={!!onSftpSetGroup}
                        onDragStart={(e) => {
                          if (!onSftpSetGroup) return;
                          e.dataTransfer.setData(SERVER_DND_TYPE, sv.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => setDragOverGroup(null)}
                        title={`${sv.user}@${sv.host}:${sv.port}${sv.connected ? t("（已连接）") : ""} · ${t("右键操作")}${onSftpSetGroup ? " · " + t("拖到分组名可换组") : ""}`}
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
                          <Plug className="mr-2 h-4 w-4" /> {t("连接")}
                        </ContextMenuItem>
                      )}
                      {sv.connected && (
                        <ContextMenuItem onClick={() => onSftpDisconnect(sv.id)}>
                          <Unplug className="mr-2 h-4 w-4" /> {t("断开连接")}
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onClick={() => onSftpEdit(sv)}>
                        <Pencil className="mr-2 h-4 w-4" /> {t("编辑…")}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onClick={() => onSftpRemove(sv)}>
                        <Trash2 className="mr-2 h-4 w-4" /> {t("删除服务器配置")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {sv.connected && (
                    <button
                      onClick={() => onSftpDisconnect(sv.id)}
                      title={t("断开连接")}
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
