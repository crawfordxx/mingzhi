//! 解包：四种格式、strip、可执行位、路径穿越与符号链接逃逸、原子替换。

use mingzhi_launcher::manifest::UnpackKind;
use mingzhi_launcher::unpack::unpack;
use std::fs;
use std::io::Write;
use std::path::Path;

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
