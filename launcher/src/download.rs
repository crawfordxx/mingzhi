//! 下载：`.part` 文件 + HTTP Range 续传 + sha256 校验 + 多镜像回退。
//!
//! 策略（每个镜像最多 `max_attempts` 次，默认 3）：
//! - 4xx（404/403 等）：该镜像没有这个文件，立刻换下一个镜像；
//! - 网络错误 / 5xx / 429：保留 .part，稍等后续传重试；
//! - 下载完成但大小或 sha256 不符：删除 .part，从头重下；
//! - 服务器无视 Range 直接回 200：从头写，不会把内容接错。

use crate::error::{Context, Error, Result};
use crate::hash::sha256_file;
use crate::manifest::Item;
use crate::progress::Progress;
use crate::proxy::ProxyConfig;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const USER_AGENT: &str = concat!("mingzhi-launcher/", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 读超时：连接卡死时尽快失败并续传，而不是让用户干等
const READ_TIMEOUT: Duration = Duration::from_secs(30);
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
}

impl Downloader {
    pub fn new(proxy: ProxyConfig, progress: Arc<Progress>) -> Self {
        Self {
            proxy,
            progress,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            retry_delay: DEFAULT_RETRY_DELAY,
        }
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

        for url in &item.urls {
            for attempt in 1..=self.max_attempts {
                if attempt > 1 {
                    std::thread::sleep(self.retry_delay * (attempt as u32 - 1));
                }
                // 与磁盘上的 .part 对齐（上次运行遗留的续传数据也要计入进度）
                let len = file_len(part);
                if len > item.size {
                    self.discard(part, &mut counted)?;
                } else {
                    self.reconcile(&mut counted, len);
                }

                if file_len(part) != item.size {
                    match self.fetch(url, part, &mut counted) {
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
                self.discard(part, &mut counted)?;
            }
        }

        let detail = failures.last().cloned().unwrap_or_default();
        Err(Error::new(format!(
            "{} 下载失败，所有镜像均不可用（最后一次：{detail}）",
            item.id
        )))
    }

    /// 大小与 sha256 是否与清单一致。
    fn verify(&self, item: &Item, part: &Path) -> Result<bool> {
        if file_len(part) != item.size {
            return Ok(false);
        }
        Ok(sha256_file(part)?.eq_ignore_ascii_case(&item.sha256))
    }

    fn discard(&self, part: &Path, counted: &mut u64) -> Result<()> {
        match fs::remove_file(part) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::new(format!("删除 {} 失败：{e}", part.display()))),
        }
        self.reconcile(counted, 0);
        Ok(())
    }

    /// 让「已计入进度的字节」与 .part 实际长度一致。
    fn reconcile(&self, counted: &mut u64, actual: u64) {
        if actual > *counted {
            self.progress.add(actual - *counted);
        } else {
            self.progress.sub(*counted - actual);
        }
        *counted = actual;
    }

    fn agent_for(&self, url: &str) -> Result<ureq::Agent> {
        let mut builder = ureq::AgentBuilder::new()
            .user_agent(USER_AGENT)
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout_read(READ_TIMEOUT);
        if let Some(p) = self.proxy.proxy_for(url) {
            builder = builder.proxy(ureq::Proxy::new(p).ctx(format!("代理地址 {p} 不可用"))?);
        }
        Ok(builder.build())
    }

    /// 向一个镜像请求一次，从 .part 现有长度处续传。
    fn fetch(
        &self,
        url: &str,
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
                let _ = self.discard(part, counted);
                return Err(FetchError::Retry("服务器拒绝续传范围（416）".into()));
            }
            Err(ureq::Error::Status(code, _)) if code == 408 || code == 429 || code >= 500 => {
                return Err(FetchError::Retry(format!("服务器返回 {code}")));
            }
            Err(ureq::Error::Status(code, _)) => {
                return Err(FetchError::NextMirror(format!("服务器返回 {code}")))
            }
            Err(ureq::Error::Transport(t)) => {
                return Err(FetchError::Retry(format!("网络错误：{t}")))
            }
        };

        let resume = match resp.status() {
            206 => {
                let start = resp
                    .header("Content-Range")
                    .and_then(parse_content_range_start);
                if start != Some(offset) {
                    let _ = self.discard(part, counted);
                    return Err(FetchError::Retry("续传位置与服务器不一致".into()));
                }
                true
            }
            // 服务器不支持 Range（或没有 Range 请求）：整个文件重新写
            200 => false,
            other => return Err(FetchError::NextMirror(format!("意外的状态码 {other}"))),
        };
        if !resume && offset > 0 {
            self.discard(part, counted)
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
            let n = reader
                .read(&mut buf)
                .map_err(|e| FetchError::Retry(format!("连接中断：{e}")))?;
            if n == 0 {
                return Ok(());
            }
            file.write_all(&buf[..n]).map_err(|e| {
                FetchError::NextMirror(format!("写入 {} 失败：{e}", part.display()))
            })?;
            self.progress.add(n as u64);
            *counted += n as u64;
        }
    }
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 解析 `bytes 100-199/200` 中的起始位置。
fn parse_content_range_start(value: &str) -> Option<u64> {
    value
        .trim()
        .strip_prefix("bytes ")?
        .split('-')
        .next()?
        .trim()
        .parse()
        .ok()
}
