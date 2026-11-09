/**
 * 预览信息卡 + 超大图回退（v0.28.0，v0.42 自 PreviewBody 抽出供 TextProbe 复用）。
 * 信息卡：不预览内容（目录 / 远程 / 不支持的类型 / 试探判二进制）时的兜底呈现。
 */
import { Download, ExternalLink } from "lucide-react";
import { FileIcon } from "@/components/FileIcon";
import { ThumbImage } from "@/components/ThumbImage";
import { extLabel, formatSize, formatTime } from "@/lib/format";
import { isRemotePath } from "@/lib/preview";
import type { FileEntry } from "@/lib/types";
import { useT } from "@/lib/LanguageProvider";

/** 信息卡：不预览内容（目录 / 远程 / 不支持的类型 / 试探判二进制）。
 *  远程文件不是「不支持」就完了——双击本来就能下载到本地打开，这里直说并给同款按钮（v0.31.1）。
 *  binary（v0.42）：text-probe 后端产出 NOT_TEXT 码的回退形态，提示词换「疑似二进制」。 */
export function InfoCard({
  entry,
  onOpenExternal,
  binary = false,
}: {
  entry: FileEntry;
  onOpenExternal?: (path: string) => void;
  binary?: boolean;
}) {
  const t = useT();
  const sftp = entry.path.startsWith("sftp://");
  const http = entry.path.startsWith("http://") || entry.path.startsWith("https://");
  const remote = isRemotePath(entry.path);
  const hint = binary
    ? t("疑似二进制文件，不支持按文本预览")
    : entry.is_dir
      ? t("文件夹（Enter 进入）")
      : sftp
        ? t("远程文件不支持在线预览：可下载到本地后用系统应用查看（双击文件即可）")
        : http
          ? t("HTTP 文件不支持在线预览：双击可用浏览器打开")
          : remote
            ? t("此视图暂不支持预览")
            : t("此类型暂不支持预览");
  const action = !entry.is_dir && onOpenExternal && (sftp || http);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" data-testid="preview-info">
      <FileIcon entry={entry} size={56} />
      <div className="max-w-full truncate px-2 text-xs font-medium text-foreground" title={entry.name}>
        {entry.name}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {t(extLabel(entry))} · {formatSize(entry.size)} · {formatTime(entry.modified)}
      </div>
      <div className="max-w-[260px] text-[10px] leading-relaxed text-muted-foreground/80">{hint}</div>
      {action && (
        <button
          data-testid="preview-remote-open"
          onClick={() => onOpenExternal(entry.path)}
          className="mt-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
        >
          {sftp ? (
            <>
              <Download className="h-3.5 w-3.5" /> {t("下载到本地并打开")}
            </>
          ) : (
            <>
              <ExternalLink className="h-3.5 w-3.5" /> {t("在浏览器中打开")}
            </>
          )}
        </button>
      )}
    </div>
  );
}

/** 超大图回退：首页缩略图放大显示（原图超 30MB；嗅探路由的超大未知图同用） */
export function OversizedImage({ entry }: { entry: FileEntry }) {
  const t = useT();
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
        {t("文件超过 30MB，显示缩略图（「外部打开」查看原图）")}
      </div>
    </div>
  );
}
