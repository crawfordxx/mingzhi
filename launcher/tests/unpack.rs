//! 解包：四种格式、strip、可执行位、路径穿越与符号链接逃逸、原子替换。

use mingzhi_launcher::error::Result;
use mingzhi_launcher::manifest::UnpackKind;
use mingzhi_launcher::unpack::{cleanup_stale, unpack as unpack_with_limit};
use std::fs;
use std::io::Write;
use std::path::Path;

const LIMIT: u64 = 1 << 30;

fn unpack(archive: &Path, kind: UnpackKind, strip: usize, dest: &Path) -> Result<()> {
    unpack_with_limit(archive, kind, strip, dest, LIMIT)
}

/// 构造含 `top/bin/run`（可执行）、`top/lib/data.txt` 的 tar 字节流。
fn build_tar() -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut add = |path: &str, body: &[u8], mode: u32| {
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(mode);
        h.set_cksum();
        builder.append_data(&mut h, path, body).unwrap();
    };
    add("top/bin/run", b"#!/bin/sh\necho hi\n", 0o755);
    add("top/lib/data.txt", b"hello", 0o644);
    builder.into_inner().unwrap()
}

/// 手写 tar 头，绕过 tar crate 对 `..` / 绝对路径的构造期拒绝。
fn raw_tar_entry(name: &str, body: &[u8]) -> Vec<u8> {
    let mut h = tar::Header::new_gnu();
    h.set_size(body.len() as u64);
    h.set_mode(0o644);
    h.set_entry_type(tar::EntryType::Regular);
    h.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
    h.set_cksum();
    let mut out = h.as_bytes().to_vec();
    out.extend_from_slice(body);
    out.resize(out.len().div_ceil(512) * 512, 0);
    out.extend_from_slice(&[0u8; 1024]);
    out
}

fn symlink_tar(link_name: &str, target: &str) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Symlink);
    h.set_size(0);
    h.set_cksum();
    builder.append_link(&mut h, link_name, target).unwrap();
    builder.into_inner().unwrap()
}

fn gz(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}
fn xz(data: &[u8]) -> Vec<u8> {
    let mut e = xz2::write::XzEncoder::new(Vec::new(), 1);
    e.write_all(data).unwrap();
    e.finish().unwrap()
}
fn zst(data: &[u8]) -> Vec<u8> {
    zstd::encode_all(data, 1).unwrap()
}

fn build_zip() -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let exec = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
    let plain = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
    w.start_file("top/bin/run", exec).unwrap();
    w.write_all(b"#!/bin/sh\necho hi\n").unwrap();
    w.start_file("top/lib/data.txt", plain).unwrap();
    w.write_all(b"hello").unwrap();
    w.finish().unwrap().into_inner()
}

fn write_archive(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let p = dir.join(name);
    fs::write(&p, bytes).unwrap();
    p
}

fn assert_unpacked(dest: &Path, prefix: &str) {
    assert_eq!(
        fs::read_to_string(dest.join(prefix).join("lib/data.txt")).unwrap(),
        "hello"
    );
    assert!(dest.join(prefix).join("bin/run").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dest.join(prefix).join("bin/run"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "可执行位应保留，实际 {mode:o}");
    }
}

#[test]
fn 四种格式都能解包() {
    let tar = build_tar();
    let cases: Vec<(&str, UnpackKind, Vec<u8>)> = vec![
        ("a.tar.gz", UnpackKind::TarGz, gz(&tar)),
        ("a.tar.xz", UnpackKind::TarXz, xz(&tar)),
        ("a.tar.zst", UnpackKind::TarZst, zst(&tar)),
        ("a.zip", UnpackKind::Zip, build_zip()),
    ];
    for (name, kind, bytes) in cases {
        let tmp = tempfile::tempdir().unwrap();
        let archive = write_archive(tmp.path(), name, &bytes);
        let dest = tmp.path().join("out/pkg");
        unpack(&archive, kind, 0, &dest).unwrap_or_else(|e| panic!("{name} 解包失败：{e}"));
        assert_unpacked(&dest, "top");
    }
}

#[test]
fn strip_剥掉顶级目录() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = write_archive(tmp.path(), "a.tar.gz", &gz(&build_tar()));
    let dest = tmp.path().join("pkg");
    unpack(&archive, UnpackKind::TarGz, 1, &dest).unwrap();
    assert_unpacked(&dest, "");
    assert!(!dest.join("top").exists());
}

#[test]
fn tar_路径穿越被拒且不留残骸() {
    let tmp = tempfile::tempdir().unwrap();
    let evil = raw_tar_entry("../evil.txt", b"x");
    let archive = write_archive(tmp.path(), "evil.tar.gz", &gz(&evil));
    let dest = tmp.path().join("work/pkg");

    let err = unpack(&archive, UnpackKind::TarGz, 0, &dest).unwrap_err();
    assert!(err.to_string().contains("不安全"), "{err}");
    assert!(!dest.exists());
    assert!(!tmp.path().join("work/evil.txt").exists());
    assert!(!tmp.path().join("evil.txt").exists());
    // 临时目录也被清理
    let leftovers: Vec<_> = fs::read_dir(tmp.path().join("work")).unwrap().collect();
    assert!(leftovers.is_empty(), "不应留下临时目录：{leftovers:?}");
}

#[test]
fn tar_绝对路径被拒() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("abs.txt");
    let evil = raw_tar_entry(target.to_str().unwrap(), b"x");
    let archive = write_archive(tmp.path(), "abs.tar.gz", &gz(&evil));
    let dest = tmp.path().join("pkg");

    assert!(unpack(&archive, UnpackKind::TarGz, 0, &dest).is_err());
    assert!(!target.exists());
}

#[test]
fn zip_路径穿越被拒() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    w.start_file("../evil.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(b"x").unwrap();
    let bytes = w.finish().unwrap().into_inner();
    let archive = write_archive(tmp.path(), "evil.zip", &bytes);
    let dest = tmp.path().join("work/pkg");

    let err = unpack(&archive, UnpackKind::Zip, 0, &dest).unwrap_err();
    assert!(err.to_string().contains("不安全"), "{err}");
    assert!(!tmp.path().join("work/evil.txt").exists());
    assert!(!dest.exists());
}

#[cfg(unix)]
#[test]
fn 逃出根目录的符号链接被拒_包内相对链接允许() {
    let tmp = tempfile::tempdir().unwrap();

    let escape = write_archive(
        tmp.path(),
        "e1.tar.gz",
        &gz(&symlink_tar("link", "../../etc")),
    );
    assert!(unpack(&escape, UnpackKind::TarGz, 0, &tmp.path().join("p1")).is_err());
    let abs = write_archive(
        tmp.path(),
        "e2.tar.gz",
        &gz(&symlink_tar("link", "/etc/passwd")),
    );
    assert!(unpack(&abs, UnpackKind::TarGz, 0, &tmp.path().join("p2")).is_err());

    // Node 的 bin/npm -> ../lib/... 这类包内相对链接要能正常解
    let ok = write_archive(
        tmp.path(),
        "ok.tar.gz",
        &gz(&symlink_tar("bin/npm", "../lib/npm-cli.js")),
    );
    let dest = tmp.path().join("p3");
    unpack(&ok, UnpackKind::TarGz, 0, &dest).unwrap();
    assert_eq!(
        fs::read_link(dest.join("bin/npm")).unwrap(),
        Path::new("../lib/npm-cli.js")
    );
}

#[test]
fn 已有目录被原子替换() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = write_archive(tmp.path(), "a.tar.gz", &gz(&build_tar()));
    let dest = tmp.path().join("pkg");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("stale.txt"), "旧版本残留").unwrap();

    unpack(&archive, UnpackKind::TarGz, 0, &dest).unwrap();

    assert!(!dest.join("stale.txt").exists(), "旧内容应整体被替换");
    assert_unpacked(&dest, "top");
    let names: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2, "只应剩下压缩包与目标目录：{names:?}");
}

// ---- 以下为审查后补的安全用例 ----

fn tar_with(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    build(&mut b);
    gz(&b.into_inner().unwrap())
}

fn add_symlink(b: &mut tar::Builder<Vec<u8>>, name: &str, target: &str) {
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Symlink);
    h.set_size(0);
    h.set_cksum();
    b.append_link(&mut h, name, target).unwrap();
}

fn add_file(b: &mut tar::Builder<Vec<u8>>, name: &str, body: &[u8]) {
    let mut h = tar::Header::new_gnu();
    h.set_size(body.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    b.append_data(&mut h, name, body).unwrap();
}

#[cfg(unix)]
#[test]
fn tar_符号链接链逃逸被拒() {
    // 审查复现的攻击：a/l1 -> ..，l2 -> a/l1/../victim，再写同名文件 l2
    let tmp = tempfile::tempdir().unwrap();
    let bytes = tar_with(|b| {
        add_symlink(b, "a/l1", "..");
        add_symlink(b, "l2", "a/l1/../victim");
        add_file(b, "l2", b"PWNED");
    });
    let archive = write_archive(tmp.path(), "chain.tar.gz", &bytes);
    let dest = tmp.path().join("work/pkg");

    assert!(unpack(&archive, UnpackKind::TarGz, 0, &dest).is_err());
    assert!(!tmp.path().join("work/victim").exists());
    assert!(!tmp.path().join("victim").exists());
}

#[cfg(unix)]
#[test]
fn tar_经由符号链接目录写文件被拒() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = tar_with(|b| {
        add_symlink(b, "inner/link", ".."); // 指向根（合法），但不能再往里面写
        add_file(b, "inner/link/evil.txt", b"x");
    });
    let archive = write_archive(tmp.path(), "via.tar.gz", &bytes);
    assert!(unpack(&archive, UnpackKind::TarGz, 0, &tmp.path().join("pkg")).is_err());
}

#[cfg(unix)]
#[test]
fn tar_同名文件覆盖符号链接被拒() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = tar_with(|b| {
        add_symlink(b, "s", "target.txt");
        add_file(b, "s", b"x");
    });
    let archive = write_archive(tmp.path(), "over.tar.gz", &bytes);
    assert!(unpack(&archive, UnpackKind::TarGz, 0, &tmp.path().join("pkg")).is_err());
}

fn hardlink_tar(name: &str, target: &str, with_file: bool) -> Vec<u8> {
    tar_with(|b| {
        if with_file {
            add_file(b, "real.txt", b"hello");
        }
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Link);
        h.set_size(0);
        h.set_cksum();
        b.append_link(&mut h, name, target).unwrap();
    })
}

#[cfg(unix)]
#[test]
fn 硬链接源路径同样校验() {
    let tmp = tempfile::tempdir().unwrap();

    // 合法硬链接可用
    let ok = write_archive(
        tmp.path(),
        "ok.tar.gz",
        &hardlink_tar("h.txt", "real.txt", true),
    );
    let dest = tmp.path().join("ok");
    unpack(&ok, UnpackKind::TarGz, 0, &dest).unwrap();
    assert_eq!(fs::read_to_string(dest.join("h.txt")).unwrap(), "hello");

    // 源路径含 .. 或绝对路径
    for (i, src) in ["../../etc/passwd", "/etc/passwd"].iter().enumerate() {
        let bad = write_archive(
            tmp.path(),
            &format!("bad{i}.tar.gz"),
            &hardlink_tar("h.txt", src, false),
        );
        assert!(
            unpack(
                &bad,
                UnpackKind::TarGz,
                0,
                &tmp.path().join(format!("bad{i}"))
            )
            .is_err(),
            "{src}"
        );
    }

    // 源路径经由符号链接目录
    let via = tar_with(|b| {
        add_symlink(b, "d", "sub");
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Link);
        h.set_size(0);
        h.set_cksum();
        b.append_link(&mut h, "h.txt", "d/x").unwrap();
    });
    let via = write_archive(tmp.path(), "via.tar.gz", &via);
    assert!(unpack(&via, UnpackKind::TarGz, 0, &tmp.path().join("via")).is_err());
}

#[cfg(unix)]
#[test]
fn zip_符号链接一律拒绝() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    w.add_symlink("a/l1", "..", opts).unwrap();
    w.add_symlink("l2", "a/l1/../victim", opts).unwrap();
    w.start_file("./l2", opts).unwrap();
    w.write_all(b"PWNED").unwrap();
    let archive = write_archive(tmp.path(), "evil.zip", &w.finish().unwrap().into_inner());
    let dest = tmp.path().join("work/pkg");

    let err = unpack(&archive, UnpackKind::Zip, 0, &dest).unwrap_err();
    assert!(err.to_string().contains("符号链接"), "{err}");
    assert!(!tmp.path().join("work/victim").exists());
    assert!(!dest.exists());

    // 即便是看起来无害的包内相对链接也拒绝
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    w.add_symlink("bin/npm", "../lib/npm", opts).unwrap();
    let archive = write_archive(tmp.path(), "rel.zip", &w.finish().unwrap().into_inner());
    assert!(unpack(&archive, UnpackKind::Zip, 0, &tmp.path().join("pkg2")).is_err());
}

#[test]
fn 解压炸弹被上限拦住且不留残骸() {
    let tmp = tempfile::tempdir().unwrap();
    let zeros = vec![0u8; 5 * 1024 * 1024];
    let limit = 1024 * 1024;

    let tar_bomb = tar_with(|b| add_file(b, "big.bin", &zeros));
    let a = write_archive(tmp.path(), "bomb.tar.gz", &tar_bomb);
    let err =
        unpack_with_limit(&a, UnpackKind::TarGz, 0, &tmp.path().join("w/t"), limit).unwrap_err();
    assert!(err.to_string().contains("异常"), "{err}");

    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    w.start_file("big.bin", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(&zeros).unwrap();
    let z = write_archive(tmp.path(), "bomb.zip", &w.finish().unwrap().into_inner());
    assert!(unpack_with_limit(&z, UnpackKind::Zip, 0, &tmp.path().join("w/z"), limit).is_err());

    let g = write_archive(tmp.path(), "bomb.gz", &gz(&zeros));
    assert!(mingzhi_launcher::single::unpack_gz(&g, &tmp.path().join("w/g.bin"), limit).is_err());

    let left: Vec<_> = fs::read_dir(tmp.path().join("w")).unwrap().collect();
    assert!(left.is_empty(), "不应留下目录或半截文件：{left:?}");
}

#[test]
fn gz_单文件解压并可设可执行位() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = write_archive(tmp.path(), "ffmpeg.gz", &gz(b"binary"));
    let dest = tmp.path().join("data/bin/ffmpeg");
    mingzhi_launcher::single::unpack_gz(&archive, &dest, LIMIT).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"binary");
    mingzhi_launcher::single::set_executable(&dest).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&dest).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }
}

#[test]
fn 清理崩溃遗留的临时目录() {
    let tmp = tempfile::tempdir().unwrap();
    let stale = [".node.unpack-1", ".node.old-2", ".ffmpeg.tmp-3"];
    for name in stale {
        fs::create_dir_all(tmp.path().join(name)).unwrap();
    }
    fs::create_dir_all(tmp.path().join("node")).unwrap();
    fs::write(tmp.path().join(".hidden.txt"), "keep").unwrap();
    let own = format!(".node.unpack-{}", std::process::id());
    fs::create_dir_all(tmp.path().join(&own)).unwrap();

    cleanup_stale(tmp.path());

    for name in stale {
        assert!(!tmp.path().join(name).exists(), "{name} 应被清理");
    }
    assert!(tmp.path().join("node").exists());
    assert!(tmp.path().join(".hidden.txt").exists());
    assert!(tmp.path().join(own).exists(), "本进程自己的临时目录不动");
}

#[test]
fn 占用类错误按退避重试_耗尽后给中文提示() {
    use mingzhi_launcher::fsx::retry_busy;
    use std::io;
    use std::time::Duration;

    let delays = [Duration::from_millis(1); 3];
    let mut calls = 0;
    let res = retry_busy(&delays, || {
        calls += 1;
        if calls < 3 {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        } else {
            Ok(calls)
        }
    });
    assert_eq!(res.unwrap(), 3, "第三次成功");

    let mut calls = 0;
    let err = retry_busy::<()>(&delays, || {
        calls += 1;
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    })
    .unwrap_err();
    assert_eq!(calls, 4, "首次 + 3 次重试");
    assert!(err.to_string().contains("文件被占用"), "{err}");

    // 非占用类错误不重试
    let mut calls = 0;
    let _ = retry_busy::<()>(&delays, || {
        calls += 1;
        Err(io::Error::from(io::ErrorKind::NotFound))
    });
    assert_eq!(calls, 1);
}
