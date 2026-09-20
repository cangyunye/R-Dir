import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaseSensitive,
  FileSearch,
  FolderSearch,
  Loader2,
  SearchX,
  X,
  Zap,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileIcon } from "@/components/FileIcon";
import { findFiles, searchContent } from "@/lib/api";
import type { FileEntry, FindEntry, SearchMatch } from "@/lib/types";
import { cn } from "@/lib/utils";

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx + 1).toLowerCase();
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

export function SearchPanel({
  entries,
  dir,
  cmd,
  onOpen,
  onOpenContent,
  onClose,
}: {
  entries: FileEntry[];
  dir: string;
  /** 外部命令（Ctrl+F / Ctrl+Shift+F）：切换 tab 并聚焦输入框 */
  cmd: { tab: "name" | "content"; tick: number } | null;
  onOpen: (entry: FileEntry) => void;
  onOpenContent: (dir: string, filePath: string) => void;
  /** 关闭搜索面板（右上角 ×） */
  onClose: () => void;
}) {
  const [mode, setMode] = useState("name");
  const [query, setQuery] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const contentInputRef = useRef<HTMLInputElement>(null);

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

  // 文件名检索：当前层前端过滤 / fd 递归引擎
  const [fdEnabled, setFdEnabled] = useState(false);
  const [fdResults, setFdResults] = useState<FindEntry[]>([]);
  const [fdLoading, setFdLoading] = useState(false);
  const [fdError, setFdError] = useState<string | null>(null);
  const fdTimer = useRef<number | null>(null);
  const fdSeq = useRef(0);

  // 内容搜索状态
  const [cQuery, setCQuery] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [cResults, setCResults] = useState<SearchMatch[]>([]);
  const [cLoading, setCLoading] = useState(false);
  const [cError, setCError] = useState<string | null>(null);
  const cTimer = useRef<number | null>(null);
  const cSeq = useRef(0);

  // 文件名搜索（当前层，前端过滤）
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return entries
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir))
      .slice(0, 200);
  }, [entries, query]);

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
        const res = await findFiles(q, dir, false, null);
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
  }, [query, fdEnabled, dir]);

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
        const res = await searchContent(q, dir, recursive, caseSensitive);
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
  }, [cQuery, dir, recursive, caseSensitive]);

  return (
    <div className="flex w-64 shrink-0 flex-col border-l bg-muted/15">
      {/* 标题 + 关闭（冻结的搜索目标目录随面板展示） */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">搜索</span>
        <span
          className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70"
          title={dir}
        >
          {dir}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关闭搜索面板"
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Tabs value={mode} onValueChange={setMode} className="flex min-h-0 flex-1 flex-col">
        <div className="p-2 pb-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="name" className="text-xs">文件名</TabsTrigger>
            <TabsTrigger value="content" className="text-xs">内容</TabsTrigger>
          </TabsList>
        </div>

        <div className="space-y-1.5 p-2">
          {mode === "name" ? (
            <>
              <Input
                ref={nameInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={fdEnabled ? "检索文件（fd 正则）…" : "搜索当前层文件名…"}
                className="h-7 text-xs"
                autoFocus
              />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    checked={fdEnabled}
                    onChange={(e) => setFdEnabled(e.target.checked)}
                    className="h-3 w-3 accent-primary"
                  />
                  递归检索（fd 引擎）
                </label>
              </div>
              {fdEnabled ? (
                <p className="text-[11px] text-muted-foreground">
                  正则 + 智能大小写，递归搜索当前目录（尊重 .gitignore）
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  默认仅当前目录，共 {entries.length} 项
                </p>
              )}
            </>
          ) : (
            <>
              <Input
                ref={contentInputRef}
                value={cQuery}
                onChange={(e) => setCQuery(e.target.value)}
                placeholder="搜索文件内容…"
                className="h-7 text-xs"
                autoFocus
              />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    checked={recursive}
                    onChange={(e) => setRecursive(e.target.checked)}
                    className="h-3 w-3 accent-primary"
                  />
                  递归子目录
                </label>
                <button
                  type="button"
                  onClick={() => setCaseSensitive((v) => !v)}
                  className={cn(
                    "flex items-center gap-0.5 rounded border px-1 py-0.5",
                    caseSensitive
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                  title="区分大小写"
                >
                  <CaseSensitive className="h-3 w-3" /> Aa
                </button>
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
                  <span className="text-xs">检索中…（fd 引擎）</span>
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
                    {query.trim() ? "无匹配结果" : "输入关键词递归检索"}
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
                      <button
                        key={e.path}
                        onClick={() =>
                          e.is_dir ? onOpen(fe) : onOpenContent(dir, e.path)
                        }
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent/60"
                        title={e.path}
                      >
                        <FileIcon entry={fe} size={14} className="shrink-0" />
                        <span className="truncate">{e.rel_path}</span>
                      </button>
                    );
                  })}
                  {fdResults.length >= 500 && (
                    <div className="flex items-center justify-center gap-1 px-2 py-2 text-[11px] text-muted-foreground">
                      <Zap className="h-3 w-3" /> 已显示前 500 条
                    </div>
                  )}
                </div>
              )
            ) : results.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                {query ? <SearchX className="h-6 w-6" /> : <FolderSearch className="h-6 w-6" />}
                <span className="text-xs">{query ? "无匹配结果" : "输入关键词开始搜索"}</span>
              </div>
            ) : (
              <div className="pb-6">
                {results.map((e) => (
                  <button
                    key={e.path}
                    onClick={() => onOpen(e)}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent/60"
                    title={e.path}
                  >
                    <FileIcon entry={e} size={14} className="shrink-0" />
                    <span className="truncate">{e.name}</span>
                  </button>
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
                  搜索中…{recursive ? "（递归）" : "（当前层）"}
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
                    <span className="text-xs">无匹配结果</span>
                  </>
                ) : (
                  <>
                    <FileSearch className="h-6 w-6" />
                    <span className="text-xs">
                      输入关键词搜索文件内容
                      <br />
                      默认仅当前层，可勾选递归
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
                    <button
                      key={`${m.path}:${m.line_number}`}
                      onClick={() => onOpenContent(dir, m.path)}
                      className="block w-full px-2.5 py-1.5 text-left hover:bg-accent/60"
                      title={m.path}
                    >
                      <div className="flex items-center gap-1.5 text-xs">
                        <FileIcon entry={fe} size={13} className="shrink-0" />
                        <span className="truncate font-medium">{m.rel_path}</span>
                        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          L{m.line_number}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                        <Highlight text={m.line} query={cQuery.trim()} />
                      </div>
                    </button>
                  );
                })}
                {cResults.length >= 300 && (
                  <div className="flex items-center justify-center gap-1 px-2 py-2 text-[11px] text-muted-foreground">
                    <Zap className="h-3 w-3" /> 已显示前 300 条，请缩小关键词范围
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
