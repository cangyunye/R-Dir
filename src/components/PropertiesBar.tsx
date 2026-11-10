import { memo } from "react";
import { Info } from "lucide-react";
import type { FileEntry } from "@/lib/types";
import { formatSize, formatTime } from "@/lib/format";
import { fileKindClass } from "@/components/FileIcon";
import { useT } from "@/lib/LanguageProvider";
import { cn } from "@/lib/utils";

function Row({
  label,
  value,
  className,
  valueClassName,
  title,
}: {
  label: string;
  value: string;
  className?: string;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("text-foreground", valueClassName)} title={title}>
        {value}
      </span>
    </span>
  );
}

/** 底部属性栏：选中单个文件时显示详细属性。
 *  memo：props 是窗格状态的原引用，App 因传输进度等无关状态重渲染时跳过
 *  （否则 selection.map(entries.find) 的 O(m·n) 每次渲染都要重算）。 */
export const PropertiesBar = memo(function PropertiesBar({
  entries,
  selection,
}: {
  entries: FileEntry[];
  selection: string[];
}) {
  const selectedEntries = selection
    .map((p) => entries.find((e) => e.path === p))
    .filter((e): e is FileEntry => Boolean(e));
  const t = useT();

  return (
    <div className="flex h-8 shrink-0 items-center gap-4 overflow-x-auto border-t bg-sidebar px-3 text-xs select-none [scrollbar-width:none]">
      {selectedEntries.length === 1 ? (
        (() => {
          const e = selectedEntries[0];
          const kind = e.is_dir
            ? t("目录")
            : e.extension
              ? t("{ext} 文件", { ext: e.extension.toUpperCase() })
              : t("文件");
          return (
            <>
              {/* v0.44.0 名称至多占属性栏 40% 并截断（悬停看全名）：长文件名不再把
                  类型/大小等后续字段挤出分屏窄窗格 */}
              <Row
                label={t("名称")}
                value={e.name}
                className="min-w-0 max-w-[40%]"
                valueClassName="truncate"
                title={e.name}
              />
              <Row label={t("类型")} value={kind} />
              <Row
                label={t("大小")}
                value={e.is_dir ? "—" : formatSize(e.size)}
              />
              <Row label={t("修改")} value={formatTime(e.modified)} />
              <Row label={t("创建")} value={formatTime(e.created)} />
              <Row label={t("权限")} value={e.permissions} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-muted-foreground">{t("路径")}</span>
                <span className="truncate font-mono text-[11px] text-foreground" title={e.path}>
                  {e.path}
                </span>
              </span>
            </>
          );
        })()
      ) : selectedEntries.length > 1 ? (
        <span className="text-muted-foreground">
          {t("已选 {n} 项，共 {size}", {
            n: selectedEntries.length,
            size: formatSize(selectedEntries.reduce((s, e) => s + e.size, 0)),
          })}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          {t("选中文件后在此显示详细属性")}
        </span>
      )}
      {selectedEntries.length === 1 && selectedEntries[0].is_dir && (
        <span className={`ml-auto shrink-0 text-[11px] ${fileKindClass(selectedEntries[0])}`}>
          ● {t("目录")}
        </span>
      )}
    </div>
  );
});
