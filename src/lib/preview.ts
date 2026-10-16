/**
 * 预览类型门控（v0.28.0）：FileKind → 预览栏/图文浏览模式的呈现方式。
 *
 * - image：原图预览（preview_data 原字节，保 GIF 动画）
 * - text：文本渲染（read_text_file）
 * - doc：首页缩略图卡（thumb_get，PDF/Office 走 QuickLook）
 * - info：不预览内容，仅元信息 + 外部打开
 *
 * 远程路径（sftp/http/tags）一律 info（下载链路后续版本再接）。
 *
 * v0.30 文本类扩容：filekind 的 text/code 两类全部按文本预览（此前 code 类
 * json/yaml/toml/xml/sh 等一律 info），另补一批 filekind 未归类的纯文本扩展名
 * （ini 同族的 cfg/properties/reg、csv/tsv、bat/ps1、字幕、构建脚本等）与
 * 点文件/无扩展名的约定文件名（.gitignore、.env 及 .env.*、Makefile、Dockerfile、LICENSE 等）。
 * 后端 Path::extension() 对点文件返回空串，所以点文件必须按完整文件名匹配。
 */
import type { FileEntry } from "@/lib/types";
import { fileKindOf } from "@/lib/filekind";

export type PreviewKind = "image" | "text" | "doc" | "info";

/** 原图字节上限：超过后回退缩略图放大（后端 preview_data 同步把关） */
export const PREVIEW_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
/** 文本预览字符上限：超过后提示过大，不渲染 */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** filekind 未归入 text/code、但按文本读才有意义的扩展名（小写、不带点）。
 *  csv/tsv 在 filekind 里是 sheet（图标用），预览按原文比 QuickLook 缩略图更有用。 */
const TEXT_PREVIEW_EXTS = new Set([
  // 文档 / 标记
  "text", "markdown", "mdx", "rst", "adoc", "asciidoc", "org", "tex", "bib", "nfo",
  // 配置（ini 同族）
  "cfg", "config", "cnf", "properties", "plist", "reg", "desktop", "service", "rules",
  "editorconfig", "gitignore", "gitattributes", "gitmodules", "gitconfig", "npmrc", "yarnrc",
  "nvmrc", "dockerignore", "htaccess", "ovpn",
  // 脚本（filekind code 未收录的）
  "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "ahk", "fish", "ksh", "csh", "tcsh", "awk",
  "pl", "pm", "tcl", "r", "jl", "ex", "exs", "erl", "hs", "ml", "scala", "clj", "groovy",
  "gradle", "kts", "cs", "fs", "nim", "cr", "m", "mm", "asm", "s",
  // 数据 / 序列化 / 工程文件
  "csv", "tsv", "jsonc", "json5", "jsonl", "ndjson", "ipynb", "proto", "graphql", "gql",
  "tf", "tfvars", "hcl", "cue", "nix", "xaml", "resx", "csproj", "fsproj", "vbproj", "sln",
  "props", "targets", "nuspec", "pom", "xsd", "xsl", "xslt", "dtd", "htm", "xhtml", "rss",
  "atom", "opml", "wsdl", "url", "webloc", "ics", "vcf", "eml", "po", "pot", "strings",
  // 字幕 / 歌词
  "srt", "vtt", "ass", "ssa", "lrc", "sub",
  // 构建 / 版本 / 证书文本
  "mk", "cmake", "ninja", "gn", "gni", "bzl", "bazel", "lock", "sum", "mod", "diff", "patch",
  "pem", "crt", "pub", "gemspec", "rake", "podspec",
]);

/** 无扩展名 / 仅点前缀的约定文件名（小写完整文件名） */
const TEXT_PREVIEW_NAMES = new Set([
  "makefile", "gnumakefile", "dockerfile", "containerfile", "vagrantfile", "jenkinsfile",
  "procfile", "gemfile", "rakefile", "brewfile", "podfile", "fastfile", "appfile",
  "license", "licence", "copying", "readme", "changelog", "changes", "history", "authors",
  "contributors", "maintainers", "notice", "todo", "version", "install", "news", "thanks",
  ".gitignore", ".gitattributes", ".gitmodules", ".gitconfig", ".editorconfig", ".npmrc",
  ".yarnrc", ".nvmrc", ".prettierrc", ".eslintrc", ".babelrc", ".stylelintrc",
  ".browserslistrc", ".bashrc", ".bash_profile", ".bash_aliases", ".zshrc", ".zshenv",
  ".zprofile", ".profile", ".vimrc", ".inputrc", ".htaccess", ".dockerignore",
  ".prettierignore", ".eslintignore", ".npmignore", ".gitkeep", ".mailmap", ".clang-format",
  ".flake8", ".pylintrc",
]);

export function isRemotePath(path: string): boolean {
  return (
    path.startsWith("sftp://") ||
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("tags://")
  );
}

/** 是否按文本预览：filekind text/code 两类 + 补充扩展名 + 约定文件名（含 .env / .env.*） */
export function isTextLike(entry: FileEntry): boolean {
  if (entry.is_dir) return false;
  const kind = fileKindOf(entry);
  if (kind === "text" || kind === "code") return true;
  if (TEXT_PREVIEW_EXTS.has(entry.extension)) return true;
  const name = entry.name.toLowerCase();
  return TEXT_PREVIEW_NAMES.has(name) || name.startsWith(".env");
}

/** 该条目在预览栏/浏览模式中的呈现方式 */
export function previewKindOf(entry: FileEntry): PreviewKind {
  if (entry.is_dir || isRemotePath(entry.path)) return "info";
  if (isTextLike(entry)) return "text";
  switch (fileKindOf(entry)) {
    case "image":
      return "image";
    case "pdf":
    case "doc":
    case "sheet":
    case "slide":
      return "doc";
    default:
      return "info";
  }
}

/** 是否可预览内容（图文浏览模式收录依据；info 类不参与） */
export function isPreviewable(entry: FileEntry): boolean {
  return previewKindOf(entry) !== "info";
}
