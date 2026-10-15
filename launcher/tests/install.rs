//! 端到端安装：并发下载 + 解包 + 二次运行跳过已装项。

mod common;

use common::{archive_item, item, sample_bytes, Behavior, TestServer};
use mingzhi_launcher::download::Downloader;
use mingzhi_launcher::install::sync;
use mingzhi_launcher::manifest::{Manifest, UnpackKind};
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::progress::Progress;
use mingzhi_launcher::proxy::ProxyConfig;
use mingzhi_launcher::state::State;
use std::fs;
use std::io::Write;
use std::time::Duration;

const PLATFORM: &str = "darwin-arm64";

fn downloader() -> Downloader {
    Downloader::new(ProxyConfig::none(), Progress::new()).with_retry_delay(Duration::ZERO)
}

fn app_targz() -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    let body = b"console.log('ok')";
    let mut h = tar::Header::new_gnu();
    h.set_size(body.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    b.append_data(&mut h, "pkg/src/index.js", &body[..])
        .unwrap();
    let tar = b.into_inner().unwrap();
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(&tar).unwrap();
    e.finish().unwrap()
}

struct Fixture {
    server: TestServer,
    root: AppRoot,
    manifest: Manifest,
    model: Vec<u8>,
    _tmp: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let server = TestServer::start();
    let model = sample_bytes(200_000, 9);
    let app = app_targz();
    let other = sample_bytes(30_000, 10);
    server.route("/model.bin", vec![Behavior::Serve(model.clone())]);
    server.route("/app.tar.gz", vec![Behavior::Serve(app.clone())]);
    server.route("/other.bin", vec![Behavior::Serve(other.clone())]);

    let mut mac_only = item(
        "mac-tool",
        &other,
        "data/bin/tool",
        vec![server.url("/other.bin")],
    );
    mac_only.platform = "win32-x64".to_string(); // 非本平台，应被过滤
    let manifest = Manifest {
        version: "1.2.3".to_string(),
        items: vec![
            item(
                "model",
                &model,
                "data/models/model.bin",
                vec![server.url("/model.bin")],
            ),
            archive_item(
                "app",
                &app,
                "{app}",
                UnpackKind::TarGz,
                1,
                vec![server.url("/app.tar.gz")],
            ),
            mac_only,
        ],
    };
    let tmp = tempfile::tempdir().unwrap();
    let root = AppRoot::new(tmp.path().join("Mingzhi"));
    Fixture {
        server,
        root,
        manifest,
        model,
        _tmp: tmp,
    }
}

#[test]
fn 首次安装后二次运行不再请求也不重装() {
    let fx = fixture();

    let first = sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(first.skipped.len(), 0);
    let mut installed = first.installed.clone();
    installed.sort();
    assert_eq!(installed, vec!["app", "model"], "win32 的项应被过滤");

    assert_eq!(
        fs::read(fx.root.data().join("models/model.bin")).unwrap(),
        fx.model
    );
    assert_eq!(
        fs::read_to_string(fx.root.app().join("1.2.3/src/index.js")).unwrap(),
        "console.log('ok')"
    );
    assert!(!fx.root.data().join("bin/tool").exists());
    let leftovers: Vec<_> = fs::read_dir(fx.root.downloads()).unwrap().collect();
    assert!(leftovers.is_empty(), "下载目录应被清理：{leftovers:?}");
    let requests_after_first = fx.server.total_requests();
    assert_eq!(requests_after_first, 2);

    let second = sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    assert!(second.installed.is_empty());
    let mut skipped = second.skipped.clone();
    skipped.sort();
    assert_eq!(skipped, vec!["app", "model"]);
    assert_eq!(
        fx.server.total_requests(),
        requests_after_first,
        "二次运行不应再有网络请求"
    );
}

#[test]
fn state_记录了安装项且保留未知字段() {
    let fx = fixture();
    fs::create_dir_all(fx.root.root()).unwrap();
    fs::write(
        fx.root.state_file(),
        r#"{"settings":{"githubProxy":"https://example.test/"}}"#,
    )
    .unwrap();

    sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();

    let state = State::load(&fx.root.state_file()).unwrap();
    assert!(state.installed.contains_key("model") && state.installed.contains_key("app"));
    assert_eq!(
        state.extra["settings"]["githubProxy"],
        "https://example.test/"
    );
    assert!(state.installed["model"].mtime_ms.is_some());
    assert!(state.installed["app"].mtime_ms.is_none());
}

#[test]
fn mtime变了但内容一致时只重算哈希不重下() {
    let fx = fixture();
    sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    let before = fx.server.total_requests();

    // 改 mtime 而不改内容：重写同样的字节
    let model_path = fx.root.data().join("models/model.bin");
    std::thread::sleep(Duration::from_millis(20));
    fs::write(&model_path, &fx.model).unwrap();

    let report = sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    assert!(report.installed.is_empty());
    assert!(report.skipped.contains(&"model".to_string()));
    assert_eq!(fx.server.total_requests(), before);

    // 记录已刷新，再来一次走快速路径（mtime 与记录一致）
    let state = State::load(&fx.root.state_file()).unwrap();
    let meta_ms = fs::metadata(&model_path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert_eq!(state.installed["model"].mtime_ms, Some(meta_ms));
}

#[test]
fn 文件被改坏后重新下载() {
    let fx = fixture();
    sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    let model_path = fx.root.data().join("models/model.bin");
    let mut broken = fx.model.clone();
    broken[0] ^= 0xff;
    std::thread::sleep(Duration::from_millis(20));
    fs::write(&model_path, broken).unwrap();

    let report = sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(report.installed, vec!["model"]);
    assert_eq!(fs::read(&model_path).unwrap(), fx.model);
}

#[test]
fn 目录被删除后重新安装() {
    let fx = fixture();
    sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    fs::remove_dir_all(fx.root.app().join("1.2.3")).unwrap();

    let report = sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(report.installed, vec!["app"]);
    assert!(fx.root.app().join("1.2.3/src/index.js").is_file());
}

#[test]
fn 某项失败时返回带项名的错误() {
    let fx = fixture();
    let mut manifest = fx.manifest.clone();
    let broken = item(
        "broken",
        b"never",
        "data/broken.bin",
        vec![fx.server.url("/missing.bin")],
    );
    manifest.items.push(broken);

    let err = sync(&fx.root, &manifest, PLATFORM, &downloader()).unwrap_err();
    assert!(err.to_string().contains("broken"), "{err}");
}
