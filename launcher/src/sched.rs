//! 安装任务调度：按依赖取下一个可做的任务；收集各项结果（已装 / 稍后补齐 / 错误）。

use crate::install::SyncReport;
use crate::manifest::Item;
use crate::progress::{Phase, Progress};
use std::collections::HashSet;
use std::sync::{Condvar, Mutex};

pub struct Sched {
    pending: Mutex<Pending>,
    cv: Condvar,
    deps: Vec<Vec<usize>>,
}

struct Pending {
    left: Vec<usize>,
    done: HashSet<usize>,
    running: usize,
}

impl Sched {
    /// `pending`：要装的任务下标；`deps[i]`：任务 i 依赖的任务下标。
    pub fn new(pending: Vec<usize>, deps: Vec<Vec<usize>>) -> Self {
        Self {
            pending: Mutex::new(Pending {
                left: pending,
                done: HashSet::new(),
                running: 0,
            }),
            cv: Condvar::new(),
            deps,
        }
    }

    /// 取下一个依赖已满足的任务；没有可做的但还有任务在跑就等待；
    /// 全部做完、或剩下的都依赖失败项时返回 None。
    pub fn next(&self) -> Option<usize> {
        let mut g = self.pending.lock().ok()?;
        loop {
            if g.left.is_empty() {
                return None;
            }
            let ready = g
                .left
                .iter()
                .position(|&i| self.deps[i].iter().all(|d| g.done.contains(d)));
            if let Some(pos) = ready {
                g.running += 1;
                return Some(g.left.remove(pos));
            }
            if g.running == 0 {
                return None; // 剩下的都依赖失败项，满足不了
            }
            g = self.cv.wait(g).ok()?;
        }
    }

    pub fn finish(&self, idx: usize, ok: bool) {
        if let Ok(mut g) = self.pending.lock() {
            g.running -= 1;
            if ok {
                g.done.insert(idx);
            }
        }
        self.cv.notify_all();
    }

    /// 结束后仍没开始的任务（依赖项失败）。
    pub fn leftover(self) -> Vec<usize> {
        self.pending
            .into_inner()
            .map(|g| g.left)
            .unwrap_or_default()
    }
}

/// 各项结果，多个安装线程共用。
#[derive(Default)]
pub struct Outcomes {
    installed: Mutex<Vec<String>>,
    deferred: Mutex<Vec<String>>,
    errors: Mutex<Vec<String>>,
}

fn push(list: &Mutex<Vec<String>>, value: String) {
    if let Ok(mut v) = list.lock() {
        v.push(value);
    }
}

impl Outcomes {
    pub fn installed(&self, item: &Item, progress: &Progress) {
        progress.set_phase(&item.id, Phase::Done);
        push(&self.installed, item.id.clone());
    }

    /// 可选项失败记为「稍后补齐」，必需项失败记为错误。
    pub fn failed(&self, item: &Item, msg: &str, progress: &Progress) {
        if item.optional {
            progress.fail(&item.id, Phase::Deferred, msg);
            push(&self.deferred, item.id.clone());
        } else {
            progress.fail(&item.id, Phase::Failed, msg);
            push(&self.errors, msg.to_string());
        }
    }

    /// 汇总；有必需项失败时返回第一条错误。
    pub fn into_report(self, skipped: Vec<String>) -> Result<SyncReport, String> {
        let errors = self.errors.into_inner().unwrap_or_default();
        if let Some(first) = errors.into_iter().next() {
            return Err(first);
        }
        Ok(SyncReport {
            installed: self.installed.into_inner().unwrap_or_default(),
            skipped,
            deferred: self.deferred.into_inner().unwrap_or_default(),
        })
    }
}
