//! 单实例：AppRoot 下 `launcher.lock` 用系统文件锁（进程没了锁自动释放），
//! 拿到锁的是主实例，把进度页地址写进 `launcher.json`；
//! 第二次双击拿不到锁，读出地址（并确认它真的是启动器在应答）后打开它即可退出。

use crate::error::{Context, Result};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LOCK_FILE: &str = "launcher.lock";
const INFO_FILE: &str = "launcher.json";
/// 进度页 /api/ping 的应答，用来确认地址背后确实是启动器
pub const PING_REPLY: &str = "mingzhi-launcher";

pub enum Acquire {
    /// 本进程是主实例
    Primary(InstanceGuard),
    /// 已有启动器在运行；带回它的进度页地址（等不到时为 None）
    Secondary(Option<String>),
}

pub struct InstanceGuard {
    _lock: File,
    info: PathBuf,
}

impl InstanceGuard {
    /// 公布进度页地址，供后来的启动器读取。
    pub fn publish(&self, url: &str) -> Result<()> {
        let json = serde_json::json!({ "url": url, "pid": std::process::id() });
        fs::write(&self.info, json.to_string()).ctx(format!("写入 {} 失败", self.info.display()))
    }
}

/// 抢单实例锁；抢不到时最多等 `wait` 读取主实例公布的地址。
pub fn acquire(dir: &Path, wait: Duration) -> Result<Acquire> {
    fs::create_dir_all(dir).ctx(format!("创建目录 {} 失败", dir.display()))?;
    let lock_path = dir.join(LOCK_FILE);
    let info = dir.join(INFO_FILE);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .ctx(format!("打开 {} 失败", lock_path.display()))?;
    match file.try_lock() {
        Ok(()) => {
            // 上次留下的地址已失效，先删掉，免得后来者读到旧的
            let _ = fs::remove_file(&info);
            Ok(Acquire::Primary(InstanceGuard { _lock: file, info }))
        }
        Err(fs::TryLockError::WouldBlock) => Ok(Acquire::Secondary(wait_for_url(&info, wait))),
        Err(fs::TryLockError::Error(e)) => {
            Err(crate::error::Error::new(format!("单实例锁失败：{e}")))
        }
    }
}

fn wait_for_url(info: &Path, wait: Duration) -> Option<String> {
    let deadline = Instant::now() + wait;
    loop {
        if let Some(url) = read_url(info).filter(|u| answers_ping(u)) {
            return Some(url);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn read_url(info: &Path) -> Option<String> {
    let text = fs::read_to_string(info).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let url = v.get("url")?.as_str()?;
    url.starts_with("http://127.0.0.1:")
        .then(|| url.to_string())
}

fn answers_ping(url: &str) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(800))
        .build();
    agent
        .get(&format!("{url}/api/ping"))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
        .is_some_and(|body| body.trim() == PING_REPLY)
}
