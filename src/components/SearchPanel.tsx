import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Clipboard,
  Crosshair,
  ExternalLink,
  FileSearch,
  FolderSearch,
  Loader2,
  Pencil,
  SearchX,
  X,
  Zap,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FileIcon } from "@/components/FileIcon";
import { RenameInput } from "@/components/RenameInput";
import { useModalLayer } from "@/hooks/useModalLayer";
import { isTopModalLayer } from "@/lib/modal-stack";
import { findFiles, renameEntry, searchContent } from "@/lib/api";
import { isSftpPath } from "@/lib/sftp-path";
import { useT } from "@/lib/LanguageProvider";
import type { FileEntry, FindEntry, SearchMatch } from "@/lib/types";
import { cn } from "@/lib/utils";

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx + 1).toLowerCase();
}

/** 通配符转整名匹配正则：* → .*、? → .，其余转义（fd --glob 的前端等价，用于当前层过滤） */
function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  let src = "";
  for (const ch of glob) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  return new RegExp(`^${src}$`, caseSensitive ? "" : "i");
}

/** 灯芯按钮灯色分组：蓝/绿 = 搜索范围，琥珀/紫 = 匹配方式 */
type ChipColor = "blue" | "green" | "amber" | "purple";

const CHIP_ON: Record<ChipColor, { frame: string; led: string }> = {
  blue: {
    frame: "border-blue-500/60 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    led: "bg-blue-500 shadow-[0_0_4px_rgba(59,130,246,0.9)]",
  },
  green: {
    frame: "border-emerald-500/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    led: "bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.9)]",
  },
  amber: {
    frame: "border-amber-500/60 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    led: "bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.9)]",
  },
  purple: {
    frame: "border-purple-500/60 bg-purple-500/10 text-purple-600 dark:text-purple-400",
    led: "bg-purple-500 shadow-[0_0_4px_rgba(168,85,247,0.9)]",
  },
};

/** 灯芯开关按钮：左侧 LED 灯珠；点亮 = 彩色边框 + 淡彩底 + 灯珠发光 */
function ToggleChip({
  on,
  color,
  label,
  title,
  onClick,
}: {
  on: boolean;
  color: ChipColor;
  label: string;
  title: string;
  onClick: () => void;
}) {
  const s = CHIP_ON[color];
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors",
        on
          ? s.frame
          : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full transition-all",
          on ? s.led : "bg-border",
        )}
      />
      {label}
    </button>
  );
}

/** 字面量高亮（不区分大小写），返回节点列表 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: { t: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      parts.push({ t: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ t: text.slice(i, idx), hit: false });
    parts.push({ t: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return (
    <>
      {parts.map((p, n) =>
        p.hit ? (
          <mark key={n} className="rounded-sm bg-yellow-300/70 px-0.5 text-foreground">
            {p.t}
          </mark>
        ) : (
          <span key={n}>{p.t}</span>
        ),
      )}
    </>
  );
}

/** 一条搜索结果：单击选中、双击打开（文件走系统关联程序，目录进入）、右键定位/打开/重命名/复制路径 */
function ResultRow({
  path,
  relPath,
  isDir,
  selected,
  onActivate,
  onReveal,
  onOpenFile,
  onCopyPath,
  onRename,
  renaming,
  children,
}: {
  path: string;
  relPath: string;
  isDir: boolean;
  selected: boolean;
  onActivate: () => void;
  onReveal: (path: string, isDir: boolean) => void;
  onOpenFile: (path: string) => void;
  onCopyPath: (path: string) => void;
  /** 右键重命名（仅本地路径）：进入行内编辑 */
  onRename?: (path: string, name: string) => void;
  /** 当前行改名中：渲染行内输入框（不再挂右键菜单） */
  renaming?: { name: string; onCommit: (name: string) => void; onCancel: () => void } | null;
  children: ReactNode;
}) {
  if (renaming) {
    return (
      <div
        data-search-path={path}
        className="flex w-full items-center gap-1.5 px-2 py-1"
      >
        <RenameInput initial={renaming.name} onCommit={renaming.onCommit} onCancel={renaming.onCancel} />
      </div>
    );
  }
  const name = path.split(/[\\/]/).pop() ?? path;
  const t = useT();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-search-path={path}
          onClick={onActivate}
          onDoubleClick={() => (isDir ? onReveal(path, true) : onOpenFile(path))}
          className={cn(
            "w-full text-left hover:bg-muted",
            selected && "bg-selected",
          )}
          title={path}
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => onReveal(path, isDir)}>
          <Crosshair className="mr-2 h-4 w-4" /> {isDir ? t("定位到文件夹") : t("定位到文件")}
        </ContextMenuItem>
        {!isDir && (
          <ContextMenuItem onClick={() => onOpenFile(path)}>
            <ExternalLink className="mr-2 h-4 w-4" /> {t("打开（默认应用）")}
          </ContextMenuItem>
        )}
        {onRename && !isSftpPath(path) && (
          <ContextMenuItem onClick={() => onRename(path, name)}>
            <Pencil className="mr-2 h-4 w-4" /> {t("重命名")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCopyPath(path)}>
          <Clipboard className="mr-2 h-4 w-4" /> {t("复制绝对路径")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopyPath(relPath)}>
          <Clipboard className="mr-2 h-4 w-4" /> {t("复制相对路径")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * 搜索面板（v0.29.0 起以居中模态框展示；此前为右侧停靠窄栏）。
 * 文件名检索：当前层前端过滤 / fd 递归引擎；内容检索：当前层 / 递归。
 * 选项为灯芯按钮（蓝=递归 绿=隐藏 琥珀=大小写 紫=正则/通配），两 tab 同一套语义。
 */
export function SearchPanel({
  entries,
  dir,
  cmd,
  onReveal,
  onOpenFile,
  onCopyPath,
  onRenamed,
  onError,
  onClose,
}: {
  entries: FileEntry[];
  dir: string;
  /** 外部命令（Ctrl+F / Ctrl+Shift+F）：切换 tab 并聚焦输入框 */
  cmd: { tab: "name" | "content"; tick: number } | null;
  /** 在激活窗格中定位：目录进入，文件跳转所在目录并选中 */
  onReveal: (path: string, isDir: boolean) => void;
  /** 用系统关联程序打开文件（按扩展名） */
  onOpenFile: (path: string) => void;
  /** 复制路径文本（绝对 / 相对） */
  onCopyPath: (path: string) => void;
  /** 搜索结果内联重命名完成：刷新正显示该目录的窗格并定位新条目 */
  onRenamed: (oldPath: string, newPath: string) => void;
  /** 重命名失败的错误提示（App 全局 notice） */
  onError: (msg: string) => void;
  /** 关闭搜索模态框（右上角 × / 遮罩点击 / Esc） */
  onClose: () => void;
}) {
  // v0.34.1 弹层栈登记（条件渲染，挂载即打开）
  useModalLayer("searchPanel", 50, true);
  const [mode, setMode] = useState("name");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const contentInputRef = useRef<HTMLInputElement>(null);

  // 搜索结果行内重命名（本地路径）
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  /** rel_path 尾段改名（当前层 results 由窗格 entries 派生，不走这里） */
  const withNewTail = (rel: string, oldName: string, newName: string) =>
    rel.endsWith(oldName) ? rel.slice(0, rel.length - oldName.length) + newName : rel;
  const commitRename = async (oldPath: string, newName: string) => {
    setRenaming(null);
    const trimmed = newName.trim();
    const oldName = oldPath.split(/[\\/]/).pop() ?? "";
    if (!trimmed || trimmed === oldName) return;
    try {
      const newPath = await renameEntry(oldPath, trimmed);
      // 乐观更新递归结果集；当前层结果由窗格 entries 派生，经 onRenamed 刷新窗格后自然更新
      setFdResults((rs) =>
        rs.map((r) =>
          r.path === oldPath ? { ...r, path: newPath, rel_path: withNewTail(r.rel_path, oldName, trimmed) } : r,
        ),
      );
      setCResults((rs) =>
        rs.map((m) =>
          m.path === oldPath ? { ...m, path: newPath, rel_path: withNewTail(m.rel_path, oldName, trimmed) } : m,
        ),
      );
      onRenamed(oldPath, newPath);
    } catch (e) {
      onError(String(e));
    }
  };
  const renamingForRow = (path: string) =>
    renaming?.path === path
      ? {
          name: renaming.name,
          onCommit: (name: string) => void commitRename(path, name),
          onCancel: () => setRenaming(null),
        }
      : null;

  // 外部命令：切换 tab + 聚焦对应输入框
  useEffect(() => {
    if (!cmd) return;
    setMode(cmd.tab);
    if (cmd.tab === "name") {
      requestAnimationFrame(() => nameInputRef.current?.focus());
    } else {
      requestAnimationFrame(() => contentInputRef.current?.focus());
    }
  }, [cmd]);

  // 文件名检索：当前层前端过滤 / fd 递归引擎；灯钮 = 递归(蓝) 隐藏(绿) 大小写(琥珀) 正则⇄通配(紫)
  const [fdEnabled, setFdEnabled] = useState(false);
  const [nameHidden, setNameHidden] = useState(false);
  const [nameCase, setNameCase] = useState(false);
  const [nameMode, setNameMode] = useState<"regex" | "glob">("regex");
  const [fdResults, setFdResults] = useState<FindEntry[]>([]);
  const [fdLoading, setFdLoading] = useState(false);
  const [fdError, setFdError] = useState<string | null>(null);
  const fdTimer = useRef<number | null>(null);
  const fdSeq = useRef(0);

  // 内容搜索状态；灯钮 = 递归(蓝) 隐藏(绿) 大小写(琥珀) 正则(紫)
  const [cQuery, setCQuery] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [cHidden, setCHidden] = useState(false);
  const [cRegex, setCRegex] = useState(false);
  const [cResults, setCResults] = useState<SearchMatch[]>([]);
  const [cLoading, setCLoading] = useState(false);
  const [cError, setCError] = useState<string | null>(null);
  const cTimer = useRef<number | null>(null);
  const cSeq = useRef(0);
  const t = useT();

  // 文件名搜索（当前层，前端过滤）——匹配语义与 fd 灯钮一致：
  // 正则/通配符整名匹配（无效正则回退字面量包含），隐藏灯控制 `.` 开头项
  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    let test: (name: string) => boolean;
    if (nameMode === "glob") {
      const re = globToRegExp(q, nameCase);
      test = (n) => re.test(n);
    } else {
      try {
        const re = new RegExp(q, nameCase ? "" : "i");
        test = (n) => re.test(n);
      } catch {
        const lq = nameCase ? q : q.toLowerCase();
        test = (n) => (nameCase ? n : n.toLowerCase()).includes(lq);
      }
    }
    return entries
      .filter((e) => (nameHidden ? true : !e.name.startsWith(".")))
      .filter((e) => test(e.name))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir))
      .slice(0, 200);
  }, [entries, query, nameHidden, nameCase, nameMode]);

  // fd 快速检索：防抖 250ms，后台线程执行
  useEffect(() => {
    if (fdTimer.current) window.clearTimeout(fdTimer.current);
    const q = query.trim();
    if (!fdEnabled || !q) {
      setFdResults([]);
      setFdLoading(false);
      setFdError(null);
      return;
    }
    setFdLoading(true);
    setFdError(null);
    const seq = ++fdSeq.current;
    fdTimer.current = window.setTimeout(async () => {
      try {
        const res = await findFiles(q, dir, nameHidden, null, nameMode === "glob", nameCase);
        if (seq !== fdSeq.current) return;
        setFdResults(res);
      } catch (e) {
        if (seq !== fdSeq.current) return;
        setFdError(String(e));
        setFdResults([]);
      } finally {
        if (seq === fdSeq.current) setFdLoading(false);
      }
    }, 250);
    return () => {
      if (fdTimer.current) window.clearTimeout(fdTimer.current);
    };
  }, [query, fdEnabled, dir, nameHidden, nameMode, nameCase]);

  // 内容搜索：防抖 250ms，后台线程执行
  useEffect(() => {
    if (cTimer.current) window.clearTimeout(cTimer.current);
    const q = cQuery.trim();
    if (!q) {
      setCResults([]);
      setCLoading(false);
      setCError(null);
      return;
    }
    setCLoading(true);
    setCError(null);
    const seq = ++cSeq.current;
    cTimer.current = window.setTimeout(async () => {
      try {
        const res = await searchContent(q, dir, recursive, caseSensitive, cHidden, cRegex);
        if (seq !== cSeq.current) return;
        setCResults(res);
      } catch (e) {
        if (seq !== cSeq.current) return;
        setCError(String(e));
        setCResults([]);
      } finally {
        if (seq === cSeq.current) setCLoading(false);
      }
    }, 250);
    return () => {
      if (cTimer.current) window.clearTimeout(cTimer.current);
    };
  }, [cQuery, dir, recursive, caseSensitive, cHidden, cRegex]);

  return (
    // v0.29.0 模态框化：原右侧 256px 停靠栏在递归检索时 rel_path 截断严重，
    // 改为居中浮层（640×70vh），点遮罩或 Esc 关闭；内容结构不变。
    // v0.34.1 弹层栈登记：更高层弹层打开时 Esc 让位
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
    <div
      className="flex h-[70vh] max-h-[620px] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      onKeyDown={(e) => {
        // Esc 关闭搜索框；行内重命名的 Esc 已被 RenameInput stopPropagation 挡住。
        // radix 右键/下拉菜单开着时不能关：radix 的 document 级监听晚于 React 根容器，
        // 这里看到 defaultPrevented 恒为 false，只能按「浮层是否在 DOM」判断。
        // IME 组合中的 Esc 是取消候选词，不关面板。
        if (e.key !== "Escape" || e.defaultPrevented || renaming) return;
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (!isTopModalLayer("searchPanel")) return;
        if (
          document.querySelector(
            '[data-slot="context-menu-content"],[data-slot="dropdown-menu-content"],[data-radix-popper-content-wrapper]',
          )
        )
          return;
        onClose();
      }}
    >
      {/* 标题 + 关闭（冻结的搜索目标目录随面板展示） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <FileSearch className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">{t("搜索")}</span>
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70"
          title={dir}
        >
          {dir}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={t("关闭搜索面板")}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Tabs value={mode} onValueChange={setMode} className="flex min-h-0 flex-1 flex-col">
        <div className="p-2 pb-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="name" className="text-xs">{t("文件名")}</TabsTrigger>
            <TabsTrigger value="content" className="text-xs">{t("内容")}</TabsTrigger>
          </TabsList>
        </div>

        <div className="space-y-1.5 p-2">
          {mode === "name" ? (
            <>
              <Input
                ref={nameInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  fdEnabled
                    ? nameMode === "glob"
                      ? t("检索文件（fd 通配符，如 *.rs）…")
                      : t("检索文件（fd 正则）…")
                    : t("搜索当前层文件名…")
                }
                className="h-7 text-xs"
                autoFocus
              />
              <div className="flex items-center gap-1.5">
                <ToggleChip
                  on={fdEnabled}
                  color="blue"
                  label={t("递归")}
                  title={t("递归搜索子目录（fd 引擎，尊重 .gitignore）")}
                  onClick={() => setFdEnabled((v) => !v)}
                />
                <ToggleChip
                  on={nameHidden}
                  color="green"
                  label={t("隐藏")}
                  title={t("包含隐藏文件 / 目录（. 开头）")}
                  onClick={() => setNameHidden((v) => !v)}
                />
                <ToggleChip
                  on={nameCase}
                  color="amber"
                  label="Aa"
                  title={t("区分大小写")}
                  onClick={() => setNameCase((v) => !v)}
                />
                <button
                  type="button"
                  onClick={() => setNameMode((m) => (m === "regex" ? "glob" : "regex"))}
                  title={
                    nameMode === "regex"
                      ? t("当前：正则匹配，点击切换为通配符（如 *.rs）")
                      : t("当前：通配符匹配，点击切换为正则")
                  }
                  aria-label={t("匹配模式：{mode}", { mode: nameMode === "regex" ? t("正则") : t("通配符") })}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-purple-500/50 bg-purple-500/10 px-2 text-[11px] font-medium text-purple-600 transition-colors hover:bg-purple-500/20 dark:text-purple-400"
                >
                  {nameMode === "regex" ? t(".* 正则") : t("✱ 通配")}
                </button>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {[
                  fdEnabled ? t("fd 递归中") : t("当前层匹配"),
                  nameMode === "glob" ? t("通配符") : t("正则"),
                  nameHidden ? t("含隐藏") : t("跳过隐藏"),
                  nameCase ? t("区分大小写") : t("不区分大小写"),
                  fdEnabled ? t("尊重 .gitignore") : t("共 {n} 项", { n: entries.length }),
                ].join(" · ")}
              </p>
            </>
          ) : (
            <>
              <Input
                ref={contentInputRef}
                value={cQuery}
                onChange={(e) => setCQuery(e.target.value)}
                placeholder={cRegex ? t("搜索文件内容（正则）…") : t("搜索文件内容…")}
                className="h-7 text-xs"
                autoFocus
              />
              <div className="flex items-center gap-1.5">
                <ToggleChip
                  on={recursive}
                  color="blue"
                  label={t("递归")}
                  title={t("递归搜索子目录内容")}
                  onClick={() => setRecursive((v) => !v)}
                />
                <ToggleChip
                  on={cHidden}
                  color="green"
                  label={t("隐藏")}
                  title={t("包含隐藏文件 / 目录（. 开头）")}
                  onClick={() => setCHidden((v) => !v)}
                />
                <ToggleChip
                  on={caseSensitive}
                  color="amber"
                  label="Aa"
                  title={t("区分大小写")}
                  onClick={() => setCaseSensitive((v) => !v)}
                />
                <ToggleChip
                  on={cRegex}
                  color="purple"
                  label={t(".* 正则")}
                  title={t("查询词按正则解析（默认字面量匹配）")}
                  onClick={() => setCRegex((v) => !v)}
                />
              </div>
            </>
          )}
        </div>

        <TabsContent value="name" className="mt-0 min-h-0 flex-1">
          <ScrollArea className="h-full">
            {fdEnabled ? (
              fdLoading ? (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-xs">{t("检索中…（fd 引擎）")}</span>
                </div>
              ) : fdError ? (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-destructive">
                  <SearchX className="h-6 w-6" />
                  <span className="break-all">{fdError}</span>
                </div>
              ) : fdResults.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                  {query.trim() ? (
                    <SearchX className="h-6 w-6" />
                  ) : (
                    <FolderSearch className="h-6 w-6" />
                  )}
                  <span className="text-xs">
                    {query.trim() ? t("无匹配结果") : t("输入关键词递归检索")}
                  </span>
                </div>
              ) : (
                <div className="pb-6">
                  {fdResults.map((e) => {
                    const fe: FileEntry = {
                      name: e.rel_path.split(/[\\/]/).pop() ?? e.rel_path,
                      path: e.path,
                      is_dir: e.is_dir,
                      is_symlink: false,
                      size: 0,
                      modified: null,
                      created: null,
                      permissions: "",
                      extension: extensionOf(e.path),
                    };
                    return (
                      <ResultRow
                        key={e.path}
                        path={e.path}
                        relPath={e.rel_path}
                        isDir={e.is_dir}
                        selected={selected === e.path}
                        onActivate={() => setSelected(e.path)}
                        onReveal={onReveal}
                        onOpenFile={onOpenFile}
                        onCopyPath={onCopyPath}
                        onRename={(p, name) => setRenaming({ path: p, name })}
                        renaming={renamingForRow(e.path)}
                      >
                        <span className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs">
                          <FileIcon entry={fe} size={14} className="shrink-0" />
                          <span className="truncate">{e.rel_path}</span>
                        </span>
                      </ResultRow>
                    );
                  })}
                  {fdResults.length >= 500 && (
                    <div className="flex items-center justify-center gap-1 px-2 py-2 text-[11px] text-muted-foreground">
                      <Zap className="h-3 w-3" /> {t("已显示前 500 条")}
                    </div>
                  )}
                </div>
              )
            ) : results.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                {query ? <SearchX className="h-6 w-6" /> : <FolderSearch className="h-6 w-6" />}
                <span className="text-xs">{query ? t("无匹配结果") : t("输入关键词开始搜索")}</span>
              </div>
            ) : (
              <div className="pb-6">
                {results.map((e) => (
                  <ResultRow
                    key={e.path}
                    path={e.path}
                    relPath={e.name}
                    isDir={e.is_dir}
                    selected={selected === e.path}
                    onActivate={() => setSelected(e.path)}
                    onReveal={onReveal}
                    onOpenFile={onOpenFile}
                    onCopyPath={onCopyPath}
                    onRename={(p, name) => setRenaming({ path: p, name })}
                    renaming={renamingForRow(e.path)}
                  >
                    <span className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs">
                      <FileIcon entry={e} size={14} className="shrink-0" />
                      <span className="truncate">{e.name}</span>
                    </span>
                  </ResultRow>
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="content" className="mt-0 min-h-0 flex-1">
          <ScrollArea className="h-full">
            {cLoading ? (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-xs">
                  {t("搜索中…")}{recursive ? t("（递归）") : t("（当前层）")}
                </span>
              </div>
            ) : cError ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-destructive">
                <SearchX className="h-6 w-6" />
                <span className="break-all">{cError}</span>
              </div>
            ) : cResults.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground">
                {cQuery.trim() ? (
                  <>
                    <SearchX className="h-6 w-6" />
                    <span className="text-xs">{t("无匹配结果")}</span>
                  </>
                ) : (
                  <>
                    <FileSearch className="h-6 w-6" />
                    <span className="text-xs">
                      {t("输入关键词搜索文件内容")}
                      <br />
                      {t("默认仅当前层，点亮「递归」深入子目录")}
                    </span>
                  </>
                )}
              </div>
            ) : (
              <div className="pb-6">
                {cResults.map((m) => {
                  const fe: FileEntry = {
                    name: m.rel_path.split(/[\\/]/).pop() ?? m.rel_path,
                    path: m.path,
                    is_dir: false,
                    is_symlink: false,
                    size: 0,
                    modified: null,
                    created: null,
                    permissions: "",
                    extension: extensionOf(m.path),
                  };
                  return (
                    <ResultRow
                      key={`${m.path}:${m.line_number}`}
                      path={m.path}
                      relPath={m.rel_path}
                      isDir={false}
                      selected={selected === m.path}
                      onActivate={() => setSelected(m.path)}
                      onReveal={onReveal}
                      onOpenFile={onOpenFile}
                      onCopyPath={onCopyPath}
                      onRename={(p, name) => setRenaming({ path: p, name })}
                      renaming={renamingForRow(m.path)}
                    >
                      <span className="block w-full px-2.5 py-1.5">
                        <span className="flex items-center gap-1.5 text-xs">
                          <FileIcon entry={fe} size={13} className="shrink-0" />
                          <span className="truncate font-medium">{m.rel_path}</span>
                          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            L{m.line_number}
                          </span>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                          <Highlight text={m.line} query={cQuery.trim()} />
                        </span>
                      </span>
                    </ResultRow>
                  );
                })}
                {cResults.length >= 300 && (
                  <div className="flex items-center justify-center gap-1 px-2 py-2 text-[11px] text-muted-foreground">
                    <Zap className="h-3 w-3" /> {t("已显示前 300 条，请缩小关键词范围")}
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
    </div>
  );
}
