//! 按清单把各项装到 AppRoot：跳过已装项，其余并发下载 → 校验 → 解包/落盘 → 记入 state。
//!
//! 调度约束：
//! - 目录嵌套：dest 落在另一项「整体替换型」dest 之内的项（chrome 在 app 目录里），
//!   必须等外层装完再装；外层被重装时，已装好的内层项会被强制重装（否则会被外层替换掉）。
//! - 配乐转码需要 data/bin/ffmpeg，所以排在 ffmpeg 之后。
//!
//! 失败处理：一项失败不影响其它项继续装；可选项（optional）失败只记入 `deferred`，
//! 不让整体失败；必需项失败在全部结束后返回第一条错误。逐项阶段写进 `Progress`。

use crate::download::Downloader;
use crate::error::{Context, Error, Result};
use crate::fsx;
use crate::hash::sha256_file;
use crate::manifest::{Item, Manifest, UnpackKind};
use crate::paths::AppRoot;
use crate::progress::Phase;
use crate::single::{extract_entry, set_executable, unpack_gz};
use crate::state::{Check, State};
use crate::unpack::{cleanup_stale, unpack};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

/// 同时下载的项数
pub const CONCURRENCY: usize = 2;

/// 解压总字节上限的下限（清单 size 太小时仍给足空间）
const MIN_UNPACK_BUDGET: u64 = 512 * 1024 * 1024;
/// 解压总字节上限 = 清单 size 的倍数
const UNPACK_RATIO: u64 = 20;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SyncReport {
    /// 本次新装（下载并落盘）的项 id
    pub installed: Vec<String>,
    /// 已装且一致、被跳过的项 id
    pub skipped: Vec<String>,
    /// 可选项下载/安装失败，已跳过（稍后在后台补齐）
    pub deferred: Vec<String>,
}

struct Job<'a> {
    item: &'a Item,
    dest: PathBuf,
    /// dest、entries、exec 全部会写入的路径
    footprint: Vec<PathBuf>,
}

impl Job<'_> {
    /// 是否有路径落在 `outer` 目录之内（不含 outer 自身）。
    fn nested_in(&self, outer: &Path) -> bool {
        self.footprint
            .iter()
            .any(|p| !same_path(p, outer) && starts_with_path(p, outer))
    }

    fn needs_ffmpeg(&self) -> bool {
        self.item.entries.iter().any(|e| e.transcode.is_some())
    }
}

/// Windows 文件系统默认大小写不敏感，路径比较时统一转小写；其它平台按原样。
fn fold(p: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    } else {
        p.to_path_buf()
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    fold(a) == fold(b)
}

fn starts_with_path(p: &Path, base: &Path) -> bool {
    fold(p).starts_with(fold(base))
}

/// 清单项处于「已装」状态时，entries 与 exec 输出也必须都在。
fn outputs_present(job: &Job) -> bool {
    job.footprint.iter().skip(1).all(|p| p.exists())
}

fn unpack_budget(item: &Item) -> u64 {
    item.size
        .saturating_mul(UNPACK_RATIO)
        .max(MIN_UNPACK_BUDGET)
}

/// 同步指定平台的全部清单项。必需项失败则返回错误（其余已完成的项仍已记入 state）。
pub fn sync(
    root: &AppRoot,
    manifest: &Manifest,
    platform: &str,
    downloader: &Downloader,
) -> Result<SyncReport> {
    sync_with(root, manifest, platform, downloader, |_| true)
}

/// 只同步满足 `filter` 的项（启动器先装必需项，服务起来后再补可选项）。
pub fn sync_with(
    root: &AppRoot,
    manifest: &Manifest,
    platform: &str,
    downloader: &Downloader,
    filter: impl Fn(&Item) -> bool,
) -> Result<SyncReport> {
    root.ensure_dirs()?;
    let state_path = root.state_file();
    let state = State::load(&state_path)?;
    let progress = downloader.progress();
    let items: Vec<&Item> = manifest
        .for_platform(platform)
        .into_iter()
        .filter(|i| filter(i))
        .collect();
    progress.register(&items);

    let mut jobs: Vec<Job> = Vec::new();
    for item in items {
        jobs.push(Job {
            item,
            dest: item.resolve_dest(root, &manifest.version)?,
            footprint: item.footprint(root, &manifest.version)?,
        });
    }
    // 清理上次崩溃遗留的临时目录
    let parents: HashSet<&Path> = jobs
        .iter()
        .flat_map(|j| j.footprint.iter().filter_map(|p| p.parent()))
        .collect();
    cleanup_stale(root.root());
    parents.into_iter().for_each(cleanup_stale);

    // 1. 判定哪些要装；需要算 sha 的大文件只在这里算一次
    let mut todo: Vec<bool> = Vec::with_capacity(jobs.len());
    let mut verified = Vec::new();
    for job in &jobs {
        let item = job.item;
        let up_to_date = match state.check(item, &job.dest) {
            Check::UpToDate => outputs_present(job),
            Check::Missing => false,
            Check::NeedHash => {
                progress.set_active(&item.id, &format!("校验 {}", item.id));
                let same = sha256_file(&job.dest)?.eq_ignore_ascii_case(&item.sha256);
                progress.clear_active(&item.id);
                if same {
                    verified.push((item.id.clone(), State::record_for(item, &job.dest)));
                }
                same
            }
        };
        todo.push(!up_to_date);
    }
    // 外层被重装时，内层已装项也要重装（外层替换目录会把它们带走）
    loop {
        let mut changed = false;
        for outer in 0..jobs.len() {
            if !todo[outer] || !jobs[outer].item.replaces_dir() {
                continue;
            }
            for inner in 0..jobs.len() {
                if inner != outer && !todo[inner] && jobs[inner].nested_in(&jobs[outer].dest) {
                    todo[inner] = true;
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    State::update(&state_path, |disk| {
        verified.iter().fold(disk.clone(), |s, (id, rec)| {
            s.with_installed(id, rec.clone())
        })
    })?;

    let mut report = SyncReport::default();
    let mut pending = Vec::new();
    for (i, job) in jobs.iter().enumerate() {
        if todo[i] {
            pending.push(i);
            progress.set_phase(&job.item.id, Phase::Waiting);
        } else {
            report.skipped.push(job.item.id.clone());
            progress.set_phase(&job.item.id, Phase::Ready);
        }
    }
    progress.set_total(pending.iter().map(|&i| jobs[i].item.size).sum());

    // 2. 依赖：嵌套在外层 dest 内、转码依赖 ffmpeg
    let ffmpeg = ffmpeg_path(root, platform);
    let deps: Vec<Vec<usize>> = (0..jobs.len())
        .map(|j| {
            pending
                .iter()
                .copied()
                .filter(|&i| {
                    i != j
                        && ((jobs[i].item.replaces_dir() && jobs[j].nested_in(&jobs[i].dest))
                            || (jobs[j].needs_ffmpeg() && same_path(&jobs[i].dest, &ffmpeg)))
                })
                .collect()
        })
        .collect();

    // 3. 并发安装
    let sched = Mutex::new(Sched {
        pending,
        done: HashSet::new(),
        running: 0,
    });
    let cv = Condvar::new();
    let installed = Mutex::new(Vec::new());
    let deferred = Mutex::new(Vec::new());
    let errors = Mutex::new(Vec::new());

    std::thread::scope(|scope| {
        for _ in 0..CONCURRENCY {
            scope.spawn(|| {
                while let Some(idx) = next_job(&sched, &cv, &deps) {
                    let job = &jobs[idx];
                    let id = &job.item.id;
                    let outcome = install_one(root, &manifest.version, &ffmpeg, job, downloader)
                        .and_then(|()| {
                            // 每装完一项立即落盘（读-改-写，不覆盖别处写入的设置）
                            let record = State::record_for(job.item, &job.dest);
                            State::update(&state_path, |s| s.with_installed(id, record)).map(|_| ())
                        });
                    let ok = outcome.is_ok();
                    match outcome {
                        Ok(()) => {
                            progress.set_phase(id, Phase::Done);
                            push(&installed, id.clone());
                        }
                        Err(e) => {
                            record_failure(job.item, &e.to_string(), progress, &deferred, &errors)
                        }
                    }
                    finish_job(&sched, &cv, idx, ok);
                }
            });
        }
    });

    // 依赖项失败而没能开始的项
    let left = sched.into_inner().map(|g| g.pending).unwrap_or_default();
    for idx in left {
        let msg = format!("{} 需要等前面的组件装好，本次没有安装", jobs[idx].item.id);
        record_failure(jobs[idx].item, &msg, progress, &deferred, &errors);
    }

    report.installed = installed.into_inner().unwrap_or_default();
    report.deferred = deferred.into_inner().unwrap_or_default();
    let errors = errors.into_inner().unwrap_or_default();
    match errors.first() {
        Some(first) => Err(Error::new(first.clone())),
        None => Ok(report),
    }
}

fn push(list: &Mutex<Vec<String>>, value: String) {
    if let Ok(mut v) = list.lock() {
        v.push(value);
    }
}

/// 可选项失败记为「稍后补齐」，必需项失败记为错误。
fn record_failure(
    item: &Item,
    msg: &str,
    progress: &crate::progress::Progress,
    deferred: &Mutex<Vec<String>>,
    errors: &Mutex<Vec<String>>,
) {
    if item.optional {
        progress.fail(&item.id, Phase::Deferred, msg);
        push(deferred, item.id.clone());
    } else {
        progress.fail(&item.id, Phase::Failed, msg);
        push(errors, msg.to_string());
    }
}

struct Sched {
    pending: Vec<usize>,
    done: HashSet<usize>,
    running: usize,
}

/// 取下一个依赖已满足的任务；没有可做的但还有任务在跑就等待；
/// 全部做完、或剩下的都依赖失败项时返回 None。
fn next_job(sched: &Mutex<Sched>, cv: &Condvar, deps: &[Vec<usize>]) -> Option<usize> {
    let mut g = sched.lock().ok()?;
    loop {
        if g.pending.is_empty() {
            return None;
        }
        let ready = g
            .pending
            .iter()
            .position(|&i| deps[i].iter().all(|d| g.done.contains(d)));
        if let Some(pos) = ready {
            g.running += 1;
            return Some(g.pending.remove(pos));
        }
        if g.running == 0 {
            return None; // 剩下的都依赖失败项，满足不了
        }
        g = cv.wait(g).ok()?;
    }
}

fn finish_job(sched: &Mutex<Sched>, cv: &Condvar, idx: usize, ok: bool) {
    if let Ok(mut g) = sched.lock() {
        g.running -= 1;
        if ok {
            g.done.insert(idx);
        }
    }
    cv.notify_all();
}

fn ffmpeg_path(root: &AppRoot, platform: &str) -> PathBuf {
    let name = if platform.starts_with("win32") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    root.data().join("bin").join(name)
}

fn install_one(
    root: &AppRoot,
    version: &str,
    ffmpeg: &Path,
    job: &Job,
    downloader: &Downloader,
) -> Result<()> {
    let item = job.item;
    let progress = downloader.progress();
    let part = root.downloads().join(item.part_name());

    progress.set_phase(&item.id, Phase::Downloading);
    progress.set_active(&item.id, &format!("下载 {}", item.id));
    let downloaded = downloader.download(item, &part);
    progress.clear_active(&item.id);
    downloaded?;

    progress.set_phase(&item.id, Phase::Installing);
    progress.set_active(&item.id, &format!("安装 {}", item.id));
    let placed = place(root, version, ffmpeg, job, &part);
    progress.clear_active(&item.id);
    placed
}

/// 把校验过的下载文件放到目标位置：解包项解包后删掉压缩包，其余直接 rename。
fn place(root: &AppRoot, version: &str, ffmpeg: &Path, job: &Job, part: &Path) -> Result<()> {
    let item = job.item;
    let budget = unpack_budget(item);
    match item.unpack {
        Some(UnpackKind::Gz) => unpack_gz(part, &job.dest, budget)?,
        Some(UnpackKind::Zip) if !item.entries.is_empty() => {
            for entry in &item.entries {
                let dest = item.resolve_entry(root, entry, version)?;
                extract_entry(
                    part,
                    &entry.entry,
                    &dest,
                    entry.transcode.as_deref(),
                    ffmpeg,
                    budget,
                )?;
                if item.executable {
                    set_executable(&dest)?;
                }
            }
        }
        Some(kind) => unpack(part, kind, item.strip, &job.dest, budget)?,
        None => {
            if let Some(dir) = job.dest.parent() {
                fs::create_dir_all(dir).ctx(format!("创建目录 {} 失败", dir.display()))?;
            }
            fsx::rename(part, &job.dest).ctx(format!("移动到 {} 失败", job.dest.display()))?;
        }
    }
    // 压缩包删不掉（杀软占用）不影响已装好的结果
    let _ = fsx::remove_file(part);

    if item.executable && item.entries.is_empty() {
        set_executable(&job.dest)?;
    }
    if let Some(exec) = item.resolve_exec(root, version)? {
        set_executable(&exec)?;
    }
    Ok(())
}
