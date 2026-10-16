//! 文件操作的小封装：Windows 上被杀毒软件/其它进程短暂占用时退避重试。

use crate::error::{Error, Result};
use std::io;
use std::path::Path;
use std::time::Duration;

/// Windows 上的退避间隔：100ms、300ms、1s，共重试 3 次。
const WINDOWS_BACKOFF: [Duration; 3] = [
    Duration::from_millis(100),
    Duration::from_millis(300),
    Duration::from_millis(1000),
];

const BUSY_MESSAGE: &str = "文件被占用（可能是杀毒软件正在扫描），请稍后重试";

/// 「文件被占用」类错误：拒绝访问 / 共享冲突 / 锁冲突。
fn is_busy(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// 可注入间隔的重试实现（便于在任意平台测试）：
/// 遇到「占用」类错误按 `delays` 依次等待重试；用尽后返回中文提示。
pub fn retry_busy<T>(delays: &[Duration], mut op: impl FnMut() -> io::Result<T>) -> Result<T> {
    let mut tries = delays.iter();
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if is_busy(&e) => match tries.next() {
                Some(d) => std::thread::sleep(*d),
                None if delays.is_empty() => return Err(Error::new(e.to_string())),
                None => return Err(Error::new(BUSY_MESSAGE)),
            },
            Err(e) => return Err(Error::new(e.to_string())),
        }
    }
}

fn platform_delays() -> &'static [Duration] {
    if cfg!(windows) {
        &WINDOWS_BACKOFF
    } else {
        &[]
    }
}

pub fn rename(from: &Path, to: &Path) -> Result<()> {
    retry_busy(platform_delays(), || std::fs::rename(from, to))
}

/// 删除目录；目录不存在视为成功。
pub fn remove_dir_all(dir: &Path) -> Result<()> {
    retry_busy(platform_delays(), || match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
}

/// 删除文件；文件不存在视为成功。
pub fn remove_file(file: &Path) -> Result<()> {
    retry_busy(platform_delays(), || match std::fs::remove_file(file) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
}
