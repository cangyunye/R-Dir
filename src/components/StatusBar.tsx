import { AlertCircle, Crosshair, FolderOpen, Layers, Loader2, X , Share2 } from "lucide-react";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/LanguageProvider";
import type { TransferProgress } from "@/lib/types";
import { SyncDiffStatusBar, type SyncDiffSummary } from "@/components/SyncDiffPanel";

// { id, label } 数组声明（label: 字面量可被 LITERAL_PROP_FILES 提取），还原查找表；
// label 经 t() 翻译后拼进各阶段文案
const PHASE_LABEL = Object.fromEntries(
  (
    [
      { id: "copy", label: "复制" },
      { id: "move", label: "移动" },
      { id: "upload", label: "上传" },
      { id: "download", label: "下载" },
      { id: "compress", label: "压缩" },
      { id: "extract", label: "解压" },
    ] as { id: TransferProgress["phase"]; label: string }[]
  ).map((s) => [s.id, s.label]),
);

/** 部分后端任务以固定文案作 label（复制/移动/压缩不逐文件改名）；
 *  此时不再拼接阶段名，避免渲染成「复制中：复制中…」（v0.18.1） */
const GENERIC_LABELS = new Set(["下载中…", "上传中…", "复制中…", "移动中…", "压缩中…", "解压中…"]);

/** 可停止的传输阶段：HTTP/SFTP 下载 + 本地复制/移动 + SFTP 上传 + 解压（v0.23 递归传输按任务 id 取消） */
const CANCELLABLE = new Set<TransferProgress["phase"]>(["download", "copy", "move", "upload", "extract"]);

export function StatusBar({
  path,
  total,
  selected,
  selectedSize,
  showHidden,
  error,
  notice,
  transfer,
  onCancelTransfer,
  onSharePanel,
  syncDiff,
  compareBase,
  baseHint,
}: {
  path: string;
  total: number;
  selected: string[];
  selectedSize: number;
  showHidden: boolean;
  error: string | null;
  notice: string | null;
  transfer?: TransferProgress | null;
  /** 停止传输（HTTP 下载 / 本地复制 / 移动） */
  onCancelTransfer?: (id: string, phase: TransferProgress["phase"]) => void;
  /** v0.7：打开分享管理面板 */
  onSharePanel?: () => void;
  /** v0.18.2 同步比对摘要段（无链接时不传）：点击打开结果模态 */
  syncDiff?: {
    summary: SyncDiffSummary;
    onOpen: () => void;
  };
  /** v0.19 文本比较基准芯片（未设置时不传） */
  compareBase?: {
    name: string;
    path: string;
    onClear: () => void;
  };
  /** v0.19 设/清基准的瞬时提示（右下角，App 侧定时清除） */
  baseHint?: string | null;
}) {
  const pct =
    transfer && transfer.fileTotal > 0
      ? Math.min(100, Math.round((transfer.fileDone / transfer.fileTotal) * 100))
      : 0;
  const t = useT();
  // 阶段名经翻译后参与拼接（GENERIC_LABELS / 「已取消」「传输失败」是后端帧 label 契约，按原文比较）
  const phaseLabel = transfer ? t(PHASE_LABEL[transfer.phase]) : "";
  // 失败收尾帧会在状态栏停留 1.5 秒，此时若已有具体错误文案，直接让位给它——
  // 否则「复制失败」四个字盖住了真正的原因
  const showTransfer = !!transfer && !(transfer.done && transfer.label === "传输失败" && notice);
  return (
    <div data-statusbar="" className="relative shrink-0">
      {transfer && !transfer.done && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="flex h-6 items-center justify-between gap-4 border-t bg-sidebar px-3 text-[11px] text-muted-foreground select-none">
        <div className="flex min-w-0 items-center gap-2">
          {showTransfer && transfer ? (
            <span
              className={cn(
                "flex items-center gap-1 truncate",
                transfer.done && transfer.label === "传输失败" && "text-destructive",
              )}
            >
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              {transfer.done
                ? transfer.label === "已取消"
                  ? t("已取消")
                  : transfer.label === "传输失败"
                    ? t("{phase}失败", { phase: phaseLabel })
                    : t("{phase}完成", { phase: phaseLabel })
                : GENERIC_LABELS.has(transfer.label)
                  ? t("{phase}中…", { phase: phaseLabel })
                  : t("{phase}中：{label}", { phase: phaseLabel, label: transfer.label })}
              {transfer.totalFiles > 1 && !transfer.done && (
                <span className="tabular-nums">
                  {transfer.doneFiles + 1}/{transfer.totalFiles}
                </span>
              )}
              {!transfer.done && pct > 0 && (
                <span className="tabular-nums">{pct}%</span>
              )}
            </span>
          ) : notice ? (
            <span className="flex items-center gap-1 truncate text-amber-600">
              <AlertCircle className="h-3 w-3 shrink-0" /> {notice}
            </span>
          ) : error ? (
            <span className="flex items-center gap-1 truncate text-destructive">
              <AlertCircle className="h-3 w-3 shrink-0" /> {error}
            </span>
          ) : (
            <>
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate" title={path}>{path}</span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {baseHint && (
            <span className="max-w-52 truncate text-primary" title={baseHint}>
              {baseHint}
            </span>
          )}
          {compareBase && (
            <span
              className="flex items-center gap-1 rounded border border-primary/40 px-1.5 py-0.5 text-primary"
              title={t("文本比较基准：{path}", { path: compareBase.path })}
            >
              <Crosshair className="h-3 w-3 shrink-0" />
              <span className="max-w-32 truncate">{compareBase.name}</span>
              <button
                onClick={compareBase.onClear}
                title={t("清除比较基准")}
                className="shrink-0 hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {syncDiff && <SyncDiffStatusBar summary={syncDiff.summary} onOpen={syncDiff.onOpen} />}
          {onSharePanel && (
            <button
              onClick={onSharePanel}
              title={t("分享管理")}
              className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
            >
              <Share2 className="h-3 w-3" /> {t("分享")}
            </button>
          )}
          {transfer && !transfer.done && transfer.id && onCancelTransfer && CANCELLABLE.has(transfer.phase) && (
            <button
              onClick={() => onCancelTransfer(transfer.id!, transfer.phase)}
              title={t("停止{phase}", { phase: phaseLabel })}
              className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
            >
              <X className="h-3 w-3" /> {t("停止")}
            </button>
          )}
          <span>
            {t("{n} 项", { n: total })}
            {showHidden ? t("（含隐藏）") : ""}
          </span>
          {selected.length > 0 && (
            <span className="flex items-center gap-1">
              <Layers className="h-3 w-3" />
              {t("已选 {n} 项 · {size}", {
                n: selected.length,
                size: formatSize(selectedSize),
              })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
