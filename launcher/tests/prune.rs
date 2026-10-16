//! 旧版本清理：只删 AppRoot 内、名称符合版本号模式、当前清单没引用的目录。

use mingzhi_launcher::manifest::Manifest;
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::prune::prune;
use mingzhi_launcher::state::{InstalledItem, State};
use std::fs;
use std::path::Path;

const PLATFORM: &str = "darwin-arm64";

fn manifest(version: &str, chrome: &str) -> Manifest {
    Manifest::parse(&format!(
        r#"{{"version":"{version}","items":[
          {{"id":"chrome-darwin-arm64","kind":"chrome","platform":"darwin-arm64","sha256":"00","size":1,
            "dest":"runtime/chrome-headless-shell/{chrome}/mac-arm64","unpack":"zip",
            "exec":"runtime/chrome-headless-shell/{chrome}/mac-arm64/chrome-headless-shell",
            "urls":["http://x/c"]}},
          {{"id":"app-darwin-arm64","kind":"app","platform":"darwin-arm64","sha256":"11","size":1,
            "dest":"{{app}}","unpack":"tar.zst","urls":["http://x/a"]}}
        ]}}"#
    ))
    .unwrap()
}

fn mkdir(root: &AppRoot, rel: &str) {
    let dir = root.root().join(rel);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("f"), "x").unwrap();
}

fn exists(root: &AppRoot, rel: &str) -> bool {
    root.root().join(rel).exists()
}

fn setup() -> (tempfile::TempDir, AppRoot) {
    let tmp = tempfile::tempdir().unwrap();
    let root = AppRoot::new(tmp.path().join("Mingzhi"));
    (tmp, root)
}

#[test]
fn 旧版chrome被清理当前的保留() {
    let (_tmp, root) = setup();
    mkdir(&root, "runtime/chrome-headless-shell/148.0.1.0/mac-arm64");
    mkdir(
        &root,
        "runtime/chrome-headless-shell/149.0.7790.0/mac-arm64",
    );
    mkdir(&root, "runtime/node");

    let removed = prune(&root, &manifest("0.2.0", "149.0.7790.0"), PLATFORM);

    assert_eq!(
        removed,
        vec![root.root().join("runtime/chrome-headless-shell/148.0.1.0")]
    );
    assert!(!exists(&root, "runtime/chrome-headless-shell/148.0.1.0"));
    assert!(exists(
        &root,
        "runtime/chrome-headless-shell/149.0.7790.0/mac-arm64/f"
    ));
    assert!(exists(&root, "runtime/node/f"), "其它 runtime 不碰");
}

#[test]
fn chrome容器里名字不像版本号的不碰() {
    let (_tmp, root) = setup();
    mkdir(&root, "runtime/chrome-headless-shell/149.0.7790.0");
    mkdir(&root, "runtime/chrome-headless-shell/我的备份");
    mkdir(&root, "runtime/chrome-headless-shell/old-149");
    fs::write(
        root.root().join("runtime/chrome-headless-shell/148.0.1.0"),
        "文件不是目录",
    )
    .unwrap();

    let removed = prune(&root, &manifest("0.2.0", "149.0.7790.0"), PLATFORM);

    assert!(removed.is_empty(), "{removed:?}");
    assert!(exists(&root, "runtime/chrome-headless-shell/我的备份/f"));
    assert!(exists(&root, "runtime/chrome-headless-shell/old-149/f"));
    assert!(exists(&root, "runtime/chrome-headless-shell/148.0.1.0"));
}

#[test]
fn 清单里没有chrome时不删任何chrome目录() {
    let (_tmp, root) = setup();
    mkdir(&root, "runtime/chrome-headless-shell/148.0.1.0");
    let m = Manifest::parse(r#"{"version":"0.2.0","items":[]}"#).unwrap();
    assert!(prune(&root, &m, PLATFORM).is_empty());
    assert!(exists(&root, "runtime/chrome-headless-shell/148.0.1.0/f"));
}

#[test]
fn app目录只保留当前版本() {
    let (_tmp, root) = setup();
    for v in ["0.0.9", "0.1.0", "0.1.5", "0.2.0"] {
        mkdir(&root, &format!("app/{v}"));
    }
    let removed = prune(&root, &manifest("0.2.0", "149.0.7790.0"), PLATFORM);

    let mut names: Vec<_> = removed
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["0.0.9", "0.1.0", "0.1.5"], "上一版也删");
    assert!(exists(&root, "app/0.2.0/f"));
}

#[test]
fn 比当前新的app目录和不是严格semver的目录不碰() {
    let (_tmp, root) = setup();
    let keep = [
        "0.2.0",
        "0.3.0",
        "tmp",
        "backup-0.0.1",
        "0.2",
        "0.0.1-backup",
        "v0.0.1",
        "0.0.1.0",
        "0.0.1-rc.1",
        "00.0.1x",
    ];
    for v in keep {
        mkdir(&root, &format!("app/{v}"));
    }
    let removed = prune(&root, &manifest("0.2.0", "149.0.7790.0"), PLATFORM);
    assert!(removed.is_empty(), "{removed:?}");
    for v in keep {
        assert!(exists(&root, &format!("app/{v}/f")), "{v}");
    }
}

#[cfg(unix)]
#[test]
fn 符号链接不跟随不删除() {
    let (_tmp, root) = setup();
    mkdir(&root, "app/0.2.0");
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep"), "x").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.app().join("0.0.1")).unwrap();

    let removed = prune(&root, &manifest("0.2.0", "149.0.7790.0"), PLATFORM);

    assert!(removed.is_empty(), "{removed:?}");
    assert!(
        outside.path().join("keep").exists(),
        "链接指向的目录不能被动"
    );
}

#[test]
fn 被清理目录的安装记录一并去掉其它记录保留() {
    let (_tmp, root) = setup();
    mkdir(&root, "app/0.0.9");
    mkdir(&root, "app/0.1.0");
    mkdir(&root, "app/0.2.0");
    let rec = || InstalledItem {
        sha256: "11".into(),
        size: 1,
        mtime_ms: None,
    };
    let state = [
        "app-darwin-arm64@app/0.0.9",
        "app-darwin-arm64@app/0.1.0",
        "app-darwin-arm64@app/0.2.0",
        "node-darwin-arm64@runtime/node",
        "legacy-id",
    ]
    .iter()
    .fold(State::default(), |s, k| {
        let mut next = s.clone();
        next.installed.insert(k.to_string(), rec());
        next
    });
    fs::create_dir_all(root.root()).unwrap();
    state.save(&root.state_file()).unwrap();

    prune(&root, &manifest("0.2.0", "149.0.7790.0"), PLATFORM);

    let keys: Vec<String> = State::load(&root.state_file())
        .unwrap()
        .installed
        .into_keys()
        .collect();
    assert_eq!(
        keys,
        vec![
            "app-darwin-arm64@app/0.2.0",
            "legacy-id",
            "node-darwin-arm64@runtime/node"
        ]
    );
}

#[test]
fn 目录不存在时什么也不做() {
    let (_tmp, root) = setup();
    assert!(prune(&root, &manifest("0.2.0", "149.0.7790.0"), PLATFORM).is_empty());
    assert!(
        !Path::new(&root.state_file()).exists(),
        "没有清理就不写 state"
    );
}
