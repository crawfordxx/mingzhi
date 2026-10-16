//! 起本机服务：参数与环境变量、从 stdout 读地址、/api/status 就绪、崩溃原因、退出时结束子进程。
//! 用假 node（shell 脚本转调系统 node 跑 tests/fixtures/fake-server.mjs）模拟服务。
#![cfg(unix)]

use mingzhi_launcher::manifest::Manifest;
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::run::{service_spec, Service, ServiceSpec, DEFAULT_PORT};
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MANIFEST: &str = r#"{"version":"9.9.9","items":[
  {"id":"node-darwin-arm64","kind":"node","platform":"darwin-arm64","sha256":"00","size":1,
   "dest":"runtime/node","unpack":"tar.gz","exec":"runtime/node/bin/node","urls":["http://x/n"]},
  {"id":"chrome-darwin-arm64","kind":"chrome","platform":"darwin-arm64","sha256":"00","size":1,
   "dest":"runtime/chrome/mac-arm64","unpack":"zip","exec":"runtime/chrome/mac-arm64/chrome-headless-shell","urls":["http://x/c"]},
  {"id":"node-win32-x64","kind":"node","platform":"win32-x64","sha256":"00","size":1,
   "dest":"runtime/node","unpack":"zip","exec":"runtime/node/node.exe","urls":["http://x/n"]}
]}"#;

fn touch(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "").unwrap();
}

#[test]
fn 服务参数与环境变量() {
    let dir = tempfile::tempdir().unwrap();
    let root = AppRoot::new(dir.path());
    let m = Manifest::parse(MANIFEST).unwrap();

    // 应用目录还不在：报应用不完整
    touch(&root.root().join("runtime/node/bin/node"));
    let err = service_spec(&root, &m, "darwin-arm64", None).unwrap_err();
    assert!(err.to_string().contains("应用"), "{err}");

    touch(&root.app().join("9.9.9/src/server/index.ts"));
    touch(
        &root
            .root()
            .join("runtime/chrome/mac-arm64/chrome-headless-shell"),
    );
    let spec = service_spec(&root, &m, "darwin-arm64", None).unwrap();
    assert_eq!(spec.node, root.root().join("runtime/node/bin/node"));
    assert_eq!(spec.cwd, root.app().join("9.9.9"));
    let args: Vec<String> = spec
        .args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args[0..2], ["--import", "tsx"]);
    assert!(args[2].starts_with("--import=data:text/javascript,"));
    assert_eq!(args.last().unwrap(), "src/server/index.ts");
    let env = |k: &str| {
        spec.env
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| PathBuf::from(v))
    };
    assert_eq!(env("MINGZHI_DATA_DIR"), Some(root.data()));
    assert_eq!(env("MINGZHI_PORT"), Some(PathBuf::from("4321")));
    assert_eq!(DEFAULT_PORT, 4321);
    assert_eq!(
        env("MINGZHI_CHROME"),
        Some(
            root.root()
                .join("runtime/chrome/mac-arm64/chrome-headless-shell")
        )
    );

    // MINGZHI_APP_DIR 覆盖：用开发目录当应用本体
    let dev = tempfile::tempdir().unwrap();
    touch(&dev.path().join("src/server/index.ts"));
    let spec = service_spec(&root, &m, "darwin-arm64", Some(dev.path().to_path_buf())).unwrap();
    assert_eq!(spec.cwd, dev.path());

    // 没装 Node：报运行环境缺失
    fs::remove_file(root.root().join("runtime/node/bin/node")).unwrap();
    let err = service_spec(&root, &m, "darwin-arm64", None).unwrap_err();
    assert!(err.to_string().contains("Node"), "{err}");
}

/// 假 node：转调系统 node 跑假服务，忽略真实参数。
fn fake_spec(mode: &str, port: u16) -> (tempfile::TempDir, ServiceSpec) {
    let dir = tempfile::tempdir().unwrap();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-server.mjs");
    let script = dir.path().join("node");
    fs::write(
        &script,
        format!("#!/bin/sh\nexec node {:?}\n", fixture.display().to_string()),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let spec = ServiceSpec {
        node: script,
        args: vec![OsString::from("ignored")],
        cwd: dir.path().to_path_buf(),
        env: vec![
            ("MINGZHI_PORT".into(), port.to_string().into()),
            ("FAKE_MODE".into(), mode.into()),
        ],
        ready_timeout: Duration::from_secs(10),
    };
    (dir, spec)
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[test]
fn 读出实际地址且status就绪() {
    let (dir, spec) = fake_spec("ok", 0);
    let svc = Service::start(&spec).unwrap();
    assert!(svc.url().starts_with("http://127.0.0.1:"), "{}", svc.url());
    let status = ureq::get(&format!("{}/api/status", svc.url()))
        .call()
        .unwrap();
    assert_eq!(status.status(), 200);
    let dump = fs::read_to_string(dir.path().join("fake-env.json")).unwrap();
    assert!(dump.contains("\"FAKE_MODE\":\"ok\""));
}

#[test]
fn 端口被占用时读到顺延后的端口() {
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = busy.local_addr().unwrap().port();
    let (_dir, spec) = fake_spec("ok", port);
    let svc = Service::start(&spec).unwrap();
    let got: u16 = svc.url().rsplit(':').next().unwrap().parse().unwrap();
    assert!(got > port, "应顺延：{got} vs {port}");
}

#[test]
fn 启动失败带原因() {
    let (_dir, spec) = fake_spec("crash", 0);
    let err = Service::start(&spec).err().expect("应失败");
    assert!(err.to_string().contains("EADDRINUSE"), "{err}");
}

#[test]
fn 一直不输出地址则超时() {
    let (_dir, mut spec) = fake_spec("silent", 0);
    spec.ready_timeout = Duration::from_millis(800);
    let started = Instant::now();
    let err = Service::start(&spec).err().expect("应超时");
    assert!(err.to_string().contains("没有在"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn status一直不是200则超时() {
    let (_dir, mut spec) = fake_spec("not-ready", 0);
    spec.ready_timeout = Duration::from_millis(1200);
    let err = Service::start(&spec).err().expect("应超时");
    assert!(err.to_string().contains("没有在"), "{err}");
}

#[test]
fn 运行中崩溃能拿到原因() {
    let (_dir, spec) = fake_spec("crash-later", 0);
    let mut svc = Service::start(&spec).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let reason = loop {
        if let Some(r) = svc.exited() {
            break r;
        }
        assert!(Instant::now() < deadline, "应检测到退出");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(reason.contains("boom"), "{reason}");
}

#[test]
fn 停止或丢弃时结束子进程() {
    let (_dir, spec) = fake_spec("ok", 0);
    let svc = Service::start(&spec).unwrap();
    let pid = svc.pid();
    assert!(alive(pid));
    drop(svc);
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        assert!(Instant::now() < deadline, "子进程应已结束");
        std::thread::sleep(Duration::from_millis(50));
    }
}
