//! 按清单把各项装到 AppRoot：跳过已装项，其余并发下载 → 校验 → 解包/落盘 → 记入 state。

use crate::download::Downloader;
use crate::error::{Context, Error, Result};
use crate::hash::sha256_file;
use crate::manifest::{Item, Manifest};
use crate::paths::AppRoot;
use crate::state::{Check, State};
use crate::unpack::unpack;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 同时下载的项数
pub const CONCURRENCY: usize = 2;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SyncReport {
    /// 本次新装（下载并落盘）的项 id
    pub installed: Vec<String>,
    /// 已装且一致、被跳过的项 id
    pub skipped: Vec<String>,
}

struct Job<'a> {
    item: &'a Item,
    dest: PathBuf,
}

/// 同步指定平台的全部清单项。任何一项失败则返回错误（其余已完成的项仍已记入 state）。
pub fn sync(
    root: &AppRoot,
    manifest: &Manifest,
    platform: &str,
    downloader: &Downloader,
) -> Result<SyncReport> {
    root.ensure_dirs()?;
    let state_path = root.state_file();
    let mut state = State::load(&state_path)?;
    let progress = downloader.progress();

    // 1. 判定哪些要装；需要算 sha 的大文件只在这里算一次
    let mut report = SyncReport::default();
    let mut jobs: VecDeque<Job> = VecDeque::new();
    for item in manifest.for_platform(platform) {
        let dest = item.resolve_dest(root, &manifest.version)?;
        let up_to_date = match state.check(item, &dest) {
            Check::UpToDate => true,
            Check::Missing => false,
            Check::NeedHash => {
                progress.set_active(&item.id, &format!("校验 {}", item.id));
                let same = sha256_file(&dest)?.eq_ignore_ascii_case(&item.sha256);
                progress.clear_active(&item.id);
                if same {
                    state = state.with_installed(&item.id, State::record_for(item, &dest));
                }
                same
            }
        };
        if up_to_date {
            report.skipped.push(item.id.clone());
        } else {
            jobs.push_back(Job { item, dest });
        }
    }
    state.save(&state_path)?;
    progress.set_total(jobs.iter().map(|j| j.item.size).sum());

    // 2. 并发安装
    let queue = Mutex::new(jobs);
    let shared = Mutex::new(state);
    let installed = Mutex::new(Vec::new());
    let errors = Mutex::new(Vec::new());
    let abort = AtomicBool::new(false);

    std::thread::scope(|scope| {
        for _ in 0..CONCURRENCY {
            scope.spawn(|| loop {
                if abort.load(Ordering::Relaxed) {
                    return;
                }
                let Some(job) = queue.lock().ok().and_then(|mut q| q.pop_front()) else {
                    return;
                };
                let outcome = install_one(root, &job, downloader).and_then(|()| {
                    // 每装完一项立即落盘，中途退出也不会丢进度
                    let mut guard = shared.lock().map_err(|_| Error::new("state 锁已损坏"))?;
                    *guard =
                        guard.with_installed(&job.item.id, State::record_for(job.item, &job.dest));
                    guard.save(&state_path)
                });
                match outcome {
                    Ok(()) => {
                        if let Ok(mut v) = installed.lock() {
                            v.push(job.item.id.clone());
                        }
                    }
                    Err(e) => {
                        abort.store(true, Ordering::Relaxed);
                        if let Ok(mut v) = errors.lock() {
                            v.push(e.to_string());
                        }
                    }
                }
            });
        }
    });

    report.installed = installed.into_inner().unwrap_or_default();
    let errors = errors.into_inner().unwrap_or_default();
    match errors.first() {
        Some(first) => Err(Error::new(first.clone())),
        None => Ok(report),
    }
}

fn install_one(root: &AppRoot, job: &Job, downloader: &Downloader) -> Result<()> {
    let item = job.item;
    let progress = downloader.progress();
    let part = root.downloads().join(item.part_name());

    progress.set_active(&item.id, &format!("下载 {}", item.id));
    let downloaded = downloader.download(item, &part);
    progress.clear_active(&item.id);
    downloaded?;

    progress.set_active(&item.id, &format!("安装 {}", item.id));
    let placed = place(item, &part, job);
    progress.clear_active(&item.id);
    placed
}

/// 把校验过的下载文件放到目标位置：解包项解包后删掉压缩包，其余直接 rename。
fn place(item: &Item, part: &std::path::Path, job: &Job) -> Result<()> {
    match item.unpack {
        Some(kind) => {
            unpack(part, kind, item.strip, &job.dest)?;
            fs::remove_file(part).ctx(format!("清理 {} 失败", part.display()))
        }
        None => {
            if let Some(dir) = job.dest.parent() {
                fs::create_dir_all(dir).ctx(format!("创建目录 {} 失败", dir.display()))?;
            }
            fs::rename(part, &job.dest).ctx(format!("移动到 {} 失败", job.dest.display()))
        }
    }
}
