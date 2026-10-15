//! 下载进度的共享状态：已下字节、总字节、速度、正在处理的项。
//! 进度页（Task 3）定时调用 `snapshot()` 读取即可，无需回调。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// 速度统计的最短窗口，太短抖动大。
const SPEED_WINDOW_SECS: f64 = 0.5;

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub downloaded: u64,
    pub total: u64,
    /// 平滑后的下载速度，字节/秒
    pub bytes_per_sec: f64,
    /// 正在处理的项描述（如「下载 node」「解包 app」），按 id 排序
    pub active: Vec<String>,
}

struct Window {
    at: Instant,
    bytes: u64,
    speed: f64,
}

pub struct Progress {
    downloaded: AtomicU64,
    total: AtomicU64,
    window: Mutex<Window>,
    active: Mutex<BTreeMap<String, String>>,
}

impl Progress {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            downloaded: AtomicU64::new(0),
            total: AtomicU64::new(0),
            window: Mutex::new(Window {
                at: Instant::now(),
                bytes: 0,
                speed: 0.0,
            }),
            active: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::Relaxed);
    }

    pub fn add(&self, n: u64) {
        self.downloaded.fetch_add(n, Ordering::Relaxed);
    }

    /// 丢弃已下内容（如校验失败删除 .part）时回退计数。
    pub fn sub(&self, n: u64) {
        let _ = self
            .downloaded
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
                Some(v.saturating_sub(n))
            });
    }

    pub fn set_active(&self, id: &str, text: &str) {
        if let Ok(mut m) = self.active.lock() {
            m.insert(id.to_string(), text.to_string());
        }
    }

    pub fn clear_active(&self, id: &str) {
        if let Ok(mut m) = self.active.lock() {
            m.remove(id);
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let downloaded = self.downloaded.load(Ordering::Relaxed);
        let speed = match self.window.lock() {
            Ok(mut w) => {
                let secs = w.at.elapsed().as_secs_f64();
                if secs >= SPEED_WINDOW_SECS {
                    let instant = downloaded.saturating_sub(w.bytes) as f64 / secs;
                    // 与上一窗口取平均，避免数字跳动
                    w.speed = if w.speed == 0.0 {
                        instant
                    } else {
                        (w.speed + instant) / 2.0
                    };
                    w.at = Instant::now();
                    w.bytes = downloaded;
                }
                w.speed
            }
            Err(_) => 0.0,
        };
        let active = self
            .active
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();
        Snapshot {
            downloaded,
            total: self.total.load(Ordering::Relaxed),
            bytes_per_sec: speed,
            active,
        }
    }
}
