//! state.json：已安装项与哈希缓存。
//!
//! 二次启动时不重复校验大文件：
//! - 单文件项：记录里 sha 与清单一致，且磁盘文件的 size + mtime 与记录一致 → 直接跳过；
//!   size 对但 mtime 变了才全量算一次 sha。
//! - 解包项（目录）：记录里的压缩包 sha 与清单一致且目录仍在 → 跳过。
//!
//! 文件里除 `installed` 外的字段（如 Task 3 的用户设置）原样保留。

use crate::error::{Context, Error, Result};
use crate::manifest::{Item, UnpackKind};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledItem {
    /// 清单里该项的 sha256（解包项为压缩包的 sha）
    pub sha256: String,
    pub size: u64,
    /// 单文件项落盘后的修改时间（毫秒）；目录项为 None
    pub mtime_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub installed: BTreeMap<String, InstalledItem>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// 对一个清单项做快速判定的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    /// 已装且一致，直接跳过
    UpToDate,
    /// 文件在但无法凭 size+mtime 确认，需要算一次 sha
    NeedHash,
    /// 未安装或版本不符，需要下载
    Missing,
}

impl State {
    /// 读取；文件不存在视为空。损坏时把坏文件改名留底后从空状态开始
    /// （state 只是缓存，最坏情况是重新校验一遍）。
    pub fn load(path: &Path) -> Result<Self> {
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(Error::new(format!("读取 {} 失败：{e}", path.display()))),
        };
        match serde_json::from_str(&text) {
            Ok(s) => Ok(s),
            Err(_) => {
                let backup = path.with_extension("json.bad");
                fs::rename(path, &backup).ctx(format!("备份损坏的 {} 失败", path.display()))?;
                Ok(Self::default())
            }
        }
    }

    /// 原子写入：先写临时文件再 rename。
    pub fn save(&self, path: &Path) -> Result<()> {
        let json = serde_json::to_string_pretty(self).ctx("序列化 state 失败")?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).ctx(format!("写入 {} 失败", tmp.display()))?;
        crate::fsx::rename(&tmp, path).ctx(format!("保存 {} 失败", path.display()))
    }

    /// 返回登记了该项的新状态。
    pub fn with_installed(&self, id: &str, record: InstalledItem) -> Self {
        let mut next = self.clone();
        next.installed.insert(id.to_string(), record);
        next
    }

    /// 快速判定：不读文件内容。
    pub fn check(&self, item: &Item, dest: &Path) -> Check {
        let record_matches = self
            .installed
            .get(&item.id)
            .filter(|rec| rec.sha256.eq_ignore_ascii_case(&item.sha256));

        // 取 entry 的项：各输出文件的位置由 entries 决定，dest 目录不一定存在，
        // 输出是否齐全由调用方检查
        if !item.entries.is_empty() {
            return if record_matches.is_some() {
                Check::UpToDate
            } else {
                Check::Missing
            };
        }
        let Ok(meta) = fs::metadata(dest) else {
            return Check::Missing;
        };

        // 解包 / gz / 取 entry 的项：dest 里的内容与下载文件的 sha 对不上，只能信记录
        if item.is_derived() {
            let want_dir = item.unpack != Some(UnpackKind::Gz);
            return if record_matches.is_some() && meta.is_dir() == want_dir {
                Check::UpToDate
            } else {
                Check::Missing
            };
        }

        let size_ok = meta.is_file() && meta.len() == item.size;
        match record_matches {
            Some(rec) if size_ok => {
                if rec.mtime_ms.is_some() && rec.mtime_ms == mtime_ms(&meta) {
                    Check::UpToDate
                } else {
                    Check::NeedHash
                }
            }
            Some(_) => Check::Missing,
            // 没有记录（如用户手工放入的文件）：大小对得上才值得算 sha
            None if size_ok => Check::NeedHash,
            None => Check::Missing,
        }
    }

    /// 为刚安装（或刚确认一致）的项生成记录。
    pub fn record_for(item: &Item, dest: &Path) -> InstalledItem {
        let mtime = if item.is_derived() {
            None
        } else {
            fs::metadata(dest).ok().and_then(|m| mtime_ms(&m))
        };
        InstalledItem {
            sha256: item.sha256.clone(),
            size: item.size,
            mtime_ms: mtime,
        }
    }
}

fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    let d = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(d.as_millis() as u64)
}
