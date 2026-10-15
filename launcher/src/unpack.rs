//! 解包 tar.gz / tar.xz / tar.zst / zip。
//!
//! 先解到目标旁边的临时目录，成功后再整体 rename 到 dest，
//! 中途失败或断电不会留下半成品目录。
//! 安全：
//! - 拒绝绝对路径与 `..`；
//! - zip 里的符号链接一律拒绝；tar 的符号链接只能指向解包根内
//!   （`..` 只允许出现在目标开头），写入任何文件前其上级目录必须都不是符号链接；
//! - 硬链接的源路径同样校验；
//! - 解压总字节数有上限，防解压炸弹。

use crate::error::{Context, Error, Result};
use crate::fsx;
use crate::manifest::UnpackKind;
use crate::paths::is_safe_component;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

/// 把 `archive` 解包为目录 `dest`（已存在则被原子替换）。
/// `strip` 为解包时剥掉的前导目录层数，`max_bytes` 为解压后总字节上限。
pub fn unpack(
    archive: &Path,
    kind: UnpackKind,
    strip: usize,
    dest: &Path,
    max_bytes: u64,
) -> Result<()> {
    unpack_with_budget(archive, kind, strip, dest, Budget::new(max_bytes))
}

/// 同 `unpack`，预算（字节数、条目数上限）由调用方构造。
pub fn unpack_with_budget(
    archive: &Path,
    kind: UnpackKind,
    strip: usize,
    dest: &Path,
    budget: Budget,
) -> Result<()> {
    let parent = dest
        .parent()
        .ok_or_else(|| Error::new(format!("目标路径不合法：{}", dest.display())))?;
    fs::create_dir_all(parent).ctx(format!("创建目录 {} 失败", parent.display()))?;

    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let pid = std::process::id();
    let tmp = parent.join(format!(".{name}.unpack-{pid}"));
    fsx::remove_dir_all(&tmp)?;
    fs::create_dir_all(&tmp).ctx(format!("创建临时目录 {} 失败", tmp.display()))?;

    let result = extract(archive, kind, strip, &tmp, budget)
        .and_then(|()| swap_into_place(&tmp, dest, parent, &name, pid));
    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result
}

/// 解压字节预算。
pub struct Budget {
    left: u64,
    max_entries: usize,
}

impl Budget {
    pub fn new(max: u64) -> Self {
        Self {
            left: max,
            max_entries: MAX_ENTRIES,
        }
    }

    /// 调整条目数上限（测试用）。
    pub fn with_max_entries(mut self, n: usize) -> Self {
        self.max_entries = n;
        self
    }

    pub fn spend(&mut self, n: u64) -> Result<()> {
        if n > self.left {
            return Err(Error::new(
                "压缩包内容异常（解压后体积超出预期），已停止安装",
            ));
        }
        self.left -= n;
        Ok(())
    }

    /// 带预算的拷贝：最多多读 1 字节就能发现超限，不会把磁盘写满。
    pub fn copy<R: Read, W: Write>(&mut self, reader: &mut R, writer: &mut W) -> Result<()> {
        let mut limited = reader.take(self.left.saturating_add(1));
        let n = std::io::copy(&mut limited, writer).ctx("写入失败")?;
        self.spend(n)
    }
}

fn extract(
    archive: &Path,
    kind: UnpackKind,
    strip: usize,
    out: &Path,
    budget: Budget,
) -> Result<()> {
    let file = File::open(archive).ctx(format!("打开压缩包 {} 失败", archive.display()))?;
    let what = format!("解包 {} 失败", archive.display());
    match kind {
        UnpackKind::TarGz => extract_tar(flate2::read::GzDecoder::new(file), strip, out, budget),
        UnpackKind::TarXz => extract_tar(xz2::read::XzDecoder::new(file), strip, out, budget),
        UnpackKind::TarZst => extract_tar(zstd::Decoder::new(file).ctx(&what)?, strip, out, budget),
        UnpackKind::Zip => extract_zip(file, strip, out, budget),
        UnpackKind::Gz => Err(Error::new("gz 是单文件，应使用 unpack_gz")),
    }
    .map_err(|e| Error::new(format!("{what}（{e}）")))
}

/// 用临时目录替换 dest：旧目录先改名挪开，新目录就位后再删旧的。
fn swap_into_place(tmp: &Path, dest: &Path, parent: &Path, name: &str, pid: u32) -> Result<()> {
    if !dest.exists() {
        return fsx::rename(tmp, dest).ctx(format!("移动到 {} 失败", dest.display()));
    }
    let old = parent.join(format!(".{name}.old-{pid}"));
    fsx::remove_dir_all(&old)?;
    fsx::rename(dest, &old).ctx(format!("替换旧目录 {} 失败", dest.display()))?;
    if let Err(e) = fsx::rename(tmp, dest) {
        // 新目录没能就位，把旧的放回去
        let _ = fsx::rename(&old, dest);
        return Err(Error::new(format!("移动到 {} 失败：{e}", dest.display())));
    }
    // 旧目录删不掉（被占用）不影响本次安装，留给下次启动的清理
    let _ = fsx::remove_dir_all(&old);
    Ok(())
}

/// 临时目录/文件超过这个时长没动过，才认为是崩溃遗留
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(3600);

/// 清理 `dir` 下崩溃遗留的临时目录/文件（`.xxx.unpack-<pid>`、`.xxx.old-<pid>`、`.xxx.tmp-<pid>`）。
/// 只删超过 1 小时没修改的，并跳过本进程自己的，避免误伤另一个正在安装的启动器实例。
pub fn cleanup_stale(dir: &Path) {
    cleanup_stale_older_than(dir, STALE_AFTER);
}

/// 同 `cleanup_stale`，可指定最短陈旧时长（测试用）。
pub fn cleanup_stale_older_than(dir: &Path, age: std::time::Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let own = format!("-{}", std::process::id());
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stale_name = name.starts_with('.')
            && [".unpack-", ".old-", ".tmp-"]
                .iter()
                .any(|m| name.contains(m))
            && !name.ends_with(&own);
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|d| d >= age);
        if stale_name && old_enough {
            let path = entry.path();
            let _ = if path.is_dir() {
                fsx::remove_dir_all(&path)
            } else {
                fsx::remove_file(&path)
            };
        }
    }
}

/// 校验压缩包内路径：只允许普通组件，返回剥掉前 `strip` 层之后的相对路径
/// （剥完为空则返回 None，表示该条目应跳过）。
pub fn safe_rel_path(raw: &Path, strip: usize) -> Result<Option<PathBuf>> {
    let mut parts = Vec::new();
    for comp in raw.components() {
        match comp {
            Component::Normal(c) if is_safe_component(c) => parts.push(c),
            Component::CurDir => {}
            _ => {
                return Err(Error::new(format!(
                    "压缩包含有不安全的路径：{}",
                    raw.display()
                )))
            }
        }
    }
    if parts.len() <= strip {
        return Ok(None);
    }
    Ok(Some(parts[strip..].iter().collect()))
}

/// 符号链接目标必须是相对路径，`..` 只能出现在开头，且回退层数不能超过链接所在目录的深度。
/// 禁止「先走普通目录再 `..`」是因为中间那一级可能本身就是符号链接，字面计算会失真。
fn check_symlink_target(link_rel: &Path, target: &Path) -> Result<()> {
    let bad = || {
        Error::new(format!(
            "压缩包含有越界的符号链接：{} -> {}",
            link_rel.display(),
            target.display()
        ))
    };
    let mut depth = link_rel.components().count().saturating_sub(1) as i64;
    let mut descended = false;
    for comp in target.components() {
        match comp {
            Component::Normal(_) => {
                descended = true;
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir if !descended => {
                depth -= 1;
                if depth < 0 {
                    return Err(bad());
                }
            }
            _ => return Err(bad()),
        }
    }
    Ok(())
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 目标路径的任一上级目录是符号链接都拒绝，防止经由链接写到根目录之外。
fn ensure_no_symlink_ancestors(root: &Path, rel: &Path) -> Result<()> {
    let mut cur = root.to_path_buf();
    if let Some(parent) = rel.parent() {
        for comp in parent.components() {
            cur.push(comp);
            if is_symlink(&cur) {
                return Err(Error::new(format!(
                    "压缩包试图经由符号链接写入：{}",
                    rel.display()
                )));
            }
        }
    }
    Ok(())
}

/// 写入普通文件前的准备：上级目录无链接、目标本身也不是已存在的符号链接。
fn prepare_file(root: &Path, rel: &Path) -> Result<PathBuf> {
    let target = prepare_parent(root, rel)?;
    if is_symlink(&target) {
        return Err(Error::new(format!(
            "压缩包试图覆盖符号链接：{}",
            rel.display()
        )));
    }
    Ok(target)
}

fn prepare_parent(root: &Path, rel: &Path) -> Result<PathBuf> {
    ensure_no_symlink_ancestors(root, rel)?;
    let target = root.join(rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).ctx(format!("创建目录 {} 失败", parent.display()))?;
    }
    Ok(target)
}

#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link).ctx(format!("创建符号链接 {} 失败", link.display()))
}

/// Windows 创建符号链接需要特权，且 Windows 版压缩包里基本没有，直接跳过。
#[cfg(not(unix))]
fn make_symlink(_target: &Path, _link: &Path) -> Result<()> {
    Ok(())
}

/// 压缩包条目数上限，防止用海量空文件/目录耗尽 inode
const MAX_ENTRIES: usize = 500_000;

fn extract_tar<R: Read>(reader: R, strip: usize, out: &Path, mut budget: Budget) -> Result<()> {
    use tar::EntryType;
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_permissions(true);
    let entries = archive.entries().ctx("读取 tar 条目失败")?;
    for (count, entry) in entries.enumerate() {
        if count >= budget.max_entries {
            return Err(Error::new("压缩包条目过多，已停止安装"));
        }
        let mut entry = entry.ctx("读取 tar 条目失败")?;
        let raw = entry.path().ctx("读取条目路径失败")?.into_owned();
        let kind = entry.header().entry_type();
        if matches!(kind, EntryType::XGlobalHeader) {
            continue; // pax 全局头不对应任何文件
        }
        let Some(rel) = safe_rel_path(&raw, strip)? else {
            continue;
        };

        match kind {
            EntryType::Directory => {
                ensure_no_symlink_ancestors(out, &rel)?;
                fs::create_dir_all(out.join(&rel))
                    .ctx(format!("创建目录 {} 失败", rel.display()))?;
            }
            EntryType::Regular | EntryType::Continuous => {
                let target = prepare_file(out, &rel)?;
                let mode = entry.header().mode().unwrap_or(0o644);
                let mut dst = File::create(&target).ctx(format!("创建 {} 失败", rel.display()))?;
                // 按实际写入字节计费，不信任头部（含 PAX）声明的大小
                budget
                    .copy(&mut entry, &mut dst)
                    .map_err(|e| Error::new(format!("写入 {} 失败（{e}）", rel.display())))?;
                drop(dst);
                set_file_mode(&target, mode)?;
            }
            EntryType::Symlink => {
                let link = entry.link_name().ctx("读取链接目标失败")?;
                let link = link
                    .ok_or_else(|| Error::new(format!("符号链接缺少目标：{}", rel.display())))?
                    .into_owned();
                check_symlink_target(&rel, &link)?;
                let target = prepare_file(out, &rel)?;
                make_symlink(&link, &target)?;
            }
            EntryType::Link => {
                let link = entry.link_name().ctx("读取链接目标失败")?;
                let link = link
                    .ok_or_else(|| Error::new(format!("硬链接缺少目标：{}", rel.display())))?
                    .into_owned();
                let Some(src_rel) = safe_rel_path(&link, strip)? else {
                    continue;
                };
                ensure_no_symlink_ancestors(out, &src_rel)?;
                let src = out.join(&src_rel);
                if is_symlink(&src) {
                    return Err(Error::new(format!("硬链接指向符号链接：{}", rel.display())));
                }
                let target = prepare_file(out, &rel)?;
                fs::hard_link(&src, &target).ctx(format!("创建硬链接 {} 失败", rel.display()))?;
            }
            // 稀疏文件、设备文件等：不能悄悄丢掉，明确报错
            other => {
                return Err(Error::new(format!(
                    "压缩包含有不支持的条目类型 {:?}：{}",
                    other,
                    rel.display()
                )))
            }
        }
    }
    Ok(())
}

/// 保留权限位（取低 9 位，去掉 setuid 等）；Windows 无此概念。
fn set_file_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o777))
            .ctx(format!("设置权限 {} 失败", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn extract_zip(file: File, strip: usize, out: &Path, mut budget: Budget) -> Result<()> {
    let mut archive = zip::ZipArchive::new(file).ctx("读取 zip 失败")?;
    if archive.len() > budget.max_entries {
        return Err(Error::new("压缩包条目过多，已停止安装"));
    }
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).ctx("读取 zip 条目失败")?;
        // 部分 Windows 工具会写反斜杠路径
        let name = entry.name().replace('\\', "/");
        let Some(rel) = safe_rel_path(Path::new(&name), strip)? else {
            continue;
        };
        let mode = entry.unix_mode();

        if mode.is_some_and(|m| m & 0o170000 == 0o120000) {
            // 我们自己的包不需要 zip 符号链接，一律拒绝
            return Err(Error::new(format!(
                "zip 中含有符号链接，已拒绝：{}",
                rel.display()
            )));
        }
        if entry.is_dir() {
            ensure_no_symlink_ancestors(out, &rel)?;
            fs::create_dir_all(out.join(&rel)).ctx(format!("创建目录 {} 失败", rel.display()))?;
        } else {
            let target = prepare_file(out, &rel)?;
            let mut dst = File::create(&target).ctx(format!("创建 {} 失败", rel.display()))?;
            budget.copy(&mut entry, &mut dst)?;
            drop(dst);
            if let Some(m) = mode {
                // 保留可执行位（chrome-headless-shell 等需要）
                set_file_mode(&target, m)?;
            }
        }
    }
    Ok(())
}
