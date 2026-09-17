/** 与 Rust 端 FileEntry 对应 */
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  /** Unix 毫秒时间戳 */
  modified: number | null;
  created: number | null;
  permissions: string;
  extension: string;
}

export interface VolumeInfo {
  name: string;
  path: string;
  kind: string;
}

export interface QuickAccessItem {
  key: string;
  path: string;
}

export type SortKey = "name" | "size" | "modified" | "type";
export type SortDir = "asc" | "desc";

/** 单个窗格（pane）的独立浏览状态 */
export interface PaneState {
  id: number;
  path: string;
  title: string;
  history: string[];
  histIndex: number;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  sortKey: SortKey;
  sortDir: SortDir;
  /** 选中条目路径，首项为主选中 */
  selection: string[];
  /** 自增计数，用于触发刷新 */
  refreshKey: number;
  /** 虚拟标签目录（tags://<tagId>）：存在时该窗格显示标签视图而非目录列表 */
  tagId?: string;
}

/** 分割方向：row = 左右并排，col = 上下堆叠 */
export type SplitDir = "row" | "col";

export interface SplitNode {
  type: "split";
  id: number;
  dir: SplitDir;
  /** 第一个子节点占比 0.1–0.9 */
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = { type: "pane"; paneId: number } | SplitNode;

/** 标签页：一棵 pane 树 + 全部 pane 状态 */
export interface TabState {
  id: number;
  title: string;
  root: PaneNode;
  /** 当前聚焦的 pane id */
  activePane: number;
  panes: Record<number, PaneState>;
}

/** 应用内剪贴板（复制/剪切），跨 pane、跨标签共享 */
export type ClipOp = "copy" | "cut";
export interface ClipboardState {
  op: ClipOp;
  paths: string[];
}

/** 内容搜索（ripgrep 风格）单条命中 */
export interface SearchMatch {
  path: string;
  /** 相对搜索根目录的展示路径 */
  rel_path: string;
  line_number: number;
  line: string;
}

/** fd 快速检索结果 */
export interface FindEntry {
  path: string;
  /** 相对搜索根目录的展示路径 */
  rel_path: string;
  is_dir: boolean;
}
