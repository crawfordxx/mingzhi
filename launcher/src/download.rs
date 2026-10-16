//! 下载：`.part` 文件 + HTTP Range 续传 + sha256 校验 + 多镜像回退。
//!
//! 策略（每个镜像最多 `max_attempts` 次，默认 3）：
//! - 4xx（404/403 等）：该镜像没有这个文件，立刻换下一个镜像；
//! - 网络错误 / 5xx / 429：保留 .part，稍等后续传重试；
//! - 下载完成但大小或 sha256 不符：删除 .part，从头重下；
//! - 服务器无视 Range 直接回 200：从头写，不会把内容接错；
//! - 连续 45 秒收不到数据（含连上后迟迟不回应）：换下一个地址，已下部分在新地址续传。
//!
//! 地址顺序与 GitHub 代理前缀来自共享的 `Settings`，进度页改了设置，下一项/下一次重试即生效。

use crate::error::{Context, Error, Result};
use crate::hash::sha256_file;
use crate::manifest::Item;
use crate::progress::Progress;
use crate::proxy::{redact, ProxyConfig};
use crate::settings::Settings;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::Duration;

const USER_AGENT: &str = concat!("mingzhi-launcher/", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 无数据超时：这么久收不到一个字节就换下一个地址（jsDelivr 等偶发卡死）
const STALL_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_MAX_ATTEMPTS: usize = 3;
const DEFAULT_RETRY_DELAY: Duration = Duration::from_secs(2);

/// 单次抓取失败后的处理方式。
enum FetchError {
    /// 临时故障，同一镜像续传重试
    Retry(String),
    /// 该镜像无法提供，换下一个
    NextMirror(String),
}

pub struct Downloader {
    proxy: ProxyConfig,
    progress: Arc<Progress>,
    max_attempts: usize,
    retry_delay: Duration,
    stall_timeout: Duration,
    settings: Arc<RwLock<Settings>>,
}

impl Downloader {
    pub fn new(proxy: ProxyConfig, progress: Arc<Progress>) -> Self {
        Self {
            proxy,
            progress,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            retry_delay: DEFAULT_RETRY_DELAY,
            stall_timeout: STALL_TIMEOUT,
            settings: Arc::default(),
        }
    }

    /// 调整无数据超时（测试里设得很短）。
    pub fn with_stall_timeout(mut self, timeout: Duration) -> Self {
        self.stall_timeout = timeout;
        self
    }

    /// 共享的下载设置（镜像顺序、GitHub 代理前缀）。
    pub fn with_settings(mut self, settings: Arc<RwLock<Settings>>) -> Self {
        self.settings = settings;
        self
    }

    /// 调整重试间隔（测试里设为 0）。
    pub fn with_retry_delay(mut self, delay: Duration) -> Self {
        self.retry_delay = delay;
        self
    }

    pub fn progress(&self) -> &Arc<Progress> {
        &self.progress
    }

    /// 把 `item` 下载到 `part`，成功返回时该文件已通过大小与 sha256 校验。
    pub fn download(&self, item: &Item, part: &Path) -> Result<()> {
        if let Some(dir) = part.parent() {
            fs::create_dir_all(dir).ctx(format!("创建目录 {} 失败", dir.display()))?;
        }
        let mut counted = 0u64; // 已计入进度的 .part 字节数
        let mut failures: Vec<String> = Vec::new();
        let urls = self
            .settings
            .read()
            .map(|s| s.urls_for(&item.urls))
            .unwrap_or_else(|_| item.urls.clone());
        let id = item.id.as_str();

        for url in &urls {
            for attempt in 1..=self.max_attempts {
                if attempt > 1 {
                    std::thread::sleep(self.retry_delay * (attempt as u32 - 1));
                }
                // 与磁盘上的 .part 对齐（上次运行遗留的续传数据也要计入进度）
                let len = file_len(part);
                if len > item.size {
                    self.discard(id, part, &mut counted)?;
                } else {
                    self.reconcile(id, &mut counted, len);
                }

                if file_len(part) != item.size {
                    match self.fetch(id, url, item.size, part, &mut counted) {
                        Ok(()) => {}
                        Err(FetchError::NextMirror(msg)) => {
                            failures.push(format!("{url}：{msg}"));
                            break;
                        }
                        Err(FetchError::Retry(msg)) => {
                            failures.push(format!("{url}：{msg}"));
                            continue;
                        }
                    }
                }

                // 连接被对端提前关闭时 ureq 不一定报错，数据不足就保留 .part 续传
                if file_len(part) < item.size {
                    failures.push(format!("{url}：连接提前结束，稍后续传"));
                    continue;
                }

                if self.verify(item, part)? {
                    return Ok(());
                }
                failures.push(format!("{url}：下载完成但校验不符，已删除重下"));
                self.discard(id, part, &mut counted)?;
            }
        }

        let detail = redact(&failures.last().cloned().unwrap_or_default());
        let mut msg = format!(
            "{} 下载失败，所有镜像均不可用（最后一次：{detail}）",
            item.id
        );
        for w in self.proxy.warnings() {
            msg.push('；');
            msg.push_str(w);
        }
        Err(Error::new(msg))
    }

    /// 大小与 sha256 是否与清单一致。
    fn verify(&self, item: &Item, part: &Path) -> Result<bool> {
        if file_len(part) != item.size {
            return Ok(false);
        }
        Ok(sha256_file(part)?.eq_ignore_ascii_case(&item.sha256))
    }

    fn discard(&self, id: &str, part: &Path, counted: &mut u64) -> Result<()> {
        match fs::remove_file(part) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::new(format!("删除 {} 失败：{e}", part.display()))),
        }
        self.reconcile(id, counted, 0);
        Ok(())
    }

    /// 让「已计入进度的字节」与 .part 实际长度一致。
    fn reconcile(&self, id: &str, counted: &mut u64, actual: u64) {
        if actual > *counted {
            self.progress.item_add(id, actual - *counted);
        } else {
            self.progress.item_sub(id, *counted - actual);
        }
        *counted = actual;
    }

    fn agent_for(&self, url: &str) -> Result<ureq::Agent> {
        let mut builder = ureq::AgentBuilder::new()
            .user_agent(USER_AGENT)
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout_read(self.stall_timeout);
        if let Some(p) = self.proxy.proxy_for(url) {
            builder =
                builder.proxy(ureq::Proxy::new(p).ctx(format!("代理地址 {} 不可用", redact(p)))?);
        }
        Ok(builder.build())
    }

    /// 向一个镜像请求一次，从 .part 现有长度处续传。
    fn fetch(
        &self,
        id: &str,
        url: &str,
        limit: u64,
        part: &Path,
        counted: &mut u64,
    ) -> std::result::Result<(), FetchError> {
        let agent = self
            .agent_for(url)
            .map_err(|e| FetchError::NextMirror(e.to_string()))?;
        let offset = file_len(part);
        let mut req = agent.get(url);
        if offset > 0 {
            req = req.set("Range", &format!("bytes={offset}-"));
        }

        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(416, _)) => {
                // 本地 .part 与服务器对不上，丢弃后重来
                let _ = self.discard(id, part, counted);
                return Err(FetchError::Retry("服务器拒绝续传范围（416）".into()));
            }
            Err(ureq::Error::Status(code, _)) if code == 408 || code == 429 || code >= 500 => {
                return Err(FetchError::Retry(format!("服务器返回 {code}")));
            }
            Err(ureq::Error::Status(code, _)) => {
                return Err(FetchError::NextMirror(format!("服务器返回 {code}")))
            }
            Err(ureq::Error::Transport(t)) if is_timeout(&t) => {
                return Err(FetchError::NextMirror(self.stall_message()))
            }
            Err(ureq::Error::Transport(t)) => {
                return Err(FetchError::Retry(format!("网络错误：{t}")))
            }
        };

        let resume = match resp.status() {
            206 => {
                let range = resp.header("Content-Range").and_then(parse_content_range);
                if range.map(|r| r.0) != Some(offset) {
                    let _ = self.discard(id, part, counted);
                    return Err(FetchError::Retry("续传位置与服务器不一致".into()));
                }
                if range.and_then(|r| r.1).is_some_and(|total| total != limit) {
                    let _ = self.discard(id, part, counted);
                    return Err(FetchError::NextMirror("文件总长度与清单不符".into()));
                }
                true
            }
            // 服务器不支持 Range（或没有 Range 请求）：整个文件重新写
            200 => false,
            other => return Err(FetchError::NextMirror(format!("意外的状态码 {other}"))),
        };
        // 声明的长度就已超出清单大小：一个字节都不写
        let declared = resp
            .header("Content-Length")
            .and_then(|v| v.trim().parse::<u64>().ok());
        let start = if resume { offset } else { 0 };
        if declared.is_some_and(|len| start + len > limit) {
            return Err(FetchError::NextMirror("文件长度超出清单声明".into()));
        }
        if !resume && offset > 0 {
            self.discard(id, part, counted)
                .map_err(|e| FetchError::Retry(e.to_string()))?;
        }

        let mut file = if resume {
            OpenOptions::new().append(true).open(part)
        } else {
            File::create(part)
        }
        .map_err(|e| FetchError::NextMirror(format!("无法写入 {}：{e}", part.display())))?;

        let mut reader = resp.into_reader();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf).map_err(|e| {
                if is_io_timeout(&e) {
                    FetchError::NextMirror(self.stall_message())
                } else {
                    FetchError::Retry(format!("连接中断：{e}"))
                }
            })?;
            if n == 0 {
                return Ok(());
            }
            file.write_all(&buf[..n]).map_err(|e| {
                FetchError::NextMirror(format!("写入 {} 失败：{e}", part.display()))
            })?;
            self.progress.item_add(id, n as u64);
            *counted += n as u64;
            // 没声明长度的响应（chunked）也要拦住：超过清单大小立即中止并删除
            if *counted > limit {
                drop(file);
                let _ = self.discard(id, part, counted);
                return Err(FetchError::NextMirror("返回内容超出清单声明的大小".into()));
            }
        }
    }
}

impl Downloader {
    fn stall_message(&self) -> String {
        format!(
            "{} 秒没有收到数据，已换下一个地址",
            self.stall_timeout.as_secs().max(1)
        )
    }
}

fn is_io_timeout(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    )
}

/// ureq 的传输错误是否为超时（连接或读响应头时卡住）。
fn is_timeout(t: &ureq::Transport) -> bool {
    let mut source = std::error::Error::source(t);
    while let Some(e) = source {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            if is_io_timeout(io) {
                return true;
            }
        }
        source = e.source();
    }
    t.to_string().contains("timed out")
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 解析 `bytes 100-199/200`，返回 (起始位置, 总长度)；总长度为 `*` 时是 None。
fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let start = range.split('-').next()?.trim().parse().ok()?;
    Some((start, total.trim().parse().ok()))
}
