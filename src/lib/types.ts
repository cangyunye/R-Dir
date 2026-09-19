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
