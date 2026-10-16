//! 单文件产物：gz 解压、从 zip 里取指定文件（可选转码）、可执行位、标记文件。
//! 都是先写同目录临时文件再 rename，避免留下半截文件。

use crate::error::{Context, Error, Result};
use crate::fsx;
use crate::unpack::Budget;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 同目录临时文件名：`.<name>.tmp-<pid>`，崩溃遗留的由 `cleanup_stale` 清理。
fn temp_sibling(dest: &Path) -> Result<PathBuf> {
    let parent = dest
        .parent()
        .ok_or_else(|| Error::new(format!("目标路径不合法：{}", dest.display())))?;
    fs::create_dir_all(parent).ctx(format!("创建目录 {} 失败", parent.display()))?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(parent.join(format!(".{name}.tmp-{}", std::process::id())))
}

/// 写临时文件 -> 可选处理 -> rename 到 dest；失败时清掉临时文件。
fn write_atomic(dest: &Path, fill: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
    let tmp = temp_sibling(dest)?;
    let result = fill(&tmp)
        .and_then(|()| fsx::rename(&tmp, dest).ctx(format!("移动到 {} 失败", dest.display())));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 单文件 gzip 解压到 `dest`；`max_bytes` 为解压后字节上限。
pub fn unpack_gz(archive: &Path, dest: &Path, max_bytes: u64) -> Result<()> {
    write_atomic(dest, |tmp| {
        let src = File::open(archive).ctx(format!("打开压缩包 {} 失败", archive.display()))?;
        let mut decoder = flate2::read::GzDecoder::new(src);
        let mut out = File::create(tmp).ctx(format!("创建 {} 失败", tmp.display()))?;
        Budget::new(max_bytes)
            .copy(&mut decoder, &mut out)
            .map_err(|e| Error::new(format!("解压 {} 失败（{e}）", archive.display())))?;
        out.flush().ctx("写入失败")
    })
}

/// 从 zip 里取出 `entry` 写到 `dest`；`transcode` 为 "mp3" 时用 `ffmpeg` 转成 128k 立体声 44.1kHz。
pub fn extract_entry(
    archive: &Path,
    entry: &str,
    dest: &Path,
    transcode: Option<&str>,
    ffmpeg: &Path,
    max_bytes: u64,
) -> Result<()> {
    if let Some(kind) = transcode {
        if kind != "mp3" {
            return Err(Error::new(format!("不支持的转码类型：{kind}")));
        }
    }
    let file = File::open(archive).ctx(format!("打开压缩包 {} 失败", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).ctx("读取 zip 失败")?;
    let mut src = zip.by_name(entry).ctx(format!("压缩包里找不到 {entry}"))?;

    write_atomic(dest, |tmp| {
        let mut budget = Budget::new(max_bytes);
        if transcode.is_none() {
            let mut out = File::create(tmp).ctx(format!("创建 {} 失败", tmp.display()))?;
            return budget.copy(&mut src, &mut out);
        }
        // 先把原始内容落到临时文件，再让 ffmpeg 转出到 tmp
        let raw = PathBuf::from(format!("{}.src", tmp.display()));
        let mut out = File::create(&raw).ctx(format!("创建 {} 失败", raw.display()))?;
        let copied = budget.copy(&mut src, &mut out);
        drop(out);
        let converted = copied.and_then(|()| transcode_mp3(ffmpeg, &raw, tmp));
        let _ = fs::remove_file(&raw);
        converted
    })
}

fn transcode_mp3(ffmpeg: &Path, input: &Path, output: &Path) -> Result<()> {
    if !ffmpeg.is_file() {
        return Err(Error::new("转码配乐需要 ffmpeg，但尚未安装"));
    }
    let out = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-i"])
        .arg(input)
        .args([
            "-vn", "-ac", "2", "-ar", "44100", "-b:a", "128k", "-f", "mp3",
        ])
        .arg(output)
        .output()
        .ctx("运行 ffmpeg 失败")?;
    if out.status.success() {
        Ok(())
    } else {
        Err(Error::new(format!(
            "ffmpeg 转码失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

/// 设置可执行位（Windows 无此概念，忽略）。
pub fn set_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .ctx(format!("设置可执行权限 {} 失败", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
