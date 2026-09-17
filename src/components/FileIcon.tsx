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

const CODE_EXTS = new Set([
  "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "c", "cpp", "h", "hpp",
  "rb", "php", "swift", "kt", "sh", "bash", "zsh", "toml", "json", "yaml",
  "yml", "xml", "html", "css", "scss", "sql", "lua", "dart", "zig", "vue",
]);
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif", "ico", "tiff",
]);
const VIDEO_EXTS = new Set(["mp4", "mkv", "mov", "avi", "webm", "flv", "m4v", "wmv", "ts"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus", "wma"]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"]);
const DOC_EXTS = new Set(["doc", "docx", "odt", "rtf"]);
const SHEET_EXTS = new Set(["xls", "xlsx", "csv", "ods"]);
const SLIDE_EXTS = new Set(["ppt", "pptx", "odp"]);
const TEXT_EXTS = new Set(["txt", "md", "log", "ini", "conf", "env", "gitignore"]);

export function fileKindClass(entry: FileEntry): string {
  if (entry.is_dir) return "text-amber-500";
  const ext = entry.extension;
  if (IMAGE_EXTS.has(ext)) return "text-emerald-600";
  if (VIDEO_EXTS.has(ext)) return "text-rose-500";
  if (AUDIO_EXTS.has(ext)) return "text-fuchsia-600";
  if (ARCHIVE_EXTS.has(ext)) return "text-orange-500";
  if (CODE_EXTS.has(ext)) return "text-sky-600";
  if (SHEET_EXTS.has(ext)) return "text-green-600";
  if (SLIDE_EXTS.has(ext)) return "text-orange-400";
  if (DOC_EXTS.has(ext)) return "text-blue-600";
  if (TEXT_EXTS.has(ext)) return "text-slate-500";
  return "text-slate-400";
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
  if (entry.is_dir) {
    return <Folder size={size} className={cls} />;
  }
  const ext = entry.extension;
  let Icon = File;
  if (IMAGE_EXTS.has(ext)) Icon = FileImage;
  else if (VIDEO_EXTS.has(ext)) Icon = Film;
  else if (AUDIO_EXTS.has(ext)) Icon = FileAudio;
  else if (ARCHIVE_EXTS.has(ext)) Icon = FileArchive;
  else if (CODE_EXTS.has(ext)) Icon = FileCode;
  else if (SHEET_EXTS.has(ext)) Icon = FileSpreadsheet;
  else if (SLIDE_EXTS.has(ext)) Icon = Presentation;
  else if (DOC_EXTS.has(ext)) Icon = FileType;
  else if (TEXT_EXTS.has(ext)) Icon = FileText;
  return <Icon size={size} className={cls} />;
}
