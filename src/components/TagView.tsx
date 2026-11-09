import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Check,
  Clipboard,
  Crosshair,
  FolderOpen,
  LayoutGrid,
  List,
  Pencil,
  Star,
  Tag,
  X,
} from "lucide-react";
import {
  parentOf,
  tagLabel,
  TAG_DEFS,
  type EntryAliases,
  type FileTags,
  type TagDef,
  type TagNames,
} from "@/lib/persist";
import { FileIcon } from "@/components/FileIcon";
import { statPaths } from "@/lib/api";
import { MenuGroup } from "@/components/MenuGroup";
import { RenameInput } from "@/components/RenameInput";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn, fgOnTagColor } from "@/lib/utils";
import { useT } from "@/lib/LanguageProvider";
import { hideExtension } from "@/lib/format";
import { isHttpPath } from "@/lib/sftp-path";

/**
 * 标签过滤视图（Finder 风格）：展示某个标签下的全部文件/文件夹，
 * 点击选中、双击跳转所在目录并定位。
 * v0.39 横幅升级为 Hero 渐变横幅（标签色光晕 + 统计行 + 入场流光），
 * 标签色渗入列表（悬停色底 / 左色标 / 路径染色），并新增卡片墙视图
 * （横幅内列表/网格切换，偏好持久化 localStorage）。
 * 条目右键菜单：定位 / 打开 / 重命名 / 加标签 / 复制路径 / 快捷访问 / 移除此标签。
 */

/** 卡片墙偏好（全局，跨窗格/跨标签共享） */
const TAG_VIEW_MODE_KEY = "rfm.tag-view-mode";

export function TagView({
  tagId,
  fileTags,
  tags: tagsProp,
  tagNames,
  currentPath,
  showExtensions,
  onOpen,
  onOpenFile,
  onReveal,
  onToggleTag,
  onCopyPath,
  onToggleQuick,
  onRename,
  aliases,
  customQuick,
  onExit,
  isActive,
}: {
  tagId: string;
  fileTags: FileTags;
  /** 全量标签 = 预设 + 自定义（v0.28.0；缺省回落预设） */
  tags?: TagDef[];
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
  /** v0.31 重命名条目本体（文件夹/文件；App 侧负责迁移标签与快捷访问路径）。
   *  v0.31.1：HTTP 条目改的是显示别名（只读后端），App 侧分流 */
  onRename: (path: string, newName: string) => void;
  /** v0.31.1 显示别名（path → 名）；有别名的条目显示别名、本名退到副标题 */
  aliases?: EntryAliases;
  customQuick: string[];
  onExit: () => void;
  isActive: boolean;
}) {
  // v0.28.0 自定义标签也在查找范围（否则新标签视图横幅回落原始 id）
  const allTagDefs = tagsProp ?? TAG_DEFS;
  const t = useT();
  const findTag = (id: string) => allTagDefs.find((t) => t.id === id);
  const def = findTag(tagId);
  const files = useMemo(
    () =>
      Object.entries(fileTags)
        .filter(([, tags]) => tags.includes(tagId))
        .map(([p]) => p),
    [fileTags, tagId],
  );
  const color = def?.color ?? "#8e8e93";
  const label = def ? tagLabel(def, tagNames) : tagId;
  /** 标签色洗色：pct% 标签色混入透明底（横幅渐变/胶囊/悬停底共用一套口径） */
  const tint = (pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

  // 视图模式：详情列表 / 卡片墙（全局偏好，跨窗格共享）
  const [viewMode, setViewMode] = useState<"list" | "grid">(() => {
    try {
      return localStorage.getItem(TAG_VIEW_MODE_KEY) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  const switchView = (m: "list" | "grid") => {
    setViewMode(m);
    try {
      localStorage.setItem(TAG_VIEW_MODE_KEY, m);
    } catch {
      /* 隐私模式等存不进就算了 */
    }
  };

  // 条目类型（目录 / 文件）：标签可作用于文件夹，右键菜单据此显示"定位到文件夹"等
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  /** v0.31 行内重命名会话（本体改名，路径迁移由 App 侧完成） */
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
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
    const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return norm.slice(norm.lastIndexOf("/") + 1) || p;
  };

  /** 显示名：有别名用别名（只读后端条目的"改名"），否则本名 */
  const aliasOf = (p: string) => aliases?.[p]?.trim() || "";
  const displayNameOf = (p: string, isDir: boolean) => {
    const a = aliasOf(p);
    if (a) return a;
    return showExtensions ? nameOf(p) : hideExtension(nameOf(p), isDir);
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

  // 统计行：文件夹/文件数（kind 探测齐全才显示，避免半程闪烁）+ 去重父目录数
  const dirCount = useMemo(
    () => Object.values(kinds).filter((k) => k === "dir" || k === "symlink").length,
    [kinds],
  );
  const locCount = useMemo(() => new Set(files.map((p) => parentOf(p))).size, [files]);
  const kindsReady = files.length > 0 && Object.keys(kinds).length >= files.length;
  const statText = useMemo(() => {
    const parts: string[] = [];
    if (kindsReady) {
      if (dirCount > 0) parts.push(t("{n} 个文件夹", { n: dirCount }));
      const fil = files.length - dirCount;
      if (fil > 0) parts.push(t("{n} 个文件", { n: fil }));
    }
    if (locCount > 1) parts.push(t("{n} 个位置", { n: locCount }));
    return parts.join(" · ");
  }, [t, kindsReady, dirCount, files.length, locCount]);

  const renderEntry = (p: string) => {
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
    const isRenaming = renaming?.path === p;
    const renameInput = isRenaming ? (
      // 阻断冒泡：改名期间点击让位给输入框
      <span
        className="block"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <RenameInput
          initial={renaming.name}
          onCommit={(name) => {
            setRenaming(null);
            onRename(p, name);
          }}
          onCancel={() => setRenaming(null)}
        />
      </span>
    ) : null;
    const rowTitle = p + "\n" + t("双击跳转所在目录（当前：{cur}）", { cur: currentPath });

    const listTrigger = (
      <div
        data-tag-path={p}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!isRenaming) onOpen(p);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isRenaming) {
            // 阻断冒泡：全局 keymap「open」作用于窗格选中项，会再开一次
            e.stopPropagation();
            onOpen(p);
          }
        }}
        title={rowTitle}
        className="group relative flex w-full cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[color-mix(in_srgb,var(--tag)_8%,transparent)]"
      >
        {/* 左色标：悬停时从左缘浮出（标签色渗透） */}
        <span
          aria-hidden
          className="absolute left-1 top-1/2 h-0 w-[3px] -translate-y-1/2 rounded-full bg-[var(--tag)] opacity-90 transition-[height] duration-150 group-hover:h-[60%]"
        />
        <FileIcon entry={entry} size={16} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {isRenaming ? renameInput : displayNameOf(p, isDir)}
        </span>
        <TagDots path={p} fileTags={fileTags} tags={tagsProp} />
        <span className="min-w-0 max-w-[45%] truncate text-[10px] text-[color-mix(in_srgb,var(--tag)_40%,var(--muted-foreground))]">
          {aliasOf(p) ? `${nameOf(p)} · ${p}` : p}
        </span>
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      </div>
    );

    const cardTrigger = (
      <div
        data-tag-path={p}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!isRenaming) onOpen(p);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isRenaming) {
            e.stopPropagation();
            onOpen(p);
          }
        }}
        title={rowTitle}
        className="group relative w-full cursor-default rounded-xl border bg-card p-3 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--tag)_45%,transparent)] hover:shadow-[0_8px_22px_color-mix(in_srgb,var(--tag)_16%,transparent)]"
      >
        <span className="absolute right-2.5 top-2.5">
          <TagDots path={p} fileTags={fileTags} tags={tagsProp} />
        </span>
        <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[color-mix(in_srgb,var(--tag)_11%,transparent)] transition-colors group-hover:bg-[color-mix(in_srgb,var(--tag)_20%,transparent)]">
          <FileIcon entry={entry} size={18} className="text-muted-foreground" />
        </div>
        <div className="mt-2 truncate text-[13px] font-semibold text-foreground">
          {isRenaming ? renameInput : displayNameOf(p, isDir)}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{parentOf(p)}</div>
      </div>
    );

    return (
      <ContextMenu
        key={p}
        onOpenChange={(o) => {
          if (!o) setExpandedMenu(null);
        }}
      >
        <ContextMenuTrigger asChild>
          {viewMode === "grid" ? cardTrigger : listTrigger}
        </ContextMenuTrigger>
        <ContextMenuContent
          className="min-w-48"
          collisionPadding={10}
          onCloseAutoFocus={(e) => {
            // 右键「重命名」后焦点留给行内 RenameInput（radix 回焦触发行会抢走输入框焦点）
            if (renaming?.path === p) e.preventDefault();
          }}
        >
          <ContextMenuItem onClick={() => onOpen(p)}>
            <FolderOpen className="mr-2 h-4 w-4" /> {t("打开")}
          </ContextMenuItem>
          {!isDir && (
            <ContextMenuItem onClick={() => onOpenFile(p)}>
              <FolderOpen className="mr-2 h-4 w-4" /> {t("用默认应用打开")}
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => onReveal(p, isDir)}>
            <Crosshair className="mr-2 h-4 w-4" /> {isDir ? t("定位到文件夹") : t("定位到文件")}
          </ContextMenuItem>
          {/* v0.31 重命名本体（含文件夹）；HTTP 只读后端改的是显示别名（v0.31.1） */}
          <ContextMenuItem
            onClick={() =>
              setRenaming({
                path: p,
                name: isHttpPath(p) ? aliasOf(p) || nameOf(p) : nameOf(p),
              })
            }
          >
            <Pencil className="mr-2 h-4 w-4" />
            {isHttpPath(p) ? t("重命名显示名…") : t("重命名…")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* 标签（内联展开，避免 Radix Sub 在 WKWebView 下的点击丢失） */}
          <MenuGroup
            id="tagViewTags"
            label={t("标签")}
            icon={<Tag className="mr-2 h-4 w-4" />}
            expanded={expandedMenu === "tagViewTags"}
            onToggle={(id) =>
              setExpandedMenu((cur) => (cur === id ? null : id))
            }
          >
            {(tagsProp ?? TAG_DEFS).map((tag) => {
              const checked = (fileTags[p] ?? []).includes(tag.id);
              return (
                <ContextMenuItem
                  key={tag.id}
                  onSelect={() => onToggleTag(p, tag.id)}
                >
                  <span
                    className="mr-2 h-3 w-3 rounded-full"
                    style={{ background: tag.color }}
                  />
                  {tagLabel(tag, tagNames)}
                  {checked && <Check className="ml-auto h-3.5 w-3.5" />}
                </ContextMenuItem>
              );
            })}
          </MenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopyPath(p)}>
            <Clipboard className="mr-2 h-4 w-4" /> {t("复制路径")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onToggleQuick(p)}>
            <Star className="mr-2 h-4 w-4" />
            {customQuick.includes(p) ? t("从快捷访问移除") : t("添加到快捷访问")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onToggleTag(p, tagId)}
            className="text-destructive focus:text-destructive"
          >
            <Tag className="mr-2 h-4 w-4" /> {t("移除此标签")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        isActive && "shadow-[inset_0_0_0_1px_var(--ring)]",
      )}
      // --tag 供后代 Tailwind 任意值（悬停色底/左色标/卡片光晕）取用；
      // --tag-ink 是洗色底上的文字色（混入前景色，随主题自动翻转明暗）
      style={
        {
          "--tag": color,
          "--tag-ink": `color-mix(in srgb, ${color} 68%, var(--foreground))`,
        } as CSSProperties
      }
    >
      {/* Hero 横幅：标签色渐变 + 光晕 + 统计行 + 视图切换（key 使流光随切换标签重放） */}
      <div data-tagview-hero className="relative mx-2.5 mt-2.5 shrink-0 overflow-hidden rounded-xl px-4 pb-3 pt-3">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background: `radial-gradient(150px 90px at 10% 15%, ${tint(26)}, transparent 70%), linear-gradient(115deg, ${tint(16)}, ${tint(6)} 45%, transparent 74%)`,
          }}
        />
        <div key={tagId} aria-hidden className="tag-hero-sweep pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-3">
          <div
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px]"
            style={{
              background: `linear-gradient(140deg, ${color}, color-mix(in srgb, ${color} 62%, white))`,
              color: fgOnTagColor(color),
              boxShadow: `0 4px 14px ${tint(40)}`,
            }}
          >
            <Tag className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[15px] font-semibold leading-6">{label}</span>
              <span
                className="shrink-0 rounded-full px-2 py-px text-[11px] font-medium"
                style={{ background: tint(16), color: "var(--tag-ink)" }}
              >
                {t("{n} 项", { n: files.length })}
              </span>
            </div>
            {statText && (
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{statText}</div>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <div className="flex items-center gap-0.5 rounded-lg bg-muted/70 p-0.5">
              <button
                type="button"
                title={t("列表视图")}
                aria-pressed={viewMode === "list"}
                onClick={() => switchView("list")}
                className={cn(
                  "grid h-6 w-7 place-items-center rounded-md transition-colors",
                  viewMode === "list"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title={t("网格视图")}
                aria-pressed={viewMode === "grid"}
                onClick={() => switchView("grid")}
                className={cn(
                  "grid h-6 w-7 place-items-center rounded-md transition-colors",
                  viewMode === "grid"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              onClick={onExit}
              className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t("退出标签视图（返回上一目录）")}
            >
              <X className="h-3 w-3" /> {t("退出")}
            </button>
          </div>
        </div>
        {/* 底缘渐隐色线：收住横幅与列表的过渡 */}
        <div
          aria-hidden
          className="absolute inset-x-3 bottom-0 h-0.5"
          style={{ background: `linear-gradient(90deg, ${tint(65)}, transparent 82%)` }}
        />
      </div>

      {/* 列表 / 卡片墙 */}
      {files.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-3 px-4 py-14 text-center text-xs text-muted-foreground">
          <span
            className="grid h-12 w-12 place-items-center rounded-2xl"
            style={{ background: tint(10) }}
          >
            <Tag className="h-5 w-5 opacity-70" style={{ color: "var(--tag-ink)" }} />
          </span>
          {t("此标签下还没有项目")}
          <span>{t("在任意文件上右键 → 标签，即可添加")}</span>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] content-start gap-2.5 overflow-y-auto p-3 select-none">
          {files.map(renderEntry)}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1 select-none">
          {files.map(renderEntry)}
        </div>
      )}
    </div>
  );
}

/** 文件行上显示的标签色点（Finder 风格，最多显示全部标签；自定义标签经 tags 下发） */
export function TagDots({
  path,
  fileTags,
  tags: tagsProp,
}: {
  path: string;
  fileTags: FileTags;
  /** 全量标签 = 预设 + 自定义（v0.28.0；缺省回落预设） */
  tags?: TagDef[];
}) {
  const t = useT();
  const tagIds = fileTags[path] ?? [];
  if (tagIds.length === 0) return null;
  const defs = tagsProp ?? TAG_DEFS;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {tagIds
        .map((id) => defs.find((d) => d.id === id))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => (
          <span
            key={d.id}
            className="h-2 w-2 rounded-full ring-1 ring-background"
            style={{ background: d.color }}
            title={t("标签：{name}", { name: tagLabel(d, {}) })}
          />
        ))}
    </span>
  );
}
