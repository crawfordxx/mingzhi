//! 主流程（控制线程）：装必需项 → 起服务 → 进度页跳转 → 后台补可选项；
//! 失败停在「出错」等用户点重试，服务崩溃停在「已退出」等用户点重新启动；
//! 服务以退出码 0 退出（用户在工作台里主动退出）或收到 Quit（终端信号）时结束，启动器随之退出。

use crate::app::{Command, Plan, Shared, Stage};
use crate::errmap::{friendly, Friendly, Kind};
use crate::install::sync_with;
use crate::run::{service_spec, Service};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

/// 可选项后台补齐失败后的等待间隔（之后一直按最后一个间隔重试）
const OPTIONAL_BACKOFF: [Duration; 3] = [
    Duration::from_secs(30),
    Duration::from_secs(120),
    Duration::from_secs(600),
];
const MONITOR_TICK: Duration = Duration::from_millis(300);

/// 一步的结果：继续往下走 / 回到开头重来 / 结束主循环。
enum Flow<T> {
    Next(T),
    Again,
    Exit,
}

/// 控制线程主循环；`rx` 收进度页的命令。
/// 服务以退出码 0 退出（用户在工作台里主动退出）或命令通道断开时返回，启动器随之退出。
pub fn run(shared: Arc<Shared>, plan: Arc<Plan>, rx: Receiver<Command>) {
    shared.progress.register(&plan.items());
    let mut optional: Option<Sender<()>> = None;
    loop {
        let flow = prepare(&shared, &plan, &rx).and(|| start_service(&shared, &plan, &rx));
        let mut service = match flow {
            Flow::Next(s) => s,
            Flow::Again => continue,
            Flow::Exit => return,
        };
        // 服务起来后在后台补可选项（只开一个后台线程）
        let kick = optional.get_or_insert_with(|| spawn_optional(plan.clone()));
        let _ = kick.send(());
        match watch(&shared, &mut service, &rx, kick) {
            Flow::Next(()) | Flow::Again => continue,
            Flow::Exit => return,
        }
    }
}

impl Flow<()> {
    fn and<T>(self, next: impl FnOnce() -> Flow<T>) -> Flow<T> {
        match self {
            Flow::Next(()) => next(),
            Flow::Again => Flow::Again,
            Flow::Exit => Flow::Exit,
        }
    }

    /// 等到了用户的命令 → 回到开头重来；通道断开 → 结束。
    fn retry_or_exit<T>(self) -> Flow<T> {
        match self {
            Flow::Exit => Flow::Exit,
            _ => Flow::Again,
        }
    }
}

/// 装必需项；失败时停在「出错」等重试。
fn prepare(shared: &Shared, plan: &Plan, rx: &Receiver<Command>) -> Flow<()> {
    shared.set(Stage::Preparing, None, None);
    let required = sync_with(
        &plan.root,
        &plan.manifest,
        &plan.platform,
        &plan.downloader,
        |i| plan.includes(i) && !i.optional,
    );
    match required {
        Ok(_) => {
            // 必需项都装好了再清理旧版本（失败时旧的可能还要回退用）
            for dir in crate::prune::prune(&plan.root, &plan.manifest, &plan.platform) {
                crate::signal::say(&format!("已清理旧版本：{}", dir.display()));
            }
            Flow::Next(())
        }
        Err(e) => {
            shared.set(Stage::Failed, Some(friendly(&e.to_string())), None);
            wait_for(rx, &[Command::Retry])
        }
    }
}

/// 起服务；失败时停在「已退出」等重新启动。
fn start_service(shared: &Shared, plan: &Plan, rx: &Receiver<Command>) -> Flow<Service> {
    shared.set(Stage::Starting, None, None);
    let started = service_spec(
        &plan.root,
        &plan.manifest,
        &plan.platform,
        plan.app_dir.clone(),
    )
    .and_then(|spec| Service::start(&spec));
    match started {
        Ok(service) => {
            shared.set(Stage::Running, None, Some(service.url().to_string()));
            crate::signal::say(&format!("工作台已就绪：{}", service.url()));
            Flow::Next(service)
        }
        Err(e) => {
            shared.set(Stage::Crashed, Some(friendly(&e.to_string())), None);
            wait_for(rx, &[Command::Restart, Command::Retry]).retry_or_exit()
        }
    }
}

/// 守着服务：用户主动退出 → 结束；崩溃 → 等重新启动；重试 / 改设置 → 催一下后台补齐。
fn watch(
    shared: &Shared,
    service: &mut Service,
    rx: &Receiver<Command>,
    kick: &Sender<()>,
) -> Flow<()> {
    loop {
        match rx.recv_timeout(MONITOR_TICK) {
            Ok(Command::Restart) => {
                service.stop();
                return Flow::Again;
            }
            Ok(Command::Quit) => {
                crate::signal::say("正在停止工作台服务……");
                service.stop_within(crate::signal::SERVICE_STOP_GRACE);
                return Flow::Exit;
            }
            Ok(Command::Retry | Command::SettingsChanged) => {
                let _ = kick.send(());
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Flow::Exit,
        }
        let Some(exit) = service.exited() else {
            continue;
        };
        if exit.is_user_quit() {
            crate::signal::say("工作台已退出（用户主动退出），启动器随之退出");
            return Flow::Exit;
        }
        shared.set(Stage::Crashed, Some(crash_problem(&exit.reason)), None);
        return wait_for(rx, &[Command::Restart, Command::Retry]).retry_or_exit();
    }
}

fn crash_problem(reason: &str) -> Friendly {
    let mut problem = friendly(reason);
    problem.title = match problem.kind {
        Kind::Other => "工作台意外退出了".to_string(),
        _ => format!("工作台意外退出了：{}", problem.title),
    };
    problem
}

/// 阻塞到收到指定命令之一，然后丢掉排队中的陈旧命令（例如连点两次「重新启动」）；
/// 通道断开（进程退出中）返回 Exit。
fn wait_for(rx: &Receiver<Command>, wanted: &[Command]) -> Flow<()> {
    while let Ok(cmd) = rx.recv() {
        if cmd == Command::Quit {
            return Flow::Exit;
        }
        if wanted.contains(&cmd) {
            while rx.try_recv().is_ok() {}
            return Flow::Next(());
        }
    }
    Flow::Exit
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
