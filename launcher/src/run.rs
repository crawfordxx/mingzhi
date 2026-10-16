//! 用内置 Node 起本机工作台服务：`node --import tsx src/server/index.ts`（cwd = 应用目录）。
//!
//! - 环境变量：MINGZHI_DATA_DIR=<AppRoot>/data、MINGZHI_PORT=4321、MINGZHI_CHROME=<Chrome 绝对路径>
//! - 端口被占用由服务自己顺延，实际地址从 stdout 的「明知AI剪辑 已启动：http://127.0.0.1:PORT」读取
//! - 就绪判定：GET /api/status 返回 200
//! - 启动器退出（含被强杀）时子进程跟着退出：子进程的 stdin 接在启动器上，
//!   额外 `--import` 一段看门狗代码，stdin 关闭（启动器没了）就退出。

use crate::error::{Error, Result};
use crate::manifest::Manifest;
use crate::paths::AppRoot;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 4321;
/// 首次启动 tsx 要编译源码，给足时间
pub const READY_TIMEOUT: Duration = Duration::from_secs(90);
const READY_MARK: &str = "已启动：";
const ENTRY: &str = "src/server/index.ts";
/// 看门狗：stdin 结束（启动器退出）即退出
const WATCHDOG: &str =
    "--import=data:text/javascript,process.stdin.on('end',()=>process.exit(0)).resume();";
/// 保留的子进程输出行数（崩溃时取原因）
const LOG_LINES: usize = 60;
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct ServiceSpec {
    pub node: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: Vec<(String, OsString)>,
    pub ready_timeout: Duration,
}

/// 就绪检查并拼出启动参数。`app_dir` 为 None 时用 `<AppRoot>/app/<版本>`。
pub fn service_spec(
    root: &AppRoot,
    manifest: &Manifest,
    platform: &str,
    app_dir: Option<PathBuf>,
) -> Result<ServiceSpec> {
    let items = manifest.for_platform(platform);
    let exec_of = |kind: &str| -> Result<Option<PathBuf>> {
        match items.iter().find(|i| i.kind == kind) {
            Some(item) => item.resolve_exec(root, &manifest.version),
            None => Ok(None),
        }
    };
    let node = exec_of("node")?
        .filter(|p| p.is_file())
        .ok_or_else(|| Error::new("Node 运行环境缺失，请点「重试」重新下载"))?;
    let cwd = app_dir.unwrap_or_else(|| root.app().join(&manifest.version));
    if !cwd.join(ENTRY).is_file() {
        return Err(Error::new(format!(
            "应用文件不完整（{} 下没有 {ENTRY}），请点「重试」重新下载",
            cwd.display()
        )));
    }
    let mut env: Vec<(String, OsString)> = vec![
        ("MINGZHI_DATA_DIR".into(), root.data().into_os_string()),
        ("MINGZHI_PORT".into(), DEFAULT_PORT.to_string().into()),
    ];
    if let Some(chrome) = exec_of("chrome")?.filter(|p| p.is_file()) {
        env.push(("MINGZHI_CHROME".into(), chrome.into_os_string()));
    }
    Ok(ServiceSpec {
        node,
        args: vec![
            "--import".into(),
            "tsx".into(),
            WATCHDOG.into(),
            ENTRY.into(),
        ],
        cwd,
        env,
        ready_timeout: READY_TIMEOUT,
    })
}

type Log = Arc<Mutex<VecDeque<String>>>;

pub struct Service {
    child: Child,
    stdin: Option<ChildStdin>,
    url: String,
    log: Log,
}

impl Service {
    /// 启动并等到就绪；失败时子进程已被结束，错误里带最后几行输出。
    pub fn start(spec: &ServiceSpec) -> Result<Service> {
        let mut cmd = Command::new(&spec.node);
        cmd.args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        hide_console(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| Error::new(format!("无法启动 Node（{}）：{e}", spec.node.display())))?;

        let log: Log = Arc::default();
        let (tx, rx) = mpsc::channel();
        if let Some(out) = child.stdout.take() {
            pump(out, log.clone(), Some(tx));
        }
        if let Some(err) = child.stderr.take() {
            pump(err, log.clone(), None);
        }
        let mut svc = Service {
            stdin: child.stdin.take(),
            child,
            url: String::new(),
            log,
        };
        let deadline = Instant::now() + spec.ready_timeout;
        match svc.wait_ready(&rx, deadline) {
            Ok(url) => {
                svc.url = url;
                Ok(svc)
            }
            Err(e) => {
                svc.stop();
                Err(e)
            }
        }
    }

    fn wait_ready(&mut self, rx: &mpsc::Receiver<String>, deadline: Instant) -> Result<String> {
        // 1. 等 stdout 里的地址
        let url = loop {
            if let Some(reason) = self.exited() {
                return Err(Error::new(format!("工作台服务启动失败：{reason}")));
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(url) => break url,
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(_) => {
                    // 通道断开（stdout 关闭）也可能是进程刚退出，再确认一次
                    std::thread::sleep(Duration::from_millis(100));
                    if let Some(reason) = self.exited() {
                        return Err(Error::new(format!("工作台服务启动失败：{reason}")));
                    }
                    if Instant::now() >= deadline {
                        return Err(self.timeout_error());
                    }
                }
            }
        };
        // 2. 等 /api/status 200（不走任何代理）
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(2))
            .build();
        let status = format!("{url}/api/status");
        loop {
            if let Some(reason) = self.exited() {
                return Err(Error::new(format!("工作台服务启动失败：{reason}")));
            }
            if matches!(agent.get(&status).call(), Ok(r) if r.status() == 200) {
                return Ok(url);
            }
            if Instant::now() >= deadline {
                return Err(self.timeout_error());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    fn timeout_error(&self) -> Error {
        Error::new(format!(
            "工作台服务没有在规定时间内启动。最后的输出：{}",
            self.tail(5)
        ))
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 子进程已退出时返回原因（退出码 + 最后几行输出），仍在运行返回 None。
    pub fn exited(&mut self) -> Option<String> {
        let status = self.child.try_wait().ok()??;
        // 给输出线程一点时间把最后几行读完
        std::thread::sleep(Duration::from_millis(50));
        let code = status
            .code()
            .map(|c| format!("退出码 {c}"))
            .unwrap_or_else(|| "被系统结束".to_string());
        Some(format!("{}（{code}）", self.tail(4)))
    }

    /// 最后 n 行输出，优先挑带错误字样的行。
    fn tail(&self, n: usize) -> String {
        let log = self.log.lock().map(|l| l.clone()).unwrap_or_default();
        let errors: Vec<&String> = log
            .iter()
            .filter(|l| {
                let lower = l.to_lowercase();
                lower.contains("error") || l.contains("失败") || l.contains("错误")
            })
            .collect();
        let pick: Vec<&String> = if errors.is_empty() {
            log.iter().collect()
        } else {
            errors
        };
        let start = pick.len().saturating_sub(n);
        let text = pick[start..]
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        if text.is_empty() {
            "没有输出".to_string()
        } else {
            text
        }
    }

    /// 结束子进程：先关 stdin 让看门狗正常退出，等一会儿还在就强制结束。
    pub fn stop(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + STOP_GRACE;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            self.stop();
        }
    }
}

/// 逐行读子进程输出存进环形日志；stdout 那一路发现启动地址就发给 `tx`。
fn pump(stream: impl Read + Send + 'static, log: Log, tx: Option<mpsc::Sender<String>>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.split(b'\n').map_while(|l| l.ok()) {
            let line = String::from_utf8_lossy(&line).trim_end().to_string();
            if let (Some(tx), Some(url)) = (&tx, parse_ready(&line)) {
                let _ = tx.send(url);
            }
            if let Ok(mut l) = log.lock() {
                if l.len() >= LOG_LINES {
                    l.pop_front();
                }
                l.push_back(line);
            }
        }
    });
}

/// 「明知AI剪辑 已启动：http://127.0.0.1:4321」→ 地址；只接受本机地址。
pub fn parse_ready(line: &str) -> Option<String> {
    let (_, rest) = line.split_once(READY_MARK)?;
    let url = rest.trim().trim_end_matches('/');
    let port = url
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| url.strip_prefix("http://localhost:"))?;
    port.parse::<u16>().ok()?;
    Some(url.to_string())
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}
