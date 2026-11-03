//! NFS 插件线协议（host ↔ 伴生进程 stdio JSON 行）。
//! 主程序与插件二进制各自编译本模块，类型形状是两侧的契约：
//! 改动任何字段/枚举臂必须同步递增 [`PROTOCOL_VERSION`]。

use serde::{Deserialize, Serialize};

/// 线协议版本：host 校验插件 manifest 的 protocolVersion 必须与之一致才允许运行
pub const PROTOCOL_VERSION: u32 = 1;

/// 远程条目（与主程序 fs_ops::FileEntry 字段一一对应，host 侧逐字段转换）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NfsEntry {
    pub name: String,
    /// 可继续导航的完整 nfs:// URL
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix 毫秒时间戳
    pub modified: Option<i64>,
    pub created: Option<i64>,
    /// 权限字符串，unix 为 "drwxr-xr-x" 风格
    pub permissions: String,
    /// 小写扩展名（无点）
    pub extension: String,
}

/// 递归传输计划（两阶段进度的分母：先统计再传）
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPlan {
    /// 待传文件数（目录不计）
    pub files: usize,
    /// 待传总字节
    pub bytes: u64,
}

/// 递归传输事件（对齐本地复制的 CbEvent / SFTP 的 XferEvent）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum XferEvent {
    /// 开始传输一个文件（label：自顶层条目起的相对路径，展示用）
    Start { label: String },
    /// 当前文件字节进度
    Bytes { done: u64, total: u64 },
    /// 单个文件完成
    EntryDone,
}

/// host → 插件的操作请求（一行 JSON 一个请求）
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", content = "args", rename_all = "snake_case")]
pub enum Op {
    /// 握手：返回插件版本与协议版本（host 启动时校验协议匹配）
    Ping,
    ListDir { path: String },
    StatPath { path: String },
    /// 下载单文件到临时目录（打开场景，无取消）；进度经 Bytes 事件上报
    Download { path: String, temp_dir: String },
    /// 遍历远程树统计文件数/字节（下载分母）；可取消
    DownloadPlan { path: String },
    /// 下载远程路径（文件或目录）到本地目录；overwrite=false 顶层同名自动加 " (n)"
    DownloadTo { local_dir: String, path: String, overwrite: bool },
    /// 上传本地路径（文件或目录）到远程目录，返回远程完整 URL
    UploadPath { local: String, remote_dir: String, name: String },
    Mkdir { remote_dir: String, name: String },
    CreateFile { remote_dir: String, name: String },
    DeleteEntries { paths: Vec<String> },
    RenameEntry { old_path: String, new_name: String },
}

/// host → 插件的取消请求（无响应帧；被取消的操作以 err=CANCELLED 收尾）
#[derive(Debug, Serialize, Deserialize)]
pub struct Cancel {
    pub op: CancelOp,
    pub id: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum CancelOp {
    #[serde(rename = "cancel")]
    Cancel,
}

/// 插件 → host 的输出帧（一行 JSON 一帧；id 关联请求，事件流可乱序穿插）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "frame")]
pub enum Frame {
    /// 操作成功终态（value 形状随 op 而定：list_dir 为 NfsEntry 数组等）
    Ok { id: u64, value: serde_json::Value },
    /// 操作失败终态（error 为错误码契约串，如 "CANCELLED"）
    Err { id: u64, error: String },
    /// 操作进度事件（长操作期间可出现任意多次）
    Ev { id: u64, event: XferEvent },
    /// 诊断日志（host 写 stderr 展示，不影响协议）
    Log { level: String, message: String },
}

/// ping 的返回值
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingInfo {
    pub plugin_version: String,
    pub protocol_version: u32,
}
