//! 数据版本标记：旧版启动器不碰新版用过的数据。

use mingzhi_launcher::dataver::{ensure, MARKER};
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::version::Version;
use std::cmp::Ordering;
use std::fs;

fn root() -> (tempfile::TempDir, AppRoot) {
    let tmp = tempfile::tempdir().unwrap();
    let root = AppRoot::new(tmp.path().join("Mingzhi"));
    (tmp, root)
}

fn marker(root: &AppRoot) -> String {
    fs::read_to_string(root.data().join(MARKER)).unwrap()
}

#[test]
fn 没有标记时写入自己的版本() {
    let (_tmp, root) = root();
    ensure(&root, "0.2.0").unwrap();
    assert_eq!(marker(&root), "0.2.0");
}

#[test]
fn 标记比自己旧时升级标记() {
    let (_tmp, root) = root();
    ensure(&root, "0.1.0").unwrap();
    ensure(&root, "0.2.0").unwrap();
    assert_eq!(marker(&root), "0.2.0");
}

#[test]
fn 标记比自己新时报错且不改数据() {
    let (_tmp, root) = root();
    ensure(&root, "0.10.0").unwrap();
    let err = ensure(&root, "0.9.0").unwrap_err().to_string();
    assert!(err.contains("请使用最新版启动器"), "{err}");
    assert!(err.contains("0.10.0") && err.contains("0.9.0"), "{err}");
    assert_eq!(marker(&root), "0.10.0", "标记保持不变");
}

#[test]
fn 相同版本重复启动无变化() {
    let (_tmp, root) = root();
    ensure(&root, "1.0.0").unwrap();
    ensure(&root, "1.0.0").unwrap();
    assert_eq!(marker(&root), "1.0.0");
}

#[test]
fn 看不懂的标记按没有处理() {
    let (_tmp, root) = root();
    fs::create_dir_all(root.data()).unwrap();
    fs::write(root.data().join(MARKER), "乱码").unwrap();
    ensure(&root, "0.1.0").unwrap();
    assert_eq!(marker(&root), "0.1.0");
}

#[test]
fn 预发布比同号正式版旧() {
    let (_tmp, root) = root();
    ensure(&root, "1.0.0").unwrap();
    // 正式版用过的数据，预发布版不能再用
    assert!(ensure(&root, "1.0.0-rc.1").is_err());
    assert_eq!(
        Version::cmp_str("1.0.0-rc.1", "1.0.0"),
        Some(Ordering::Less)
    );
}

#[test]
fn 版本号解析() {
    assert!(Version::parse("1.2.3").is_some());
    assert!(Version::parse("v1.2.3-rc.1").is_some());
    for bad in ["", "1.2", "1.2.3.4", "a.b.c", "1.2.3-", "1..3", "../x"] {
        assert!(Version::parse(bad).is_none(), "{bad:?}");
    }
    assert_eq!(Version::cmp_str("0.10.0", "0.9.0"), Some(Ordering::Greater));
}
