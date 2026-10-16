//! 终端信号 → 优雅退出。启动器现在就是终端 / 控制台窗口里的前台进程：
//! Ctrl+C、关闭窗口、系统关机都应当让工作台服务体面收尾后一起退出。
//!
//! - Unix：SIGINT / SIGTERM / SIGHUP 的处理函数只置位一个原子标志（异步信号安全）
//! - Windows：SetConsoleCtrlHandler；Ctrl+C / Ctrl+Break 立即返回，关闭窗口 / 注销 / 关机事件
//!   会阻塞到主流程结束（系统最多再给 5 秒），随后进程被系统结束
//! - 监视线程发现标志后给主流程发 `Command::Quit`（停服务、结束主流程），
//!   等不到主流程结束就在宽限期后直接退出：服务的 stdin 随之关闭，看门狗 / Job Object 兜底

use crate::app::{Command, Shared, Stage};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

static REQUESTED: AtomicBool = AtomicBool::new(false);
static FINISHED: AtomicBool = AtomicBool::new(false);

/// 等主流程收尾的最长时间（Windows 关闭窗口后系统只给约 5 秒）
#[cfg(windows)]
pub const GRACE: Duration = Duration::from_secs(4);
#[cfg(not(windows))]
pub const GRACE: Duration = Duration::from_secs(8);

/// 是否收到了退出信号。
pub fn requested() -> bool {
    REQUESTED.load(Ordering::SeqCst)
}

/// 主流程已结束（让 Windows 的关闭窗口处理函数可以返回）。
pub fn mark_finished() {
    FINISHED.store(true, Ordering::SeqCst);
}

/// 装上信号处理函数。
pub fn install() {
    imp::install();
}

/// 起监视线程：收到信号后通知主流程退出，宽限期内没结束就直接退出进程。
pub fn spawn_watcher(shared: Arc<Shared>) {
    std::thread::spawn(move || {
        while !requested() {
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("收到退出信号，正在退出明知AI剪辑……");
        shared.send(Command::Quit);
        let deadline = Instant::now() + GRACE;
        // 还在下载（没有服务进程）时没什么需要收尾的，.part 文件下次会续传，不必等
        while !FINISHED.load(Ordering::SeqCst)
            && shared.stage() != Stage::Preparing
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
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT,
        CTRL_SHUTDOWN_EVENT,
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
        // SAFETY：handler 的签名与 PHANDLER_ROUTINE 一致，进程生命周期内一直有效
        unsafe {
            SetConsoleCtrlHandler(Some(handler), TRUE);
        }
    }
}
