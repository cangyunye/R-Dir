/**
 * 预览内容分发（v0.28.0）：FileEntry → 原图 / 文本 / 首页缩略图卡 / 信息卡。
 * 预览栏与图文浏览模式共用；entry 为 null 显示占位提示。
 */
import { Image as ImageIcon } from "lucide-react";
import { FileIcon } from "@/components/FileIcon";
import { ThumbImage } from "@/components/ThumbImage";
import { extLabel, formatSize, formatTime } from "@/lib/format";
import {
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  isRemotePath,
  previewKindOf,
} from "@/lib/preview";
import type { FileEntry } from "@/lib/types";
import { DocCard } from "./DocCard";
import { ImageView } from "./ImageView";
import { TextView } from "./TextView";

function Placeholder() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground"
      data-testid="preview-placeholder"
    >
      <ImageIcon size={40} className="opacity-40" />
      <div className="text-xs">选择一个文件以预览</div>
      <div className="text-[10px]">方向键或点选切换，Esc 取消选择</div>
    </div>
  );
}

/** 信息卡：不预览内容（目录 / 远程 / 不支持的类型） */
function InfoCard({ entry }: { entry: FileEntry }) {
  const remote = isRemotePath(entry.path);
  const hint = entry.is_dir
    ? "文件夹（Enter 进入）"
    : remote
      ? "远程文件暂不支持内容预览"
      : "此类型暂不支持预览";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" data-testid="preview-info">
      <FileIcon entry={entry} size={56} />
      <div className="max-w-full truncate px-2 text-xs font-medium text-foreground" title={entry.name}>
        {entry.name}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {extLabel(entry)} · {formatSize(entry.size)} · {formatTime(entry.modified)}
      </div>
      <div className="text-[10px] text-muted-foreground/80">{hint}</div>
    </div>
  );
}

/** 超大图回退：首页缩略图放大显示 */
function OversizedImage({ entry }: { entry: FileEntry }) {
  return (
    <div className="flex h-full flex-col items-center gap-2 p-3">
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <ThumbImage
          path={entry.path}
          mtime={entry.modified}
          size={512}
          className="h-full w-full"
          fallback={<FileIcon entry={entry} size={72} />}
        />
      </div>
      <div className="shrink-0 text-center text-[10px] text-muted-foreground">
        文件超过 30MB，显示缩略图（「外部打开」查看原图）
      </div>
    </div>
  );
}

export function PreviewBody({ entry }: { entry: FileEntry | null }) {
  if (!entry) return <Placeholder />;
  const kind = previewKindOf(entry);
  switch (kind) {
    case "image":
      return entry.size > PREVIEW_IMAGE_MAX_BYTES ? (
        <OversizedImage entry={entry} />
      ) : (
        <ImageView
          path={entry.path}
          mtime={entry.modified}
          className="h-full w-full"
          fallback={<InfoCard entry={entry} />}
        />
      );
    case "text":
      return entry.size > PREVIEW_TEXT_MAX_BYTES ? (
        <InfoCard entry={entry} />
      ) : (
        <TextView path={entry.path} className="h-full w-full" />
      );
    case "doc":
      return <DocCard entry={entry} />;
    default:
      return <InfoCard entry={entry} />;
  }
}
