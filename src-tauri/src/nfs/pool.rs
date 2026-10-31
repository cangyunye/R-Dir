//! NFS 会话池：key = host[:port]|export，LRU 上限 8（对齐 SFTP 池）。
//! 一个导出一个会话（nfs-rs 的 Mount 绑定挂载点），同一服务器的多个导出各自成会话。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::session::NfsSession;

pub const POOL_MAX: usize = 8;

/// 克隆廉价：会话本体在 Arc 后面，克隆只复制句柄表（供 & 池上做渐进挂载插入）
#[derive(Clone, Default)]
pub struct SessionPool {
    sessions: HashMap<String, Arc<Mutex<NfsSession>>>,
}

impl SessionPool {
    pub fn get(&self, key: &str) -> Option<Arc<Mutex<NfsSession>>> {
        self.sessions.get(key).cloned()
    }

    pub fn put(&mut self, key: &str, session: NfsSession) -> Arc<Mutex<NfsSession>> {
        let arc = Arc::new(Mutex::new(session));
        if self.sessions.len() >= POOL_MAX && !self.sessions.contains_key(key) {
            if let Some(k) = self.sessions.keys().next().cloned() {
                self.sessions.remove(&k);
            }
        }
        self.sessions.insert(key.to_string(), arc.clone());
        arc
    }

    pub fn remove(&mut self, key: &str) {
        self.sessions.remove(key);
    }

    pub fn keys(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
}
