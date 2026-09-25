import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Clipboard,
  Crosshair,
  FolderOpen,
  Star,
  Tag,
  X,
} from "lucide-react";
import { tagById, tagLabel, TAG_DEFS, type FileTags, type TagNames } from "@/lib/persist";
import { FileIcon } from "@/components/FileIcon";
import { statPaths } from "@/lib/api";
import { MenuGroup } from "@/components/MenuGroup";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { hideExtension } from "@/lib/format";

/**
 * 标签过滤视图（Finder 风格）：展示某个标签下的全部文件/文件夹，
 * 点击选中、双击跳转所在目录并定位，顶部横幅可关闭。
 * 条目右键菜单：定位 / 打开 / 加标签 / 复制路径 / 快捷访问 / 移除此标签。
 */
export function TagView({
  tagId,
  fileTags,
  tagNames,
  currentPath,
  showExtensions,
  onOpen,
  onOpenFile,
  onReveal,
  onToggleTag,
  onCopyPath,
  onToggleQuick,
  customQuick,
  onExit,
  isActive,
}: {
  tagId: string;
  fileTags: FileTags;
  tagNames: TagNames;
  currentPath: string;
  /** v0.14 显示文件扩展名 */
  showExtensions: boolean;
  onOpen: (path: string) => void;
  onOpenFile: (path: string) => void;
  onReveal: (path: string, isDir: boolean) => void;
  onToggleTag: (path: string, tagId: string) => void;
  onCopyPath: (path: string) => void;
  onToggleQuick: (path: string) => void;
  customQuick: string[];
  onExit: () => void;
  isActive: boolean;
}) {
  const def = tagById(tagId);
  const files = useMemo(
    () =>
      Object.entries(fileTags)
        .filter(([, tags]) => tags.includes(tagId))
        .map(([p]) => p),
    [fileTags, tagId],
  );

  // 条目类型（目录 / 文件）：标签可作用于文件夹，右键菜单据此显示"定位到文件夹"等
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  useEffect(() => {
    if (files.length === 0) {
      setKinds({});
      return;
    }
    let cancelled = false;
    statPaths(files)
      .then((ks) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        files.forEach((p, i) => {
          map[p] = ks[i] ?? "file";
        });
        setKinds(map);
      })
      .catch(() => {
        /* 探测失败按文件处理 */
      });
    return () => {
      cancelled = true;
    };
  }, [files]);

  const nameOf = (p: string) => {
    const norm = p.replace(/\\/g, "/");
    return norm.slice(norm.lastIndexOf("/") + 1);
  };

  const extOf = (p: string) => {
    const n = nameOf(p);
    const i = n.lastIndexOf(".");
    return i > 0 ? n.slice(i + 1).toLowerCase() : "";
  };

  const isDirOf = (p: string) => {
    const k = kinds[p];
    return k === "dir" || k === "symlink";
  };

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        isActive && "shadow-[inset_0_0_0_1px_hsl(var(--ring)/0.35)]",
      )}
    >
      {/* 横幅 */}
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs"
        style={{
          borderLeft: `3px solid ${def?.color ?? "#8e8e93"}`,
          background: `color-mix(in srgb, ${def?.color ?? "#8e8e93"} 10%, transparent)`,
        }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: def?.color ?? "#8e8e93" }}
        />
        <span className="font-medium text-foreground">
          标签：{def ? tagLabel(def, tagNames) : tagId}
        </span>
        <span className="text-muted-foreground">{files.length} 项</span>
        <button
          onClick={onExit}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="退出标签视图（返回上一目录）"
        >
          <X className="h-3 w-3" /> 退出
        </button>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1 select-none">
        {files.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
            <Tag className="h-6 w-6 opacity-40" />
            此标签下还没有项目
            <span>在任意文件上右键 → 标签，即可添加</span>
          </div>
        ) : (
          files.map((p) => {
            const isDir = isDirOf(p);
            const entry = {
              name: nameOf(p),
              path: p,
              is_dir: isDir,
              is_symlink: kinds[p] === "symlink",
              size: 0,
              modified: null,
              created: null,
              permissions: "",
              extension: extOf(p),
            };
            return (
              <ContextMenu
                key={p}
                onOpenChange={(o) => {
                  if (!o) setExpandedMenu(null);
                }}
              >
                <ContextMenuTrigger asChild>
                  <button
                    data-tag-path={p}
                    onClick={() => onOpen(p)}
                    title={`${p}\n双击跳转所在目录（当前：${currentPath}）`}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60"
                  >
                    <FileIcon
                      entry={entry}
                      size={16}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {showExtensions ? nameOf(p) : hideExtension(nameOf(p), isDir)}
                    </span>
                    <span className="min-w-0 max-w-[45%] truncate text-[10px] text-muted-foreground">
                      {p}
                    </span>
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-48" collisionPadding={10}>
                  <ContextMenuItem onClick={() => onOpen(p)}>
                    <FolderOpen className="mr-2 h-4 w-4" /> 打开
                  </ContextMenuItem>
                  {!isDir && (
                    <ContextMenuItem onClick={() => onOpenFile(p)}>
                      <FolderOpen className="mr-2 h-4 w-4" /> 用默认应用打开
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem onClick={() => onReveal(p, isDir)}>
                    <Crosshair className="mr-2 h-4 w-4" /> 定位到{isDir ? "文件夹" : "文件"}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  {/* 标签（内联展开，避免 Radix Sub 在 WKWebView 下的点击丢失） */}
                  <MenuGroup
                    id="tagViewTags"
                    label="标签"
                    icon={<Tag className="mr-2 h-4 w-4" />}
                    expanded={expandedMenu === "tagViewTags"}
                    onToggle={(id) =>
                      setExpandedMenu((cur) => (cur === id ? null : id))
                    }
                  >
                    {TAG_DEFS.map((t) => {
                      const checked = (fileTags[p] ?? []).includes(t.id);
                      return (
                        <ContextMenuItem
                          key={t.id}
                          onSelect={() => onToggleTag(p, t.id)}
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
                  </MenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onCopyPath(p)}>
                    <Clipboard className="mr-2 h-4 w-4" /> 复制路径
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onToggleQuick(p)}>
                    <Star className="mr-2 h-4 w-4" />
                    {customQuick.includes(p) ? "从快捷访问移除" : "添加到快捷访问"}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => onToggleTag(p, tagId)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Tag className="mr-2 h-4 w-4" /> 移除此标签
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
      </div>
    </div>
  );
}

/** 文件行上显示的标签色点（Finder 风格，最多显示全部标签） */
export function TagDots({
  path,
  fileTags,
}: {
  path: string;
  fileTags: FileTags;
}) {
  const tags = fileTags[path] ?? [];
  if (tags.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {tags
        .map((id) => tagById(id))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => (
          <span
            key={d.id}
            className="h-2 w-2 rounded-full ring-1 ring-background"
            style={{ background: d.color }}
            title={`标签：${d.label}`}
          />
        ))}
    </span>
  );
}
