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
  /** v0.8 窗口级缩放（0.5–2.0，Ctrl+滚轮，随会话保存） */
  zoom: number;
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
  /** 自动标题（随活动窗格路径变化） */
  title: string;
  /** 用户右键自定义标题；存在时优先展示，随会话保存 */
  customTitle?: string;
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

/** 一条同名冲突（Rust ops::Conflict，camelCase） */
export interface TransferConflict {
  src: string;
  dest: string;
  srcKind: "file" | "dir";
  destKind: "file" | "dir";
  /** 默认改名（`name_1.ext`） */
  suggest: string;
}

/** 单条冲突裁决（Rust ops::Resolution 的 wire 格式） */
export type TransferResolution =
  | { action: "overwrite" }
  | { action: "skip" }
  | { action: "rename"; name: string };

/** dest 路径 → 裁决 */
export type ResolutionPlan = Record<string, TransferResolution>;

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

// ==================== SFTP 远程服务器（v0.2 插件） ====================

/** 服务器清单条目（与 Rust servers::ServerConfigFile 对齐，camelCase） */
export interface SftpServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  root?: string | null;
  /** 服务器分组（空 = 默认组） */
  group?: string;
  /** "password" | "publicKey"（与后端 serde camelCase 对齐） */
  auth: "password" | "publicKey";
  // Password
  password?: string;
  savePassword?: boolean;
  // PublicKey
  keyPath?: string;
  passphrase?: string;
  savePassphrase?: boolean;
}

/** 服务器视图（连接状态等，来自后端） */
export interface SftpServerView {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  root?: string | null;
  /** 连接后默认进入的远程绝对路径（root 优先，否则 home） */
  defaultRemote: string;
  group: string;
  auth: string;
  hasSecret: boolean;
  connected: boolean;
}

/** master-key 状态 */
/** 传输/复制进度事件载荷（对应后端 progress.rs） */
export interface TransferProgress {
  /** "copy" | "move" | "upload" | "download" | "compress" */
  phase: "copy" | "move" | "upload" | "download" | "compress";
  label: string;
  doneFiles: number;
  totalFiles: number;
  fileDone: number;
  fileTotal: number;
  done: boolean;
  /** 可选任务标识（http 下载 = url，用于取消） */
  id?: string;
}

/** 会话保存（v0.3.0）：单个窗格快照，SFTP 只存 serverId，不含任何凭据 */
export interface SessionPane {
  id: number;
  path: string;
  kind: "local" | "sftp" | "tag";
  serverId?: string;
  tagId?: string;
  /** v0.8 窗口缩放（旧会话缺省 1） */
  zoom?: number;
}

/** 会话保存：标签页快照（root 为分屏树 JSON） */
export interface SessionTab {
  id: number;
  title: string;
  /** 用户自定义标签名（可选，随会话保存） */
  customTitle?: string;
  activePane: number;
  root: unknown;
  panes: SessionPane[];
}

/** 会话布局（对应后端 SessionLayout，camelCase） */
export interface SessionLayout {
  version: number;
  savedAt: string;
  activeTab: number;
  tabs: SessionTab[];
}

export interface MasterKeyStatus {
  /** 是否已设置过（有校验值） */
  configured: boolean;
  /** 当前内存中是否已输入（会话内无需重复） */
  active: boolean;
}

/** 目录/文件递归大小统计结果（v0.16 右键「属性」） */
export interface SizeStat {
  bytes: number;
  files: number;
  dirs: number;
}

/** 大小统计增量进度事件载荷 */
export interface SizeProgress extends SizeStat {
  id: string;
  done: boolean;
}

// ---- v0.17 目录差异比对（v0.18 增强进度/取消/类型冲突） ----
export type DiffLevel = 1 | 2 | 3;

export interface DiffSide {
  path: string;
  size: number;
  modified: number | null;
  is_dir: boolean;
}

export type DiffStatus = "left-only" | "right-only" | "same" | "different";

export interface DiffEntry {
  name: string;
  is_dir: boolean;
  left: DiffSide | null;
  right: DiffSide | null;
  status: DiffStatus;
  /** 差异原因：size | content | mtime | type */
  reason?: string;
}

/** 比对选项（与后端 DiffOptions 对齐） */
export interface DiffOptions {
  level: DiffLevel;
  /** 名称匹配是否区分大小写（Windows/macOS 不敏感） */
  caseSensitive: boolean;
  /** 三层 mtime 容差（毫秒） */
  mtimeToleranceMs: number;
}

/** 比对增量进度（对应后端 DiffProgress） */
export interface DiffProgress {
  id: string;
  phase: "compare" | "hash";
  done: number;
  total: number;
  current: string;
  doneAll: boolean;
  cancelled: boolean;
}

/** 比对结果（cancelled=true 时 entries 不完整） */
export interface DiffOutcome {
  entries: DiffEntry[];
  cancelled: boolean;
}

// ---- v0.19 文本比较（文件 vs 文件 / git diff 解析共用 hunk 模型） ----

/** 参与文本比较的一侧（远程侧经临时下载，读后即删） */
export interface TextSide {
  path: string;
  localPath: string;
  isTemp: boolean;
  /** 含非 UTF-8 字节，已 lossy 转换 */
  lossy: boolean;
  bytes: number;
  lines: number;
}

/** 一段连续同类型行：eq 相同 / del 左侧独有 / add 右侧独有；行号 1 基 */
export interface TextSegment {
  kind: "eq" | "del" | "add";
  leftStart: number | null;
  rightStart: number | null;
  lines: string[];
}

export interface TextDiffOutcome {
  left: TextSide;
  right: TextSide;
  segments: TextSegment[];
  additions: number;
  deletions: number;
  same: boolean;
  /** 中段过大退化为整块替换（未做行级对齐） */
  coarse: boolean;
}

/** 读取文本文件（.patch/.diff「查看 Diff」解析用） */
export interface TextFileContent {
  path: string;
  localPath: string;
  isTemp: boolean;
  lossy: boolean;
  text: string;
}

// ---- v0.7 窗口分享 ----
export interface ShareConnLog {
  ip: string;
  ua: string;
  connectedAt: number;
  lastActive: number;
}

export interface ShareSessionView {
  id: string;
  token: string;
  dir: string;
  perm: string;
  allowParent: boolean;
  maxConns: number;
  port: number;
  url: string;
  expiresAt: number | null;
  conns: ShareConnLog[];
}

export interface ShareCreateResult {
  id: string;
  token: string;
  port: number;
  url: string;
  expiresAt: number | null;
}
