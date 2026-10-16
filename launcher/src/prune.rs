//! 清理旧版本：只删 AppRoot 里、名称符合版本号模式、当前清单已不再引用的旧目录。
//!
//! - `runtime/chrome-headless-shell/<版本>`：不是当前清单引用的 Chrome 版本，整个删除；
//! - `app/<版本>`：保留当前版本和「上一版」（版本号低于当前的最高一个，便于回退），更旧的删除；
//!   不比当前版本低的目录一律不碰。
//!
//! 尽力而为：删不掉（被占用等）就留着，下次启动再试；不会让启动失败。

use crate::fsx;
use crate::manifest::Manifest;
use crate::paths::AppRoot;
use crate::state::State;
use crate::version::Version;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Chrome 的版本目录所在位置（相对 AppRoot）
const CHROME_DIR: [&str; 2] = ["runtime", "chrome-headless-shell"];

/// 删除旧版本目录并清掉它们的 state 记录；返回实际删掉的目录。
pub fn prune(root: &AppRoot, manifest: &Manifest, platform: &str) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    removed.extend(prune_chrome(root, manifest, platform));
    removed.extend(prune_apps(root, &manifest.version));
    if !removed.is_empty() {
        let rels: Vec<String> = removed.iter().filter_map(|p| rel_of(root, p)).collect();
        // state 只是缓存，写不进去不影响启动
        let _ = State::update(&root.state_file(), |s| {
            rels.iter().fold(s.clone(), |s, rel| s.without_under(rel))
        });
    }
    removed
}

/// 相对 AppRoot、用 `/` 分隔的路径。
fn rel_of(root: &AppRoot, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root.root()).ok()?;
    let parts: Vec<_> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    Some(parts.join("/"))
}

/// 容器目录下的子目录（不跟随符号链接，只要真正的目录）：(名称, 路径)。
fn subdirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
        .collect()
}

fn remove(dir: &Path) -> bool {
    match fsx::remove_dir_all(dir) {
        Ok(()) => true,
        Err(e) => {
            crate::signal::say(&format!(
                "提示：没能清理旧目录 {}（{e}），下次启动再试",
                dir.display()
            ));
            false
        }
    }
}

fn chrome_container(root: &AppRoot) -> PathBuf {
    CHROME_DIR
        .iter()
        .fold(root.root().to_path_buf(), |p, c| p.join(c))
}

/// 版本目录名只认「数字和点」，别的名字（用户放的东西）不碰。
fn looks_like_chrome_version(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| c.is_ascii_digit() || c == '.')
        && name.chars().any(|c| c.is_ascii_digit())
}

fn prune_chrome(root: &AppRoot, manifest: &Manifest, platform: &str) -> Vec<PathBuf> {
    let container = chrome_container(root);
    // 当前清单引用的版本目录（chrome 项的 dest 在 container 下的第一层）
    let keep: HashSet<String> = manifest
        .for_platform(platform)
        .into_iter()
        .filter(|i| i.kind == "chrome")
        .filter_map(|i| i.resolve_dest(root, &manifest.version).ok())
        .filter_map(|dest| {
            let rel = dest.strip_prefix(&container).ok()?;
            Some(
                rel.components()
                    .next()?
                    .as_os_str()
                    .to_string_lossy()
                    .into_owned(),
            )
        })
        .collect();
    if keep.is_empty() {
        return Vec::new(); // 清单里没有 Chrome（或位置不在预期处）：什么都不删
    }
    subdirs(&container)
        .into_iter()
        .filter(|(name, _)| looks_like_chrome_version(name) && !keep.contains(name))
        .filter(|(_, path)| remove(path))
        .map(|(_, path)| path)
        .collect()
}

fn prune_apps(root: &AppRoot, current: &str) -> Vec<PathBuf> {
    let Some(cur) = Version::parse(current) else {
        return Vec::new();
    };
    let mut older: Vec<(Version, String, PathBuf)> = subdirs(&root.app())
        .into_iter()
        .filter_map(|(name, path)| Some((Version::parse(&name)?, name, path)))
        .filter(|(v, _, _)| *v < cur)
        .collect();
    older.sort();
    older.pop(); // 上一版留着
    older
        .into_iter()
        .filter(|(_, _, path)| remove(path))
        .map(|(_, _, path)| path)
        .collect()
}
