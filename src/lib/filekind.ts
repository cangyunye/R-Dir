/**
 * 文件类型分类（v0.27.0）：扩展名 → 13 类语义类型。
 *
 * filekind 是图标资产（src/assets/fileicons/{kind}-*.png）、缩略图资格判定、
 * 画廊模式回退渲染的统一依据；FileIcon.tsx 与 IconGrid.tsx 都从这里取分类。
 * 新增类型 = 这里加扩展名集合 + assets 目录放对应 PNG（缺失自动回退 lucide 线性图标）。
 */

export type FileKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "doc"
  | "sheet"
  | "slide"
  | "text"
  | "pdf"
  | "app"
  | "file";

export const FILE_KINDS: FileKind[] = [
  "folder",
  "image",
  "video",
  "audio",
  "archive",
  "code",
  "doc",
  "sheet",
  "slide",
  "text",
  "pdf",
  "app",
  "file",
];

/** 画廊模式可出真实缩略图的类型：图片走 image crate 解码（跨平台）；
 * PDF/视频/文档走 macOS QuickLook（系统能预览的都能出图，失败回退图标）。 */
export const THUMBNAIL_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  "image",
  "video",
  "pdf",
  "doc",
  "sheet",
  "slide",
]);

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif", "ico", "tiff",
]);
// v0.30：去掉 "ts"（MPEG-TS）——它同时列在 CODE_EXTS（TypeScript），此前因匹配顺序被判成视频，
// 项目目录里的 .ts 源码全显示视频图标且无法文本预览；MPEG-TS 片段按 code 兜底影响可忽略
const VIDEO_EXTS = new Set(["mp4", "mkv", "mov", "avi", "webm", "flv", "m4v", "wmv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus", "wma"]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"]);
const CODE_EXTS = new Set([
  "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "c", "cpp", "h", "hpp",
  "rb", "php", "swift", "kt", "sh", "bash", "zsh", "toml", "json", "yaml",
  "yml", "xml", "html", "css", "scss", "sql", "lua", "dart", "zig", "vue",
]);
const DOC_EXTS = new Set(["doc", "docx", "odt", "rtf", "pages"]);
const SHEET_EXTS = new Set(["xls", "xlsx", "csv", "ods", "numbers"]);
const SLIDE_EXTS = new Set(["ppt", "pptx", "odp", "key"]);
const TEXT_EXTS = new Set(["txt", "md", "log", "ini", "conf", "env", "gitignore"]);
const PDF_EXTS = new Set(["pdf"]);
const APP_EXTS = new Set(["exe", "msi", "dmg", "app", "deb", "appimage", "apk", "rpm", "pkg"]);

const EXT_KIND: ReadonlyArray<readonly [ReadonlySet<string>, FileKind]> = [
  [PDF_EXTS, "pdf"],
  [APP_EXTS, "app"],
  [IMAGE_EXTS, "image"],
  [VIDEO_EXTS, "video"],
  [AUDIO_EXTS, "audio"],
  [ARCHIVE_EXTS, "archive"],
  [CODE_EXTS, "code"],
  [SHEET_EXTS, "sheet"],
  [SLIDE_EXTS, "slide"],
  [DOC_EXTS, "doc"],
  [TEXT_EXTS, "text"],
];

/** 分类判定：目录 → folder，按扩展名匹配，其余 → file 兜底 */
export function fileKindOf(entry: { is_dir: boolean; extension: string }): FileKind {
  if (entry.is_dir) return "folder";
  const ext = entry.extension;
  for (const [set, kind] of EXT_KIND) {
    if (set.has(ext)) return kind;
  }
  return "file";
}
