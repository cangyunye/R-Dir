/**
 * 文档预览卡（v0.28.0）：PDF/Office 首页缩略图（thumb_get，macOS QuickLook 管线）
 * + 元信息。不做正文渲染（pdf.js 留后续版本）；缩略图失败回退大类型图标。
 */
import { FileIcon } from "@/components/FileIcon";
import { ThumbImage } from "@/components/ThumbImage";
import { formatSize, formatTime } from "@/lib/format";
import type { FileEntry } from "@/lib/types";

export function DocCard({ entry, className }: { entry: FileEntry; className?: string }) {
  return (
    <div className={`flex h-full min-h-0 flex-col items-center gap-2 p-3 ${className ?? ""}`} data-testid="preview-doc">
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <ThumbImage
          path={entry.path}
          mtime={entry.modified}
          size={512}
          className="h-full w-full"
          fallback={<FileIcon entry={entry} size={72} />}
        />
      </div>
      <div className="shrink-0 text-center text-[10px] leading-relaxed text-muted-foreground">
        {formatSize(entry.size)} · {formatTime(entry.modified)} · 首页缩略图（「外部打开」查看全文）
      </div>
    </div>
  );
}
