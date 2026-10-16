//! 下载进度的共享状态：已下字节、总字节、速度、正在处理的项，以及逐项的阶段/字节/速度/错误。
//! 进度页定时调用 `snapshot()` / `items()` 读取即可，无需回调。

use crate::manifest::Item;
use serde::Serialize;
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

/// 单项所处阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// 刚登记，还没判定是否已装
    Checking,
    /// 需要安装，排队中
    Waiting,
    Downloading,
    /// 校验 / 解包 / 落盘
    Installing,
    /// 本来就装好了
    Ready,
    /// 本次装好
    Done,
    /// 必需项失败（阻塞启动）
    Failed,
    /// 可选项失败（不阻塞，稍后补齐）
    Deferred,
}

/// 进度页用的单项快照。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSnapshot {
    pub id: String,
    pub kind: String,
    pub size: u64,
    pub downloaded: u64,
    pub bytes_per_sec: f64,
    pub phase: Phase,
    pub error: Option<String>,
    pub optional: bool,
    /// 本次运行需要下载（用来算总进度，已装好的项不计入）
    pub needed: bool,
}

struct ItemRow {
    snap: ItemSnapshot,
    window: Window,
}

pub struct Progress {
    downloaded: AtomicU64,
    total: AtomicU64,
    window: Mutex<Window>,
    active: Mutex<BTreeMap<String, String>>,
    rows: Mutex<Vec<ItemRow>>,
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
            rows: Mutex::new(Vec::new()),
        })
    }

    /// 按清单顺序登记各项；已登记的保留原状态。
    pub fn register(&self, items: &[&Item]) {
        let Ok(mut rows) = self.rows.lock() else {
            return;
        };
        for item in items {
            if rows.iter().any(|r| r.snap.id == item.id) {
                continue;
            }
            rows.push(ItemRow {
                snap: ItemSnapshot {
                    id: item.id.clone(),
                    kind: item.kind.clone(),
                    size: item.size,
                    downloaded: 0,
                    bytes_per_sec: 0.0,
                    phase: Phase::Checking,
                    error: None,
                    optional: item.optional,
                    needed: false,
                },
                window: Window {
                    at: Instant::now(),
                    bytes: 0,
                    speed: 0.0,
                },
            });
        }
    }

    fn with_row(&self, id: &str, f: impl FnOnce(&mut ItemRow)) {
        if let Ok(mut rows) = self.rows.lock() {
            if let Some(row) = rows.iter_mut().find(|r| r.snap.id == id) {
                f(row);
            }
        }
    }

    /// 切换阶段。进入 Waiting 表示本次需要安装：清零字节与错误。
    pub fn set_phase(&self, id: &str, phase: Phase) {
        self.with_row(id, |row| {
            if phase == Phase::Waiting {
                row.snap.downloaded = 0;
                row.snap.needed = true;
                row.window = Window {
                    at: Instant::now(),
                    bytes: 0,
                    speed: 0.0,
                };
            }
            if phase != Phase::Failed && phase != Phase::Deferred {
                row.snap.error = None;
            }
            if phase == Phase::Done {
                row.snap.downloaded = row.snap.size;
            }
            row.snap.phase = phase;
        });
    }

    /// 记为失败（Failed 或 Deferred）并保存原始错误信息。
    pub fn fail(&self, id: &str, phase: Phase, error: &str) {
        self.with_row(id, |row| {
            row.snap.phase = phase;
            row.snap.error = Some(error.to_string());
        });
    }

    /// 某项新下了 n 字节（同时计入总量）。
    pub fn item_add(&self, id: &str, n: u64) {
        self.add(n);
        self.with_row(id, |row| row.snap.downloaded += n);
    }

    pub fn item_sub(&self, id: &str, n: u64) {
        self.sub(n);
        self.with_row(id, |row| {
            row.snap.downloaded = row.snap.downloaded.saturating_sub(n);
        });
    }

    /// 全部登记项的快照（含平滑后的单项速度）。
    pub fn items(&self) -> Vec<ItemSnapshot> {
        let Ok(mut rows) = self.rows.lock() else {
            return Vec::new();
        };
        rows.iter_mut()
            .map(|row| {
                let active = row.snap.phase == Phase::Downloading;
                row.snap.bytes_per_sec = if active {
                    tick(&mut row.window, row.snap.downloaded)
                } else {
                    0.0
                };
                row.snap.clone()
            })
            .collect()
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
            Ok(mut w) => tick(&mut w, downloaded),
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

/// 窗口满 0.5 秒才更新一次速度，并与上一窗口取平均，避免数字跳动。
fn tick(w: &mut Window, bytes: u64) -> f64 {
    let secs = w.at.elapsed().as_secs_f64();
    if secs >= SPEED_WINDOW_SECS {
        let instant = bytes.saturating_sub(w.bytes) as f64 / secs;
        w.speed = if w.speed == 0.0 {
            instant
        } else {
            (w.speed + instant) / 2.0
        };
        w.at = Instant::now();
        w.bytes = bytes;
    }
    w.speed
}
