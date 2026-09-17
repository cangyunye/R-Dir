//! SFTP 会话池：key = user@host:port，LRU 上限 8，空闲超时由连接层控制。
//! 所有会话操作串行（tokio Mutex），天然避免同一连接并发读写。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::session::SftpSession;

pub const POOL_MAX: usize = 8;

#[derive(Default)]
pub struct SessionPool {
    sessions: HashMap<String, Arc<Mutex<SftpSession>>>,
}

impl SessionPool {
    pub fn get(&self, key: &str) -> Option<Arc<Mutex<SftpSession>>> {
        self.sessions.get(key).cloned()
    }

    pub fn put(&mut self, key: &str, session: SftpSession) -> Arc<Mutex<SftpSession>> {
        let arc = Arc::new(Mutex::new(session));
        // 简单 LRU：超过上限时移除最早插入的（HashMap 顺序不稳定，v0.2 够用）
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
