//! 解包 tar.gz / tar.xz / tar.zst / zip。
//!
//! 先解到目标旁边的临时目录，成功后再整体 rename 到 dest，
//! 中途失败或断电不会留下半成品目录。
//! 安全：拒绝绝对路径、`..`、逃出解包根目录的符号链接。

use crate::error::{Context, Error, Result};
use crate::manifest::UnpackKind;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 把 `archive` 解包为目录 `dest`（已存在则被原子替换）。
/// `strip` 为解包时剥掉的前导目录层数。
pub fn unpack(archive: &Path, kind: UnpackKind, strip: usize, dest: &Path) -> Result<()> {
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
    remove_dir_if_exists(&tmp)?;
    fs::create_dir_all(&tmp).ctx(format!("创建临时目录 {} 失败", tmp.display()))?;

    let result = extract(archive, kind, strip, &tmp)
        .and_then(|()| swap_into_place(&tmp, dest, parent, &name, pid));
    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result
}

fn extract(archive: &Path, kind: UnpackKind, strip: usize, out: &Path) -> Result<()> {
    let file = File::open(archive).ctx(format!("打开压缩包 {} 失败", archive.display()))?;
    let what = format!("解包 {} 失败", archive.display());
    match kind {
        UnpackKind::TarGz => extract_tar(flate2::read::GzDecoder::new(file), strip, out),
        UnpackKind::TarXz => extract_tar(xz2::read::XzDecoder::new(file), strip, out),
        UnpackKind::TarZst => extract_tar(zstd::Decoder::new(file).ctx(&what)?, strip, out),
        UnpackKind::Zip => extract_zip(file, strip, out),
    }
    .map_err(|e| Error::new(format!("{what}（{e}）")))
}

/// 用临时目录替换 dest：旧目录先改名挪开，新目录就位后再删旧的。
fn swap_into_place(tmp: &Path, dest: &Path, parent: &Path, name: &str, pid: u32) -> Result<()> {
    if !dest.exists() {
        return fs::rename(tmp, dest).ctx(format!("移动到 {} 失败", dest.display()));
    }
    let old = parent.join(format!(".{name}.old-{pid}"));
    remove_dir_if_exists(&old)?;
    fs::rename(dest, &old).ctx(format!("替换旧目录 {} 失败", dest.display()))?;
    if let Err(e) = fs::rename(tmp, dest) {
        // 新目录没能就位，把旧的放回去
        let _ = fs::rename(&old, dest);
        return Err(Error::new(format!("移动到 {} 失败：{e}", dest.display())));
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

fn remove_dir_if_exists(dir: &Path) -> Result<()> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::new(format!("清理 {} 失败：{e}", dir.display()))),
    }
}

/// 校验压缩包内路径：只允许普通组件，返回剥掉前 `strip` 层之后的相对路径
/// （剥完为空则返回 None，表示该条目应跳过）。
pub fn safe_rel_path(raw: &Path, strip: usize) -> Result<Option<PathBuf>> {
    let mut parts = Vec::new();
    for comp in raw.components() {
        match comp {
            Component::Normal(c) => parts.push(c),
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

/// 符号链接目标必须是相对路径，且按字面解析后不能跑出解包根目录。
fn check_symlink_target(link_rel: &Path, target: &Path) -> Result<()> {
    let bad = || {
        Error::new(format!(
            "压缩包含有越界的符号链接：{} -> {}",
            link_rel.display(),
            target.display()
        ))
    };
    // 链接所在目录相对根的深度
    let mut depth = link_rel.components().count().saturating_sub(1) as i64;
    for comp in target.components() {
        match comp {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
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

/// 目标路径的任一上级目录是符号链接都拒绝，防止经由链接写到根目录之外。
fn ensure_no_symlink_ancestors(root: &Path, rel: &Path) -> Result<()> {
    let mut cur = root.to_path_buf();
    if let Some(parent) = rel.parent() {
        for comp in parent.components() {
            cur.push(comp);
            if fs::symlink_metadata(&cur)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err(Error::new(format!(
                    "压缩包试图经由符号链接写入：{}",
                    rel.display()
                )));
            }
        }
    }
    Ok(())
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

fn extract_tar<R: Read>(reader: R, strip: usize, out: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_permissions(true);
    let entries = archive.entries().ctx("读取 tar 条目失败")?;
    for entry in entries {
        let mut entry = entry.ctx("读取 tar 条目失败")?;
        let raw = entry.path().ctx("读取条目路径失败")?.into_owned();
        let Some(rel) = safe_rel_path(&raw, strip)? else {
            continue;
        };
        let kind = entry.header().entry_type();

        if kind.is_dir() {
            ensure_no_symlink_ancestors(out, &rel)?;
            fs::create_dir_all(out.join(&rel)).ctx(format!("创建目录 {} 失败", rel.display()))?;
        } else if kind.is_file() {
            let target = prepare_parent(out, &rel)?;
            entry
                .unpack(&target)
                .ctx(format!("写入 {} 失败", rel.display()))?;
        } else if kind.is_symlink() {
            let link = entry
                .link_name()
                .ctx("读取链接目标失败")?
                .map(|l| l.into_owned());
            let link =
                link.ok_or_else(|| Error::new(format!("符号链接缺少目标：{}", rel.display())))?;
            check_symlink_target(&rel, &link)?;
            let target = prepare_parent(out, &rel)?;
            make_symlink(&link, &target)?;
        } else if kind.is_hard_link() {
            let link = entry
                .link_name()
                .ctx("读取链接目标失败")?
                .map(|l| l.into_owned());
            let link =
                link.ok_or_else(|| Error::new(format!("硬链接缺少目标：{}", rel.display())))?;
            let Some(src_rel) = safe_rel_path(&link, strip)? else {
                continue;
            };
            let target = prepare_parent(out, &rel)?;
            fs::hard_link(out.join(src_rel), &target)
                .ctx(format!("创建硬链接 {} 失败", rel.display()))?;
        }
        // 其余类型（pax 头、设备文件等）无需落盘，忽略
    }
    Ok(())
}

fn extract_zip(file: File, strip: usize, out: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(file).ctx("读取 zip 失败")?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).ctx("读取 zip 条目失败")?;
        // 部分 Windows 工具会写反斜杠路径
        let name = entry.name().replace('\\', "/");
        let Some(rel) = safe_rel_path(Path::new(&name), strip)? else {
            continue;
        };
        let mode = entry.unix_mode();

        if entry.is_dir() {
            ensure_no_symlink_ancestors(out, &rel)?;
            fs::create_dir_all(out.join(&rel)).ctx(format!("创建目录 {} 失败", rel.display()))?;
        } else if mode.is_some_and(|m| m & 0o170000 == 0o120000) {
            let mut link = String::new();
            entry
                .read_to_string(&mut link)
                .ctx(format!("读取符号链接 {} 失败", rel.display()))?;
            check_symlink_target(&rel, Path::new(&link))?;
            let target = prepare_parent(out, &rel)?;
            make_symlink(Path::new(&link), &target)?;
        } else {
            let target = prepare_parent(out, &rel)?;
            let mut dst = File::create(&target).ctx(format!("创建 {} 失败", rel.display()))?;
            std::io::copy(&mut entry, &mut dst).ctx(format!("写入 {} 失败", rel.display()))?;
            drop(dst);
            #[cfg(unix)]
            if let Some(m) = mode {
                use std::os::unix::fs::PermissionsExt;
                // 保留可执行位（chrome-headless-shell 等需要）
                fs::set_permissions(&target, fs::Permissions::from_mode(m & 0o777))
                    .ctx(format!("设置权限 {} 失败", rel.display()))?;
            }
        }
    }
    Ok(())
}
