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
use crate::progress::{Phase, Progress};
use crate::sched::{Outcomes, Sched};
use crate::single::{extract_entry, set_executable, unpack_gz};
use crate::state::{Check, State};
use crate::unpack::{cleanup_stale, unpack};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

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
    let progress = downloader.progress();
    let items: Vec<&Item> = manifest
        .for_platform(platform)
        .into_iter()
        .filter(|i| filter(i))
        .collect();
    progress.register(&items);
    let jobs = build_jobs(root, &manifest.version, &items)?;
    cleanup_leftovers(root, &jobs);

    let todo = decide(root, &jobs, progress)?;
    let mut pending = Vec::new();
    let mut skipped = Vec::new();
    for (i, job) in jobs.iter().enumerate() {
        if todo[i] {
            pending.push(i);
            progress.set_phase(&job.item.id, Phase::Waiting);
        } else {
            skipped.push(job.item.id.clone());
            progress.set_phase(&job.item.id, Phase::Ready);
        }
    }
    progress.set_total(pending.iter().map(|&i| jobs[i].item.size).sum());

    let ctx = Ctx {
        root,
        version: &manifest.version,
        ffmpeg: ffmpeg_path(root, platform),
        downloader,
    };
    let deps = dependencies(&jobs, &pending, &ctx.ffmpeg);
    let outcomes = install_all(&ctx, &jobs, Sched::new(pending, deps));
    outcomes.into_report(skipped).map_err(Error::new)
}

/// 安装阶段共用的上下文。
struct Ctx<'a> {
    root: &'a AppRoot,
    version: &'a str,
    ffmpeg: PathBuf,
    downloader: &'a Downloader,
}

fn build_jobs<'a>(root: &AppRoot, version: &str, items: &[&'a Item]) -> Result<Vec<Job<'a>>> {
    items
        .iter()
        .map(|&item| {
            Ok(Job {
                item,
                dest: item.resolve_dest(root, version)?,
                footprint: item.footprint(root, version)?,
            })
        })
        .collect()
}

/// 清理上次崩溃遗留的临时目录。
fn cleanup_leftovers(root: &AppRoot, jobs: &[Job]) {
    let parents: HashSet<&Path> = jobs
        .iter()
        .flat_map(|j| j.footprint.iter().filter_map(|p| p.parent()))
        .collect();
    cleanup_stale(root.root());
    parents.into_iter().for_each(cleanup_stale);
}

/// 判定哪些要装（需要算 sha 的大文件只在这里算一次，确认一致的补记进 state）。
fn decide(root: &AppRoot, jobs: &[Job], progress: &Progress) -> Result<Vec<bool>> {
    let state = State::load(&root.state_file())?;
    let mut todo = Vec::with_capacity(jobs.len());
    let mut verified = Vec::new();
    for job in jobs {
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
    force_nested(jobs, &mut todo);
    State::update(&root.state_file(), |disk| {
        verified.iter().fold(disk.clone(), |s, (id, rec)| {
            s.with_installed(id, rec.clone())
        })
    })?;
    Ok(todo)
}

/// 外层被重装时，内层已装项也要重装（外层替换目录会把它们带走）。
fn force_nested(jobs: &[Job], todo: &mut [bool]) {
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
            return;
        }
    }
}

/// 依赖：嵌套在外层 dest 内的等外层；转码的等 ffmpeg。
fn dependencies(jobs: &[Job], pending: &[usize], ffmpeg: &Path) -> Vec<Vec<usize>> {
    (0..jobs.len())
        .map(|j| {
            pending
                .iter()
                .copied()
                .filter(|&i| {
                    i != j
                        && ((jobs[i].item.replaces_dir() && jobs[j].nested_in(&jobs[i].dest))
                            || (jobs[j].needs_ffmpeg() && same_path(&jobs[i].dest, ffmpeg)))
                })
                .collect()
        })
        .collect()
}

/// 并发安装；依赖项失败而没能开始的项也记为失败。
fn install_all(ctx: &Ctx, jobs: &[Job], sched: Sched) -> Outcomes {
    let outcomes = Outcomes::default();
    let progress = ctx.downloader.progress();
    std::thread::scope(|scope| {
        for _ in 0..CONCURRENCY {
            scope.spawn(|| {
                while let Some(idx) = sched.next() {
                    let ok = install_and_record(ctx, &jobs[idx], &outcomes);
                    sched.finish(idx, ok);
                }
            });
        }
    });
    for idx in sched.leftover() {
        let msg = format!("{} 需要等前面的组件装好，本次没有安装", jobs[idx].item.id);
        outcomes.failed(jobs[idx].item, &msg, progress);
    }
    outcomes
}

fn install_and_record(ctx: &Ctx, job: &Job, outcomes: &Outcomes) -> bool {
    let progress = ctx.downloader.progress();
    let outcome =
        install_one(ctx.root, ctx.version, &ctx.ffmpeg, job, ctx.downloader).and_then(|()| {
            // 每装完一项立即落盘（读-改-写，不覆盖别处写入的设置）
            let record = State::record_for(job.item, &job.dest);
            State::update(&ctx.root.state_file(), |s| {
                s.with_installed(&job.item.id, record)
            })
            .map(|_| ())
        });
    match outcome {
        Ok(()) => {
            outcomes.installed(job.item, progress);
            true
        }
        Err(e) => {
            outcomes.failed(job.item, &e.to_string(), progress);
            false
        }
    }
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
