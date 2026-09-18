import { useMemo } from "react";
import { FolderOpen, Tag, X } from "lucide-react";
import { tagById, tagLabel, type FileTags, type TagNames } from "@/lib/persist";
import { FileIcon } from "@/components/FileIcon";
import { cn } from "@/lib/utils";

/**
 * 标签过滤视图（Finder 风格）：展示某个标签下的全部文件/文件夹，
 * 点击选中、双击跳转所在目录并定位，顶部横幅可关闭。
 */
export function TagView({
  tagId,
  fileTags,
  tagNames,
  currentPath,
  onOpen,
  onExit,
  isActive,
}: {
  tagId: string;
  fileTags: FileTags;
  tagNames: TagNames;
  currentPath: string;
  onOpen: (path: string) => void;
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

  const nameOf = (p: string) => {
    const norm = p.replace(/\\/g, "/");
    return norm.slice(norm.lastIndexOf("/") + 1);
  };

  const extOf = (p: string) => {
    const n = nameOf(p);
    const i = n.lastIndexOf(".");
    return i > 0 ? n.slice(i + 1).toLowerCase() : "";
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
          files.map((p) => (
            <button
              key={p}
              onClick={() => onOpen(p)}
              title={`${p}\n双击跳转所在目录（当前：${currentPath}）`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60"
            >
              <FileIcon
                entry={{
                  name: nameOf(p),
                  path: p,
                  is_dir: false,
                  is_symlink: false,
                  size: 0,
                  modified: null,
                  created: null,
                  permissions: "",
                  extension: extOf(p),
                }}
                size={16}
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {nameOf(p)}
              </span>
              <span className="min-w-0 max-w-[45%] truncate text-[10px] text-muted-foreground">
                {p}
              </span>
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            </button>
          ))
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
