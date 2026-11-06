/**
 * v0.42 未知类型探测路由（text-probe 预览类）：probe_local_file 一次 IPC 完成
 * 「图片 magic 嗅探 + 文本读取」——嗅探优先，二进制文件最坏 IO 从整读 8MB 降到 16B。
 * text → TextView（试探横幅 + 纯文本，超 2MB 回信息卡）；image → 原图查看器
 * （复用 30MB 门槛与超限缩略图回退；解码失败回疑似二进制信息卡）；
 * binary / oversized → 信息卡；探测失败 → 通用失败占位。
 */
import { useEffect, useState } from "react";
import { InfoCard, OversizedImage } from "./InfoCard";
import { ImageView } from "./ImageView";
import { TextView } from "./TextView";
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_TEXT_MAX_BYTES } from "@/lib/preview";
import { probeFile } from "@/lib/probe";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/LanguageProvider";
import type { FileEntry, ProbeResult } from "@/lib/types";

export function TextProbe({
  entry,
  onOpenExternal,
}: {
  entry: FileEntry;
  onOpenExternal?: (path: string) => void;
}) {
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failed, setFailed] = useState(false);
  const t = useT();

  useEffect(() => {
    setResult(null);
    setFailed(false);
    let cancelled = false;
    probeFile(entry)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // 缓存 key 即 path|mtime|size：三者任一变化都应重探；entry 对象引用随列表刷新变化，不作依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path, entry.modified, entry.size]);

  if (failed) {
    return (
      <div className={cn("flex h-full items-center justify-center p-4 text-xs text-muted-foreground")}>
        {t("文本读取失败")}
      </div>
    );
  }
  if (!result) {
    return <div className="h-full w-full animate-pulse bg-muted/40" />;
  }
  switch (result.kind) {
    case "text":
      return entry.size > PREVIEW_TEXT_MAX_BYTES ? (
        <InfoCard entry={entry} onOpenExternal={onOpenExternal} />
      ) : (
        <TextView path={entry.path} className="h-full w-full" probe />
      );
    case "image":
      return entry.size > PREVIEW_IMAGE_MAX_BYTES ? (
        <OversizedImage entry={entry} />
      ) : (
        <ImageView
          path={entry.path}
          mtime={entry.modified}
          className="h-full w-full"
          fallback={<InfoCard entry={entry} onOpenExternal={onOpenExternal} binary />}
        />
      );
    case "binary":
      return <InfoCard entry={entry} onOpenExternal={onOpenExternal} binary />;
    default:
      return <InfoCard entry={entry} onOpenExternal={onOpenExternal} />;
  }
}
