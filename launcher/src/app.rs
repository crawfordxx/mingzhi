//! 启动器的共享状态（进度页读取）与主流程（控制线程）。
//!
//! 主流程：装必需项 → 起服务 → 进度页跳转 → 后台补可选项；
//! 失败停在「出错」等用户点重试，服务崩溃停在「已退出」等用户点重新启动。

use crate::catalog::{group_of, name_of, License};
use crate::download::Downloader;
use crate::errmap::{friendly, Friendly};
use crate::error::Result;
use crate::install::sync_with;
use crate::manifest::{Item, Manifest};
use crate::paths::AppRoot;
use crate::progress::{ItemSnapshot, Phase, Progress};
use crate::run::{service_spec, Service};
use crate::settings::{Mirror, Settings};
use crate::state::State;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// 可选项后台补齐失败后的等待间隔（之后一直按最后一个间隔重试）
const OPTIONAL_BACKOFF: [Duration; 3] = [
    Duration::from_secs(30),
    Duration::from_secs(120),
    Duration::from_secs(600),
];
const MONITOR_TICK: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// 检查 / 下载必需项
    Preparing,
    /// 必需项失败，等重试
    Failed,
    /// 起服务中
    Starting,
    /// 服务就绪，进度页跳转
    Running,
    /// 服务退出了，等重新启动
    Crashed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Retry,
    Restart,
    SettingsChanged,
}

#[derive(Debug, Clone)]
struct Status {
    stage: Stage,
    error: Option<Friendly>,
    url: Option<String>,
}

/// 页面上不变的信息。
#[derive(Debug, Clone, Default)]
pub struct Info {
    pub version: String,
    pub licenses: Vec<License>,
    pub low_spec: Option<String>,
}

pub struct Shared {
    pub progress: Arc<Progress>,
    pub settings: Arc<RwLock<Settings>>,
    state_path: PathBuf,
    status: Mutex<Status>,
    commands: Mutex<Sender<Command>>,
    info: Info,
    started: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemView {
    name: String,
    group: crate::catalog::Group,
    #[serde(flatten)]
    snap: ItemSnapshot,
    problem: Option<Friendly>,
}

#[derive(Serialize, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub size: u64,
    pub downloaded: u64,
    pub bytes_per_sec: f64,
    pub eta_secs: Option<u64>,
}

/// 只算本次需要下载的项；`optional` 选择算必需项还是可选项。
pub fn totals(items: &[ItemSnapshot], optional: bool) -> Totals {
    let mut t = Totals::default();
    for i in items.iter().filter(|i| i.needed && i.optional == optional) {
        t.size += i.size;
        t.downloaded += match i.phase {
            Phase::Done | Phase::Installing => i.size,
            _ => i.downloaded.min(i.size),
        };
        t.bytes_per_sec += i.bytes_per_sec;
    }
    let left = t.size.saturating_sub(t.downloaded);
    t.eta_secs =
        (t.bytes_per_sec >= 1.0 && left > 0).then(|| (left as f64 / t.bytes_per_sec).ceil() as u64);
    t
}

impl Shared {
    pub fn new(
        progress: Arc<Progress>,
        settings: Arc<RwLock<Settings>>,
        state_path: PathBuf,
        info: Info,
        commands: Sender<Command>,
    ) -> Arc<Self> {
        Arc::new(Self {
            progress,
            settings,
            state_path,
            status: Mutex::new(Status {
                stage: Stage::Preparing,
                error: None,
                url: None,
            }),
            commands: Mutex::new(commands),
            info,
            started: Instant::now(),
        })
    }

    fn set(&self, stage: Stage, error: Option<Friendly>, url: Option<String>) {
        if let Ok(mut s) = self.status.lock() {
            *s = Status { stage, error, url };
        }
    }

    pub fn stage(&self) -> Stage {
        self.status
            .lock()
            .map(|s| s.stage)
            .unwrap_or(Stage::Preparing)
    }

    pub fn url(&self) -> Option<String> {
        self.status.lock().ok().and_then(|s| s.url.clone())
    }

    pub fn send(&self, cmd: Command) {
        if let Ok(tx) = self.commands.lock() {
            let _ = tx.send(cmd);
        }
    }

    /// 校验、写入 state.json，并让正在进行的下载在下一次尝试时使用。
    pub fn save_settings(&self, mirror: Mirror, prefix: &str) -> Result<Settings> {
        let next = Settings::new(mirror, prefix)?;
        State::update(&self.state_path, |s| s.with_settings(&next))?;
        if let Ok(mut s) = self.settings.write() {
            *s = next.clone();
        }
        self.send(Command::SettingsChanged);
        Ok(next)
    }

    /// 进度页 /api/state 的内容。
    pub fn view(&self) -> serde_json::Value {
        let status = self.status.lock().map(|s| s.clone()).ok();
        let snaps = self.progress.items();
        let required = totals(&snaps, false);
        let optional = totals(&snaps, true);
        let items: Vec<ItemView> = snaps
            .into_iter()
            .map(|snap| ItemView {
                name: name_of(&snap.id),
                group: group_of(&snap.kind, snap.optional),
                problem: snap.error.as_deref().map(friendly),
                snap,
            })
            .collect();
        let settings = self.settings.read().map(|s| s.clone()).unwrap_or_default();
        serde_json::json!({
            "app": "明知AI剪辑",
            "version": self.info.version,
            "stage": status.as_ref().map(|s| s.stage).unwrap_or(Stage::Preparing),
            "error": status.as_ref().and_then(|s| s.error.clone()),
            "url": status.as_ref().and_then(|s| s.url.clone()),
            "items": items,
            "total": required,
            "optionalTotal": optional,
            "settings": settings,
            "lowSpec": self.info.low_spec,
            "licenses": self.info.licenses,
            "elapsedMs": self.started.elapsed().as_millis() as u64,
        })
    }
}

/// 主流程需要的上下文。
pub struct Plan {
    pub root: AppRoot,
    pub manifest: Manifest,
    pub platform: String,
    /// MINGZHI_APP_DIR：用现成目录当应用本体（不下载 app 项）
    pub app_dir: Option<PathBuf>,
    pub downloader: Arc<Downloader>,
}

impl Plan {
    /// 进度页上要列出的项（与平台相关；用现成应用目录时不含 app 项）。
    pub fn items(&self) -> Vec<&Item> {
        self.manifest
            .for_platform(&self.platform)
            .into_iter()
            .filter(|i| self.includes(i))
            .collect()
    }

    fn includes(&self, item: &Item) -> bool {
        !(self.app_dir.is_some() && item.kind == "app")
    }
}

/// 控制线程主循环；`rx` 收进度页的命令。永不返回（随进程结束）。
pub fn run(shared: Arc<Shared>, plan: Arc<Plan>, rx: Receiver<Command>) {
    shared.progress.register(&plan.items());
    let mut optional: Option<Sender<()>> = None;
    loop {
        shared.set(Stage::Preparing, None, None);
        let required = sync_with(
            &plan.root,
            &plan.manifest,
            &plan.platform,
            &plan.downloader,
            |i| plan.includes(i) && !i.optional,
        );
        if let Err(e) = required {
            shared.set(Stage::Failed, Some(friendly(&e.to_string())), None);
            wait_for(&rx, &[Command::Retry]);
            continue;
        }

        shared.set(Stage::Starting, None, None);
        let started = service_spec(
            &plan.root,
            &plan.manifest,
            &plan.platform,
            plan.app_dir.clone(),
        )
        .and_then(|spec| Service::start(&spec));
        let mut service = match started {
            Ok(s) => s,
            Err(e) => {
                shared.set(Stage::Crashed, Some(friendly(&e.to_string())), None);
                wait_for(&rx, &[Command::Restart, Command::Retry]);
                continue;
            }
        };
        shared.set(Stage::Running, None, Some(service.url().to_string()));
        eprintln!("工作台已就绪：{}", service.url());

        // 服务起来后在后台补可选项（只开一个后台线程）
        let kick = optional.get_or_insert_with(|| spawn_optional(plan.clone()));
        let _ = kick.send(());

        // 守着服务：崩溃 → 等重新启动；重试/改设置 → 催一下后台补齐
        loop {
            match rx.recv_timeout(MONITOR_TICK) {
                Ok(Command::Restart) => {
                    service.stop();
                    break;
                }
                Ok(Command::Retry | Command::SettingsChanged) => {
                    let _ = kick.send(());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if let Some(reason) = service.exited() {
                let mut problem = friendly(&reason);
                problem.title = format!("工作台意外退出了：{}", problem.title);
                shared.set(Stage::Crashed, Some(problem), None);
                wait_for(&rx, &[Command::Restart, Command::Retry]);
                break;
            }
        }
    }
}

/// 阻塞到收到指定命令之一；通道断开（进程退出中）时直接返回。
fn wait_for(rx: &Receiver<Command>, wanted: &[Command]) {
    while let Ok(cmd) = rx.recv() {
        if wanted.contains(&cmd) {
            return;
        }
    }
}

/// 后台补齐可选项：失败按间隔重试，收到「催一下」立即再试；全部装好后退出。
fn spawn_optional(plan: Arc<Plan>) -> Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut attempt = 0usize;
        loop {
            let report = sync_with(
                &plan.root,
                &plan.manifest,
                &plan.platform,
                &plan.downloader,
                |i| plan.includes(i) && i.optional,
            );
            if matches!(&report, Ok(r) if r.deferred.is_empty()) {
                return;
            }
            let wait = OPTIONAL_BACKOFF[attempt.min(OPTIONAL_BACKOFF.len() - 1)];
            attempt += 1;
            // 丢掉排队中的「催一下」，然后等下一轮
            while rx.try_recv().is_ok() {}
            match rx.recv_timeout(wait) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    tx
}
