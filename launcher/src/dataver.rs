//! 数据版本标记：`data/data-version` 里记着用过这份数据的最高版本。
//!
//! 新版应用可能改了 `data/` 里的格式，旧版启动器再去读写就可能出错甚至破坏数据。分两步：
//! - `check`（启动时，只读）：标记比自己新就提示「请使用最新版启动器」并退出，不动任何数据；
//! - `record`（必需项装好、服务启动成功之后）：把标记更新为自己的版本。
//!   写入推迟到这里，升级中途失败（断网、下载不到应用本体）时标记不变，仍留着的旧启动器照常能用。

use crate::error::{Context, Error, Result};
use crate::fsx;
use crate::paths::AppRoot;
use crate::version::Version;
use std::cmp::Ordering;
use std::fs;

pub const MARKER: &str = "data-version";

fn recorded(root: &AppRoot) -> String {
    fs::read_to_string(root.data().join(MARKER))
        .map(|t| t.trim().to_string())
        .unwrap_or_default()
}

/// 只读检查。`own` 为本启动器内置清单的版本。
pub fn check(root: &AppRoot, own: &str) -> Result<()> {
    let recorded = recorded(root);
    match Version::cmp_str(&recorded, own) {
        Some(Ordering::Greater) => Err(Error::new(format!(
            "请使用最新版启动器：这份数据已被 {recorded} 版使用过，当前启动器是 {own} 版"
        ))),
        _ => Ok(()),
    }
}

/// 登记：没有标记、标记看不懂或比自己旧时记成自己的版本；已经是自己或更新的不动。
pub fn record(root: &AppRoot, own: &str) -> Result<()> {
    if matches!(
        Version::cmp_str(&recorded(root), own),
        Some(Ordering::Equal | Ordering::Greater)
    ) {
        return Ok(());
    }
    let path = root.data().join(MARKER);
    fs::create_dir_all(root.data()).ctx(format!("创建目录 {} 失败", root.data().display()))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, own).ctx(format!("写入 {} 失败", tmp.display()))?;
    fsx::rename(&tmp, &path).ctx(format!("保存 {} 失败", path.display()))
}
