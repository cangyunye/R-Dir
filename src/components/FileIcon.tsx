import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  Film,
  Presentation,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileEntry } from "@/lib/types";
import { fileKindOf, type FileKind } from "@/lib/filekind";

/** 图标资产（Vite 静态导入）：{kind}-lg.png 128 / {kind}-lg@2x.png 256 /
 * {kind}-sm.png 16 / {kind}-sm@2x.png 32。缺失的类型自动回退 lucide 线性图标。 */
const ASSETS = import.meta.glob<string>(
  "@/assets/fileicons/*.png",
  { eager: true, query: "?url", import: "default" },
);

function assetFor(kind: FileKind, size: "sm" | "lg", scale: 1 | 2): string | undefined {
  const hit = Object.entries(ASSETS).find(([path]) =>
    path.endsWith(`/${kind}-${size}${scale === 2 ? "@2x" : ""}.png`),
  );
  return hit?.[1];
}

/** 分类配色（列表视图线性回退仍按此着色） */
export function fileKindClass(entry: FileEntry): string {
  switch (fileKindOf(entry)) {
    case "image": return "text-emerald-600";
    case "video": return "text-rose-500";
    case "audio": return "text-fuchsia-600";
    case "archive": return "text-orange-500";
    case "code": return "text-sky-600";
    case "sheet": return "text-green-600";
    case "slide": return "text-orange-400";
    case "doc": return "text-blue-600";
    case "pdf": return "text-red-600";
    case "app": return "text-indigo-500";
    case "text": return "text-slate-500";
    case "folder": return "text-folder";
    default: return "text-slate-400";
  }
}

function Glyph({ entry, size, cls }: { entry: FileEntry; size: number; cls: string }) {
  if (entry.is_dir) return <Folder size={size} className={cls} />;
  switch (fileKindOf(entry)) {
    case "image": return <FileImage size={size} className={cls} />;
    case "video": return <Film size={size} className={cls} />;
    case "audio": return <FileAudio size={size} className={cls} />;
    case "archive": return <FileArchive size={size} className={cls} />;
    case "code": return <FileCode size={size} className={cls} />;
    case "sheet": return <FileSpreadsheet size={size} className={cls} />;
    case "slide": return <Presentation size={size} className={cls} />;
    case "doc": return <FileType size={size} className={cls} />;
    case "pdf": return <FileType size={size} className={cls} />;
    case "text": return <FileText size={size} className={cls} />;
    default: return <File size={size} className={cls} />;
  }
}

export function FileIcon({
  entry,
  size = 16,
  className,
}: {
  entry: FileEntry;
  size?: number;
  className?: string;
}) {
  const cls = cn(fileKindClass(entry), className);
  const kind = fileKindOf(entry);
  const variant = size <= 20 ? "sm" : "lg";
  const src1x = assetFor(kind, variant, 1);
  if (src1x) {
    const src2x = assetFor(kind, variant, 2);
    return (
      <img
        src={src1x}
        srcSet={src2x ? `${src1x} 1x, ${src2x} 2x` : undefined}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
        className={cn("shrink-0 object-contain", className)}
      />
    );
  }
  return <Glyph entry={entry} size={size} cls={cls} />;
}
