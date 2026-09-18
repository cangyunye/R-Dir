//! v0.7 窗口分享：会话数据模型与共享管理器。
//!
//! 设计要点：
//! - 链接即身份：token 是唯一凭证，无多用户体系，权限在创建时固化
//! - 连接数上限默认 3（可选 1/3/10/不限），会话到期/主动停止即下线
//! - 连接日志记录访问者 IP / UA / 时间（分享面板可见）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

/// 分享权限档位（P1 仅 Read 生效；Write/Delete 供 P2 原生会话使用）
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SharePerm {
    Read,
    Write,
    Delete,
}

impl SharePerm {
    pub fn as_str(&self) -> &'static str {
        match self {
            SharePerm::Read => "read",
            SharePerm::Write => "write",
            SharePerm::Delete => "delete",
        }
    }
}

/// 单条访问者日志
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnLog {
    pub ip: String,
    pub ua: String,
    pub connected_at: u64, // unix 秒
    pub last_active: u64,
}

/// 分享根（P1 固定 1 个 = 分享的目录；协议层支持多 root，P2 扩展）
#[derive(Clone, Debug)]
pub struct ShareRoot {
    pub id: String,
    pub path: PathBuf,
}

/// 一个活跃分享会话
pub struct ShareSession {
    pub id: String,
    pub token: String,
    pub roots: Vec<ShareRoot>,
    pub perm: SharePerm,
    /// 是否允许接收方上溯到分享根之外的父目录（默认 false：严格锁定根内）
    pub allow_parent: bool,
    /// 并发连接数上限；0 = 不限
    pub max_conns: usize,
    pub expires_at: Option<SystemTime>,
    pub created_at: SystemTime,
    pub port: u16,
    /// 服务器 JoinHandle 的 abort 句柄（停止分享用；None 用于测试/未启动）
    pub server_task: Option<tauri::async_runtime::JoinHandle<()>>,
    pub conns: Mutex<Vec<ConnLog>>,
}

/// 会话对外视图（前端面板展示）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSessionView {
    pub id: String,
    pub token: String,
    pub dir: String,
    pub perm: String,
    pub allow_parent: bool,
    pub max_conns: usize,
    pub port: u16,
    pub url: String,
    pub expires_at: Option<u64>,
    pub conns: Vec<ConnLog>,
}

/// ShareManager：会话注册表 + 端口 + token 生成
pub struct ShareManager {
    pub sessions: Mutex<HashMap<String, ShareSession>>,
    pub next_token_seq: Mutex<u64>,
}

impl Default for ShareManager {
    fn default() -> Self {
        ShareManager {
            sessions: Mutex::new(HashMap::new()),
            next_token_seq: Mutex::new(0),
        }
    }
}

impl ShareManager {
    /// 生成 32 位 hex token（时间 + 序号 + 随机源，足够防枚举）
    pub fn gen_token(&self) -> String {
        let mut seq = self.next_token_seq.lock().unwrap();
        *seq += 1;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let rnd = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0)
            .wrapping_mul(0x9E3779B97F4A7C15)
            .rotate_left(17) as u32; // 截断为 8 hex 位，保证总长 32
        format!("{:016x}{:08x}{:08x}", now, *seq, rnd)
    }


    /// 停止会话（abort 服务器任务 + 移除注册）
    pub fn stop(&self, id: &str) -> bool {
        let mut m = self.sessions.lock().unwrap();
        if let Some(sess) = m.remove(id) {
            if let Some(t) = sess.server_task {
                t.abort();
            }
            true
        } else {
            false
        }
    }

    /// 按分享根路径停止（关闭被分享的窗口/标签时调用）
    pub fn stop_by_root(&self, dir: &std::path::Path) -> usize {
        let mut m = self.sessions.lock().unwrap();
        let to_remove: Vec<String> = m
            .iter()
            .filter(|(_, s)| s.roots.iter().any(|r| r.path == dir))
            .map(|(id, _)| id.clone())
            .collect();
        let n = to_remove.len();
        for id in to_remove {
            if let Some(s) = m.remove(&id) {
                if let Some(t) = s.server_task {
                    t.abort();
                }
            }
        }
        n
    }
}
