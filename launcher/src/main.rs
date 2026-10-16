//! 启动器入口：双击后打开本机进度页，装好组件、起工作台服务并跳转过去。
//!
//! 环境变量（开发 / 联调用）：
//! - MINGZHI_APP_ROOT：应用根目录（默认 macOS ~/Library/Application Support/Mingzhi）
//! - MINGZHI_MANIFEST：用这个清单文件代替编译进来的清单（注意：清单版本号更高会抬高 data/data-version，之后低版本启动器会被挡住）
//! - MINGZHI_APP_DIR：用现成目录当应用本体（不下载 app 项）
//! - MINGZHI_NO_BROWSER=1：不自动打开浏览器，也不弹出错误对话框（只打印）
//!
//! 运行方式：macOS 由「明知AI剪辑.command」在终端里前台运行，Windows 是控制台程序（控制台子系统），
//! 窗口本身就是「运行中」的标志：关闭窗口（或 Ctrl+C）= 退出，由 `signal` 模块优雅收尾。

use mingzhi_launcher::app::{self, Info, Plan, Shared};
use mingzhi_launcher::browser;
use mingzhi_launcher::catalog::licenses;
use mingzhi_launcher::dataver;
use mingzhi_launcher::download::Downloader;
use mingzhi_launcher::errmap::friendly;
use mingzhi_launcher::error::{Error, Result};
use mingzhi_launcher::instance::{self, Acquire, InstanceGuard};
use mingzhi_launcher::manifest::{current_platform, Manifest};
use mingzhi_launcher::notify;
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::progress::Progress;
use mingzhi_launcher::proxy::ProxyConfig;
use mingzhi_launcher::server;
use mingzhi_launcher::signal;
use mingzhi_launcher::state::State;
use mingzhi_launcher::sysinfo::{low_spec_note, SystemSpec};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{mpsc, Arc, RwLock};
use std::time::Duration;

/// 编译进来的清单（见 build.rs）
const EMBEDDED_MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/manifest.json"));
/// 进度页端口起点（工作台服务从 4321 起，错开）
const UI_PORT: u16 = 4310;
/// 第二次双击时等主实例公布地址的最长时间
const SECONDARY_WAIT: Duration = Duration::from_secs(5);
/// Windows 上交接后窗口保留的时间
const HANDOFF_LINGER: Duration = Duration::from_secs(3);

fn load_manifest() -> Result<Manifest> {
    if let Some(path) = std::env::var_os("MINGZHI_MANIFEST") {
        return Manifest::load(&PathBuf::from(path));
    }
    // 锁定清单没有 version（由 build-manifest 补上），开发构建用启动器版本代替
    let mut value: serde_json::Value = serde_json::from_str(EMBEDDED_MANIFEST)
        .map_err(|e| Error::new(format!("内置清单损坏：{e}")))?;
    if value.get("version").is_none() {
        value["version"] = env!("CARGO_PKG_VERSION").into();
    }
    Manifest::parse(&value.to_string())
}

/// 抢单实例锁的结果。
enum Role {
    Primary(InstanceGuard),
    /// 已有启动器在运行，页面已交给它；本进程应以 `HANDOFF_EXIT_CODE` 退出
    HandedOff,
    /// 已有启动器但没有应答（已弹窗提示），本进程直接退出
    Unresponsive,
}

/// 抢单实例锁；已有启动器在运行时打开它的进度页（或提示）。
fn primary_or_hand_off(root: &AppRoot) -> Result<Role> {
    match instance::acquire(root.root(), SECONDARY_WAIT)? {
        Acquire::Primary(g) => Ok(Role::Primary(g)),
        Acquire::Secondary(Some(url)) => {
            open_page(&url);
            Ok(Role::HandedOff)
        }
        Acquire::Secondary(None) => {
            notify::alert(
                "明知AI剪辑 已经在运行",
                "已经有一个明知AI剪辑在启动中，但暂时没有响应。请等几秒再双击一次；一直这样的话，重启电脑后再试。",
            );
            Ok(Role::Unresponsive)
        }
    }
}

/// 启动提示（macOS 的 .command 自己先打印同一句，所以只有 Windows 在这里打印）。
const BANNER: &str = "明知AI剪辑正在启动，浏览器会自动打开；关闭这个窗口即可退出。";

fn run() -> Result<ExitCode> {
    signal::install();
    signal::spawn_watcher();
    if cfg!(windows) {
        signal::say(BANNER);
    }
    let root = AppRoot::resolve()?;
    let guard = match primary_or_hand_off(&root)? {
        Role::Primary(g) => g,
        Role::HandedOff => {
            signal::say(instance::HANDOFF_MESSAGE);
            if cfg!(windows) {
                // 控制台程序一退出窗口就关了：多留几秒让用户看到这句话
                std::thread::sleep(HANDOFF_LINGER);
            }
            return Ok(ExitCode::from(instance::HANDOFF_EXIT_CODE));
        }
        Role::Unresponsive => return Ok(ExitCode::SUCCESS),
    };

    let manifest = load_manifest()?;
    // 数据被更新版本用过时，旧启动器不碰它（只读检查；标记在服务启动成功后才更新，见 flow）
    dataver::check(&root, &manifest.version)?;
    let app_dir = std::env::var_os("MINGZHI_APP_DIR").map(PathBuf::from);
    let settings = Arc::new(RwLock::new(State::load(&root.state_file())?.settings()));
    let proxy = ProxyConfig::from_env();
    for w in proxy.warnings() {
        signal::say(&format!("提示：{w}"));
    }
    let progress = Progress::new();
    let downloader = Downloader::new(proxy, progress.clone()).with_settings(settings.clone());
    let plan = Arc::new(Plan {
        root: root.clone(),
        manifest,
        platform: current_platform().to_string(),
        app_dir,
        downloader: Arc::new(downloader),
    });
    let info = Info {
        version: plan.manifest.version.clone(),
        licenses: licenses(&plan.items()),
        low_spec: low_spec_note(&SystemSpec::detect()),
    };

    let (tx, rx) = mpsc::channel();
    let shared = Shared::new(progress, settings, root.state_file(), info, tx);
    let ui = server::start(shared.clone(), UI_PORT)?;
    guard.publish(&ui.url())?;
    signal::say(&format!("进度页：{}", ui.url()));
    open_page(&ui.url());

    // 主流程常驻；启动器退出时工作台服务随之退出
    signal::attach(shared.clone());
    app::run(shared, plan, rx);
    signal::mark_finished();
    drop(guard);
    Ok(ExitCode::SUCCESS)
}

/// 打开进度页；打不开浏览器时弹窗告诉用户手动访问的地址。
fn open_page(url: &str) {
    if let Err(e) = browser::open(url) {
        notify::alert(
            "请手动打开浏览器",
            &format!("没能自动打开浏览器（{e}）。请在浏览器地址栏输入：\n{url}"),
        );
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(e) => {
            // 进度页还没出来，用户看不到 stderr：弹窗说明原因与建议
            let f = friendly(&e.to_string());
            notify::alert(
                "明知AI剪辑 没能启动",
                &format!("{}\n\n{}\n\n详细信息：{}", f.title, f.hint, f.detail),
            );
            ExitCode::FAILURE
        }
    }
}
