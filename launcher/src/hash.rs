//! sha256 工具。

use crate::error::{Context, Result};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// 流式计算文件的 sha256（小写十六进制），不会把大文件读进内存。
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).ctx(format!("打开 {} 失败", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .ctx(format!("读取 {} 失败", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// 内存数据的 sha256。
pub fn sha256_bytes(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
