//! 传输/复制进度事件（前端进度条）
//! 统一通过 Tauri 事件 "transfer-progress" 推送。

use serde::Serialize;

/// 进度载荷（camelCase 输出）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    /// "copy" | "move" | "upload" | "download"
    pub phase: String,
    /// 正在处理的文件名（展示用）
    pub label: String,
    /// 已完成文件数 / 总文件数
    pub done_files: usize,
    pub total_files: usize,
    /// 当前文件已复制字节 / 总字节
    pub file_done: u64,
    pub file_total: u64,
    /// 全部完成
    pub done: bool,
    /// 可选任务标识（http 下载 = url，用于取消命令定位）
    pub id: Option<String>,
}

impl TransferProgress {
    pub fn start(phase: &str, label: &str, total_files: usize) -> Self {
        Self {
            phase: phase.into(),
            label: label.into(),
            done_files: 0,
            total_files,
            file_done: 0,
            file_total: 0,
            done: false,
            id: None,
        }
    }
}

/// 向所有前端窗口推送进度（同步命令与异步命令均可调用；泛型 Runtime 便于单测 mock）
pub fn emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, p: &TransferProgress) {
    use tauri::Emitter;
    let _ = app.emit("transfer-progress", p);
}
