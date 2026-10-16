//! 终端信号 → 优雅退出。启动器现在就是终端 / 控制台窗口里的前台进程：
//! Ctrl+C、关闭窗口、系统关机都应当让工作台服务体面收尾后一起退出。
//!
//! - Unix：SIGINT / SIGTERM / SIGHUP 的处理函数只置位一个原子标志（异步信号安全）
//! - Windows：SetConsoleCtrlHandler；Ctrl+C / Ctrl+Break 立即返回，关闭窗口 / 注销 / 关机事件
//!   会阻塞到主流程结束（系统最多再给 5 秒），随后进程被系统结束
//! - 监视线程发现标志后给主流程发 `Command::Quit`（停服务、结束主流程），
//!   等不到主流程结束就在宽限期后直接退出：服务的 stdin 随之关闭，看门狗 / Job Object 兜底

use crate::app::{Command, Shared, Stage};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

static REQUESTED: AtomicBool = AtomicBool::new(false);
static FINISHED: AtomicBool = AtomicBool::new(false);
/// 主流程的共享状态；`attach` 之前收到信号说明还没起服务，直接退出即可
static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

/// 等主流程收尾的最长时间（Windows 关闭窗口后系统只给约 5 秒）
#[cfg(windows)]
pub const GRACE: Duration = Duration::from_secs(4);
#[cfg(not(windows))]
pub const GRACE: Duration = Duration::from_secs(8);
/// 收到退出信号后停服务的宽限期：必须比 `GRACE` 短，这样服务没退出时由启动器强杀（连同进程组 / Job），
/// 而不是等 `GRACE` 到点后整个进程被直接结束
pub const SERVICE_STOP_GRACE: Duration = Duration::from_secs(GRACE.as_secs() - 1);

/// 是否收到了退出信号。
pub fn requested() -> bool {
    REQUESTED.load(Ordering::SeqCst)
}

/// 主流程已结束（让 Windows 的关闭窗口处理函数可以返回）。
pub fn mark_finished() {
    FINISHED.store(true, Ordering::SeqCst);
}

/// 写一行到 stderr，写失败（终端已断开、管道已关闭）直接忽略：
/// `eprintln!` 在写失败时会 panic，而信号路径上的 panic 会让启动器与服务变成孤儿进程。
pub fn say(msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// 装上信号处理函数。
pub fn install() {
    imp::install();
}

/// 主流程的共享状态建好之后调用，之后收到信号会通知主流程优雅退出。
pub fn attach(shared: Arc<Shared>) {
    let _ = SHARED.set(shared);
}

/// 起监视线程（尽早起，第二次双击等待期间也要能响应 Ctrl+C）：
/// 收到信号后先通知主流程退出，宽限期内没结束就直接退出进程。
pub fn spawn_watcher() {
    std::thread::spawn(|| {
        while !requested() {
            std::thread::sleep(Duration::from_millis(100));
        }
        // 先发 Quit 再写日志：终端断开后写日志可能失败或阻塞，不能挡住退出
        let Some(shared) = SHARED.get() else {
            // 还没建好主流程（正在抢单实例锁 / 等第一个实例应答），没有服务要收尾
            say("收到退出信号，退出明知AI剪辑。");
            std::process::exit(0);
        };
        shared.send(Command::Quit);
        say("收到退出信号，正在退出明知AI剪辑……");
        let deadline = Instant::now() + GRACE;
        // 下载中或服务启动中：没有需要优雅收尾的东西（.part 下次续传；服务靠 stdin 关闭 / Job Object 收尾），不必等
        while !FINISHED.load(Ordering::SeqCst)
            && !matches!(shared.stage(), Stage::Preparing | Stage::Starting)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        // 主流程已经结束时 main 会自己返回；这里只处理没来得及结束的情况
        std::process::exit(0);
    });
}

#[cfg(unix)]
mod imp {
    use super::{Ordering, REQUESTED};

    extern "C" fn on_signal(_sig: libc::c_int) {
        REQUESTED.store(true, Ordering::SeqCst);
    }

    pub fn install() {
        for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            // SAFETY：处理函数只做一次原子写，是异步信号安全的
            unsafe {
                libc::signal(
                    sig,
                    on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
                );
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{Ordering, FINISHED, GRACE, REQUESTED};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{BOOL, FALSE, TRUE};
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleCtrlHandler, SetConsoleMode, CTRL_BREAK_EVENT,
        CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
        ENABLE_EXTENDED_FLAGS, ENABLE_QUICK_EDIT_MODE, STD_INPUT_HANDLE,
    };

    unsafe extern "system" fn handler(kind: u32) -> BOOL {
        match kind {
            CTRL_C_EVENT | CTRL_BREAK_EVENT => {
                REQUESTED.store(true, Ordering::SeqCst);
                TRUE
            }
            CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => {
                REQUESTED.store(true, Ordering::SeqCst);
                // 这个函数一返回系统就结束进程，所以等主流程收尾（宽限期内）再返回
                let deadline = Instant::now() + GRACE;
                while !FINISHED.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(50));
                }
                TRUE
            }
            _ => FALSE,
        }
    }

    pub fn install() {
        disable_quick_edit();
        // SAFETY：handler 的签名与 PHANDLER_ROUTINE 一致，进程生命周期内一直有效
        unsafe {
            SetConsoleCtrlHandler(Some(handler), TRUE);
        }
    }

    /// 关掉控制台的「快速编辑」：用户在窗口里点一下，写 stdout/stderr 的线程就会被挂起直到按回车，
    /// 会挡住关窗口时的优雅退出。要保留 ENABLE_EXTENDED_FLAGS，否则设置不生效。没有控制台时静默跳过。
    fn disable_quick_edit() {
        // SAFETY：只读写当前进程标准输入句柄的控制台模式，失败就忽略
        unsafe {
            let stdin = GetStdHandle(STD_INPUT_HANDLE);
            let mut mode = 0u32;
            if GetConsoleMode(stdin, &mut mode) != 0 {
                SetConsoleMode(
                    stdin,
                    (mode & !ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS,
                );
            }
        }
    }
}
