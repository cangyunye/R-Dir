/**
 * 预览内容分发（v0.28.0）：FileEntry → 原图 / 文本 / 首页缩略图卡 / 信息卡。
 * 预览栏与图文浏览模式共用；entry 为 null 显示占位提示。
 * v0.42 未知类型试探（text-probe）：本地未知/乱写/无扩展名由 TextProbe 做内容探测
 * （嗅探优先：图片路由原图查看器，文本走 TextView，二进制回信息卡）。
 */
import { Image as ImageIcon } from "lucide-react";
import { DocCard } from "./DocCard";
import { InfoCard, OversizedImage } from "./InfoCard";
import { TextProbe } from "./TextProbe";
import {
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  previewKindOf,
} from "@/lib/preview";
import type { FileEntry } from "@/lib/types";
import { useT } from "@/lib/LanguageProvider";
import { ImageView } from "./ImageView";
import { TextView } from "./TextView";

function Placeholder() {
  const t = useT();
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground"
      data-testid="preview-placeholder"
    >
      <ImageIcon size={40} className="opacity-40" />
      <div className="text-xs">{t("选择一个文件以预览")}</div>
      <div className="text-[10px]">{t("方向键或点选切换，Esc 取消选择")}</div>
    </div>
  );
}

export function PreviewBody({
  entry,
  onOpenExternal,
}: {
  entry: FileEntry | null;
  /** 远程文件信息卡上的「下载并打开 / 浏览器打开」按钮（与双击同一条链路） */
  onOpenExternal?: (path: string) => void;
}) {
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
          fallback={<InfoCard entry={entry} onOpenExternal={onOpenExternal} />}
        />
      );
    case "text":
      return entry.size > PREVIEW_TEXT_MAX_BYTES ? (
        <InfoCard entry={entry} onOpenExternal={onOpenExternal} />
      ) : (
        <TextView path={entry.path} className="h-full w-full" />
      );
    case "text-probe":
      // v0.42 未知类型：内容探测路由（图片/文本/二进制/超大），门槛判定在 TextProbe 内
      return <TextProbe entry={entry} onOpenExternal={onOpenExternal} />;
    case "doc":
      return <DocCard entry={entry} />;
    default:
      return <InfoCard entry={entry} onOpenExternal={onOpenExternal} />;
  }
}
