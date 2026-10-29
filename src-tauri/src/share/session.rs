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

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试会话（server_task = None：不启动真实服务器）
    fn test_session(id: &str, token: &str, root: &std::path::Path) -> ShareSession {
        ShareSession {
            id: id.to_string(),
            token: token.to_string(),
            roots: vec![ShareRoot {
                id: "r0".into(),
                path: root.to_path_buf(),
            }],
            perm: SharePerm::Read,
            allow_parent: false,
            max_conns: 3,
            expires_at: None,
            created_at: SystemTime::now(),
            port: 0,
            server_task: None,
            conns: Mutex::new(Vec::new()),
        }
    }

    // ---------- gen_token ----------

    #[test]
    fn token_is_32_hex_and_unique() {
        let m = ShareManager::default();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let t = m.gen_token();
            assert_eq!(t.len(), 32, "{t}");
            assert!(t.chars().all(|c| c.is_ascii_hexdigit()), "{t}");
            assert!(seen.insert(t), "token 不应重复");
        }
    }

    #[test]
    fn token_seq_increments_into_token_body() {
        // 中段 8 hex 是序号：同一 manager 连续生成的 token 序号段递增
        let m = ShareManager::default();
        let t1 = m.gen_token();
        let t2 = m.gen_token();
        let seq1 = u64::from_str_radix(&t1[16..24], 16).unwrap();
        let seq2 = u64::from_str_radix(&t2[16..24], 16).unwrap();
        assert_eq!(seq2, seq1 + 1);
    }

    // ---------- stop / stop_by_root ----------

    #[test]
    fn stop_removes_session_and_reports_miss() {
        let m = ShareManager::default();
        let root = std::env::temp_dir().join("rdir-share-stop");
        m.sessions.lock().unwrap().insert("s1".into(), test_session("s1", "t1", &root));

        assert!(m.stop("s1"), "存在的会话应返回 true");
        assert!(!m.stop("s1"), "已移除的会话再 stop 返回 false");
        assert!(!m.stop("ghost"));
        assert!(m.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_by_root_only_removes_matching_and_counts() {
        let m = ShareManager::default();
        let root_a = std::env::temp_dir().join("rdir-share-a");
        let root_b = std::env::temp_dir().join("rdir-share-b");
        {
            let mut s = m.sessions.lock().unwrap();
            s.insert("a1".into(), test_session("a1", "t1", &root_a));
            s.insert("a2".into(), test_session("a2", "t2", &root_a));
            s.insert("b1".into(), test_session("b1", "t3", &root_b));
        }

        assert_eq!(m.stop_by_root(&root_a), 2);
        let sessions = m.sessions.lock().unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(sessions.contains_key("b1"));
    }

    #[test]
    fn stop_by_root_no_match_is_zero() {
        let m = ShareManager::default();
        let root = std::env::temp_dir().join("rdir-share-none");
        assert_eq!(m.stop_by_root(&root), 0);
    }

    // ---------- 数据模型 ----------

    #[test]
    fn perm_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&SharePerm::Read).unwrap(),
            "\"read\""
        );
        assert_eq!(
            serde_json::to_string(&SharePerm::Write).unwrap(),
            "\"write\""
        );
        assert_eq!(SharePerm::Delete.as_str(), "delete");
    }
}
