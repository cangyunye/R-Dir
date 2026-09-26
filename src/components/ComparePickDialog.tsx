import { useMemo, useState } from "react";
import { FolderTree, Search, X } from "lucide-react";
import { statPath } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ComparePickFile {
  name: string;
  path: string;
}

export interface ComparePickPane {
  key: string;
  title: string;
  path: string;
  files: ComparePickFile[];
}

/**
 * 「与另一文件比较…」选择器（v0.19）：
 * 左列 = 当前所有已连接窗格（与右上角窗格列表同源），右列 = 该窗格当前目录的文件
 * （直接读窗格内存中的列表，零 IO）。底部支持直接粘贴任意路径。
 */
export function ComparePickDialog({
  baseName,
  panes,
  onPick,
  onClose,
}: {
  baseName: string;
  panes: ComparePickPane[];
  onPick: (file: ComparePickFile) => void;
  onClose: () => void;
}) {
  const withFiles = useMemo(() => panes.filter((p) => p.files.length > 0), [panes]);
  const [selectedKey, setSelectedKey] = useState<string | null>(withFiles[0]?.key ?? null);
  const [filter, setFilter] = useState("");
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = withFiles.find((p) => p.key === selectedKey) ?? null;
  const files = useMemo(() => {
    if (!selected) return [];
    const f = filter.trim().toLowerCase();
    return f ? selected.files.filter((x) => x.name.toLowerCase().includes(f)) : selected.files;
  }, [selected, filter]);

  const pickManual = async () => {
    const p = manual.trim();
    if (!p) return;
    setManualError(null);
    setBusy(true);
    try {
      // 远程路径交给后端校验；本地路径先探测存在性
      if (!p.startsWith("sftp://") && !p.startsWith("http://") && !p.startsWith("https://")) {
        const kind = await statPath(p);
        if (kind === "dir") {
          setManualError("路径是目录，请选择文件");
          return;
        }
        if (kind === "missing") {
          setManualError("路径不存在");
          return;
        }
      }
      const name = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
      onPick({ name, path: p });
    } catch (e) {
      setManualError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        style={{
          width: "calc(min(720px, 95vw) / var(--rdir-zoom, 1))",
          height: "calc(60vh / var(--rdir-zoom, 1))",
        }}
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-semibold">
              与「{baseName}」比较 — 选择另一侧文件
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 窗格列表 */}
          <div className="w-56 shrink-0 overflow-y-auto border-r p-1">
            {withFiles.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                没有可用窗格（各窗格当前目录都没有文件）
              </div>
            ) : (
              withFiles.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setSelectedKey(p.key)}
                  className={cn(
                    "block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground",
                    p.key === selectedKey && "bg-accent text-accent-foreground",
                  )}
                  title={p.path}
                >
                  <div className="truncate text-xs font-medium">{p.title}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{p.path}</div>
                </button>
              ))
            )}
          </div>

          {/* 文件列表 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-2 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="按文件名过滤…"
                className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => onPick(f)}
                  title={f.path}
                  className="block w-full truncate rounded-sm px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                >
                  {f.name}
                </button>
              ))}
              {files.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  {selected ? "无匹配文件（仅列出该窗格当前目录的文件）" : "左侧选择一个窗格"}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 手动路径 */}
        <div className="border-t px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              value={manual}
              onChange={(e) => {
                setManual(e.target.value);
                setManualError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void pickManual();
              }}
              placeholder="或直接输入文件路径（支持本地 / sftp:// / http(s)://）…"
              className="h-7 min-w-0 flex-1 rounded border bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
              spellCheck={false}
            />
            <Button size="sm" className="h-7" disabled={!manual.trim() || busy} onClick={() => void pickManual()}>
              比较
            </Button>
          </div>
          {manualError && <div className="mt-1 text-[11px] text-destructive">{manualError}</div>}
        </div>
      </div>
    </div>
  );
}
