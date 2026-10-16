//! 数据版本标记：`data/data-version` 里记着用过这份数据的最高版本。
//!
//! 新版应用可能改了 `data/` 里的格式，旧版启动器再去读写就可能出错甚至破坏数据。
//! 所以启动时先看标记：比自己新就提示「请使用最新版启动器」并退出（不动任何数据）；
//! 否则在需要时把标记更新为自己的版本。

use crate::error::{Context, Error, Result};
use crate::fsx;
use crate::paths::AppRoot;
use crate::version::Version;
use std::cmp::Ordering;
use std::fs;

pub const MARKER: &str = "data-version";

/// 检查并登记数据版本。`own` 为本启动器内置清单的版本。
pub fn ensure(root: &AppRoot, own: &str) -> Result<()> {
    let path = root.data().join(MARKER);
    let recorded = fs::read_to_string(&path).ok();
    let recorded = recorded.as_deref().map(str::trim).unwrap_or("");
    match Version::cmp_str(recorded, own) {
        Some(Ordering::Greater) => Err(Error::new(format!(
            "请使用最新版启动器：这份数据已被 {recorded} 版使用过，当前启动器是 {own} 版"
        ))),
        Some(Ordering::Equal) => Ok(()),
        // 没有标记、标记看不懂，或标记比自己旧：记成自己的版本
        _ => {
            fs::create_dir_all(root.data())
                .ctx(format!("创建目录 {} 失败", root.data().display()))?;
            let tmp = path.with_extension("tmp");
            fs::write(&tmp, own).ctx(format!("写入 {} 失败", tmp.display()))?;
            fsx::rename(&tmp, &path).ctx(format!("保存 {} 失败", path.display()))
        }
    }
}
