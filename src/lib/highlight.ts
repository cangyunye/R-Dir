/**
 * 预览语法高亮（v0.41）：TextView 的渐进增强，纯文本永远是兜底。
 *
 * 选型 highlight.js（而非 Shiki/CodeMirror）：预览是只读快照，要的是结构区分度
 * 而非 TextMate 保真；hljs core + 按语言动态 import（各语言独立 chunk，预览到才拉）
 * 包体与使用量成正比。highlightCode 只对「截断后的 256KB 显示文本」调用。
 *
 * - 失败即回退：语言模块加载失败 / 语法抛错 / span 数超护栏，一律返回 null，
 *   调用方继续渲染纯文本——高亮只能是增强，不能是回归（v0.28.1 主线程教训）。
 * - span 护栏：极端 token 密度的文本可能产出数万 span，style/layout 成本陡增时
 *   宁可不上色。
 * - hljs 输出对文本自带 HTML 转义，产物只含 .hljs-* span，可直接 dangerouslySetInnerHTML。
 */
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";

/** 高亮产物 span 数上限：超过回退纯文本（256KB 上限下的最坏情况护栏） */
const MAX_TOKEN_SPANS = 20000;

/** hljs 语言 id → 语言模块动态 import（vite 逐语言分包，命中才加载） */
const LANG_LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  dos: () => import("highlight.js/lib/languages/dos"),
  go: () => import("highlight.js/lib/languages/go"),
  gradle: () => import("highlight.js/lib/languages/gradle"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  properties: () => import("highlight.js/lib/languages/properties"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/** 扩展名 → hljs 语言 id（小写、不带点）。保守映射：没有对应语法的（zig/vue/csv/log）
 *  一律不映射，保持纯文本。toml 共用 ini 语法（hljs ini 模块即 "TOML, also INI"）。 */
const EXT_LANG: Record<string, string> = {
  // 编程（filekind CODE_EXTS）
  rs: "rust", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  rb: "ruby", php: "php", swift: "swift", lua: "lua", dart: "dart", sql: "sql",
  sh: "bash", bash: "bash", zsh: "bash", bat: "dos", cmd: "dos",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  // 数据 / 序列化
  json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", ipynb: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", xml: "xml", plist: "xml", xaml: "xml",
  html: "xml", htm: "xml", xhtml: "xml", css: "css", scss: "scss",
  proto: "protobuf", graphql: "graphql", gql: "graphql",
  // 文档 / 补丁 / 构建 / 配置
  md: "markdown", markdown: "markdown", mdx: "markdown",
  diff: "diff", patch: "diff", mk: "makefile", cmake: "cmake", gradle: "gradle",
  ini: "ini", cfg: "ini", conf: "ini", config: "ini", cnf: "ini", properties: "properties",
  gemspec: "ruby", rake: "ruby",
};

/** 无扩展名 / 点前缀约定文件名 → hljs 语言 id（小写完整文件名；后端对点文件给空扩展名） */
const NAME_LANG: Record<string, string> = {
  makefile: "makefile", gnumakefile: "makefile",
  dockerfile: "dockerfile", containerfile: "dockerfile",
  gemfile: "ruby", rakefile: "ruby",
  ".gitconfig": "ini", ".editorconfig": "ini",
  ".bashrc": "bash", ".bash_profile": "bash", ".bash_aliases": "bash",
  ".zshrc": "bash", ".zshenv": "bash", ".zprofile": "bash", ".profile": "bash",
};

const registered = new Set<string>();
const pending = new Map<string, Promise<void>>();

/** 惰性注册语言模块；已注册/注册中复用同一 promise。失败返回 false（回退纯文本）。 */
async function ensureLanguage(lang: string): Promise<boolean> {
  if (registered.has(lang)) return true;
  const load = LANG_LOADERS[lang];
  if (!load) return false;
  let task = pending.get(lang);
  if (!task) {
    task = load()
      .then((m) => {
        hljs.registerLanguage(lang, m.default);
        registered.add(lang);
      })
      .finally(() => pending.delete(lang));
    pending.set(lang, task);
  }
  try {
    await task;
    return true;
  } catch {
    return false;
  }
}

function countSpans(html: string): number {
  let n = 0;
  let i = html.indexOf("<span");
  for (; i !== -1; i = html.indexOf("<span", i + 1)) n++;
  return n;
}

/** 高亮文本 → HTML（.hljs-* span）；语言未知/失败/span 超护栏返回 null（调用方回退纯文本） */
export async function highlightCode(text: string, lang: string): Promise<string | null> {
  if (!(await ensureLanguage(lang))) return null;
  try {
    const result = hljs.highlight(text, { language: lang, ignoreIllegals: true });
    if (countSpans(result.value) > MAX_TOKEN_SPANS) return null;
    return result.value;
  } catch {
    return null;
  }
}

/** 路径 → hljs 语言 id：约定文件名优先（点文件后端扩展名为空），再按扩展名；无语法 → null。
 *  .env* 这类无语法文件明确不映射（bash 语法对 KEY=value 会整行误判，不如纯文本）。 */
export function languageForPath(path: string): string | null {
  const base = (path.split("/").pop() ?? path).split("\\").pop() ?? path;
  const lower = base.toLowerCase();
  const byName = NAME_LANG[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXT_LANG[lower.slice(dot + 1)] ?? null;
}
