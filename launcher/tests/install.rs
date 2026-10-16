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
/// 记录键：id@展开后的 dest（见 Item::record_key）
const MODEL_KEY: &str = "model@data/models/model.bin";
const APP_KEY: &str = "app@app/1.2.3";

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
    assert!(state.installed.contains_key(MODEL_KEY) && state.installed.contains_key(APP_KEY));
    assert_eq!(
        state.extra["settings"]["githubProxy"],
        "https://example.test/"
    );
    assert!(state.installed[MODEL_KEY].mtime_ms.is_some());
    assert!(state.installed[APP_KEY].mtime_ms.is_none());
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
    assert_eq!(state.installed[MODEL_KEY].mtime_ms, Some(meta_ms));
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

// ---- 以下为审查后补的用例 ----

use mingzhi_launcher::manifest::{Entry, Item};

fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, body) in files {
        w.start_file(
            *name,
            zip::write::SimpleFileOptions::default().unix_permissions(0o644),
        )
        .unwrap();
        w.write_all(body).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn gz_bytes(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn new_root() -> (tempfile::TempDir, AppRoot) {
    let tmp = tempfile::tempdir().unwrap();
    let root = AppRoot::new(tmp.path().join("Mingzhi"));
    (tmp, root)
}

/// app（整体替换型）+ 嵌套在 app 目录里的 chrome（带 exec）。chrome 故意排在 app 前面。
fn nested_manifest(server: &TestServer, app_files: &[(&str, &[u8])]) -> Manifest {
    let app = zip_bytes(app_files);
    let chrome = zip_bytes(&[
        ("chrome-headless-shell", b"CHROME"),
        ("lib/x.dylib", b"LIB"),
    ]);
    server.route("/app.zip", vec![Behavior::Serve(app.clone())]);
    server.route("/chrome.zip", vec![Behavior::Serve(chrome.clone())]);
    let chrome_item = Item {
        exec: Some(
            "{app}/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell"
                .into(),
        ),
        ..archive_item(
            "chrome",
            &chrome,
            "{app}/node_modules/.remotion/chrome-headless-shell/mac-arm64",
            UnpackKind::Zip,
            0,
            vec![server.url("/chrome.zip")],
        )
    };
    let app_item = archive_item(
        "app",
        &app,
        "{app}",
        UnpackKind::Zip,
        0,
        vec![server.url("/app.zip")],
    );
    Manifest {
        version: "2.0.0".into(),
        items: vec![chrome_item, app_item],
    }
}

fn assert_nested_ok(root: &AppRoot) {
    let app = root.app().join("2.0.0");
    assert!(app.join("src/index.js").is_file(), "app 本体");
    let chrome = app.join("node_modules/.remotion/chrome-headless-shell");
    assert_eq!(
        fs::read(chrome.join("mac-arm64/chrome-headless-shell")).unwrap(),
        b"CHROME"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(chrome.join("mac-arm64/chrome-headless-shell"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "exec 指向的文件要有可执行位");
    }
}

#[test]
fn 嵌套dest先装外层再装内层() {
    // 并发 2 且 chrome 排在前面：没有顺序约束时 chrome 会先落盘再被 app 的目录替换带走
    for round in 0..10 {
        let server = TestServer::start();
        let manifest = nested_manifest(&server, &[("src/index.js", b"v1")]);
        let (_tmp, root) = new_root();
        sync(&root, &manifest, PLATFORM, &downloader())
            .unwrap_or_else(|e| panic!("第 {round} 轮：{e}"));
        assert_nested_ok(&root);
    }
}

#[test]
fn 外层被重装时内层已装项也随之重装() {
    let server = TestServer::start();
    let manifest = nested_manifest(&server, &[("src/index.js", b"v1")]);
    let (_tmp, root) = new_root();
    sync(&root, &manifest, PLATFORM, &downloader()).unwrap();

    // 同版本号下 app 包内容变了（sha 变），chrome 没变
    let server2 = TestServer::start();
    let manifest2 = nested_manifest(&server2, &[("src/index.js", b"v2-changed")]);
    let mut manifest2 = manifest2;
    manifest2.items[0] = manifest.items[0].clone(); // chrome 沿用旧项（sha 不变）
    manifest2.items[0].urls = vec![server2.url("/chrome.zip")];

    let report = sync(&root, &manifest2, PLATFORM, &downloader()).unwrap();
    let mut installed = report.installed.clone();
    installed.sort();
    assert_eq!(
        installed,
        vec!["app", "chrome"],
        "chrome 在 app 目录内，必须跟着重装"
    );
    assert_eq!(
        fs::read(root.app().join("2.0.0/src/index.js")).unwrap(),
        b"v2-changed"
    );
    assert_nested_ok_after_replace(&root);
}

fn assert_nested_ok_after_replace(root: &AppRoot) {
    let chrome = root
        .app()
        .join("2.0.0/node_modules/.remotion/chrome-headless-shell");
    assert!(chrome.join("mac-arm64/chrome-headless-shell").is_file());
}

#[test]
fn exec文件被删后重新安装该项() {
    let server = TestServer::start();
    let manifest = nested_manifest(&server, &[("src/index.js", b"v1")]);
    let (_tmp, root) = new_root();
    sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    fs::remove_file(root.app().join(
        "2.0.0/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell",
    ))
    .unwrap();

    let report = sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(report.installed, vec!["chrome"]);
    assert_nested_ok(&root);
}

#[test]
fn gz单文件加可执行位且二次运行跳过() {
    let server = TestServer::start();
    let gz = gz_bytes(b"#!/bin/sh\necho ffmpeg\n");
    server.route("/ffmpeg.gz", vec![Behavior::Serve(gz.clone())]);
    let it = Item {
        executable: true,
        kind: "ffmpeg".into(),
        ..archive_item(
            "ffmpeg",
            &gz,
            "data/bin/ffmpeg",
            UnpackKind::Gz,
            0,
            vec![server.url("/ffmpeg.gz")],
        )
    };
    let manifest = Manifest {
        version: "1.0.0".into(),
        items: vec![it],
    };
    let (_tmp, root) = new_root();

    let first = sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(first.installed, vec!["ffmpeg"]);
    let bin = root.data().join("bin/ffmpeg");
    assert_eq!(fs::read(&bin).unwrap(), b"#!/bin/sh\necho ffmpeg\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&bin).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }

    let before = server.total_requests();
    let second = sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(second.skipped, vec!["ffmpeg"]);
    assert_eq!(server.total_requests(), before);
}

#[test]
fn 压缩包里只取指定entry且缺文件时重装() {
    let server = TestServer::start();
    let zip = zip_bytes(&[
        ("fonts/Noto.ttf", b"FONT"),
        ("fonts/other.ttf", b"OTHER"),
        ("README", b"r"),
    ]);
    server.route("/font.zip", vec![Behavior::Serve(zip.clone())]);
    let it = Item {
        entries: vec![Entry {
            entry: "fonts/Noto.ttf".into(),
            dest: "data/assets/fonts/Noto.ttf".into(),
            transcode: None,
        }],
        kind: "asset".into(),
        ..archive_item(
            "font",
            &zip,
            "data/assets/fonts",
            UnpackKind::Zip,
            0,
            vec![server.url("/font.zip")],
        )
    };
    let manifest = Manifest {
        version: "1.0.0".into(),
        items: vec![it],
    };
    let (_tmp, root) = new_root();

    sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(
        fs::read(root.data().join("assets/fonts/Noto.ttf")).unwrap(),
        b"FONT"
    );
    assert!(
        !root.data().join("assets/fonts/other.ttf").exists(),
        "只取清单里的 entry"
    );

    assert_eq!(
        sync(&root, &manifest, PLATFORM, &downloader())
            .unwrap()
            .skipped,
        vec!["font"]
    );

    fs::remove_file(root.data().join("assets/fonts/Noto.ttf")).unwrap();
    let again = sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(again.installed, vec!["font"]);
}

#[cfg(unix)]
#[test]
fn 配乐转码排在ffmpeg之后() {
    // 用一个「拷贝输入到输出」的假 ffmpeg 脚本（gz 打包）验证顺序与参数
    let server = TestServer::start();
    let script = b"#!/bin/sh\nwhile [ $# -gt 1 ]; do if [ \"$1\" = \"-i\" ]; then IN=\"$2\"; fi; shift; done\ncp \"$IN\" \"$1\"\n";
    let ff_gz = gz_bytes(script);
    let music = zip_bytes(&[("tracks/a.wav", b"RAW-AUDIO")]);
    server.route("/ffmpeg.gz", vec![Behavior::Serve(ff_gz.clone())]);
    server.route("/music.zip", vec![Behavior::Serve(music.clone())]);
    let ffmpeg = Item {
        executable: true,
        kind: "ffmpeg".into(),
        ..archive_item(
            "ffmpeg",
            &ff_gz,
            "data/bin/ffmpeg",
            UnpackKind::Gz,
            0,
            vec![server.url("/ffmpeg.gz")],
        )
    };
    let track = Item {
        entries: vec![Entry {
            entry: "tracks/a.wav".into(),
            dest: "data/assets/music/a.mp3".into(),
            transcode: Some("mp3".into()),
        }],
        kind: "asset".into(),
        ..archive_item(
            "music",
            &music,
            "data/assets/music",
            UnpackKind::Zip,
            0,
            vec![server.url("/music.zip")],
        )
    };
    // 配乐故意排在 ffmpeg 前面
    let manifest = Manifest {
        version: "1.0.0".into(),
        items: vec![track, ffmpeg],
    };
    for _ in 0..5 {
        let (_tmp, root) = new_root();
        sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
        assert_eq!(
            fs::read(root.data().join("assets/music/a.mp3")).unwrap(),
            b"RAW-AUDIO"
        );
        let leftovers: Vec<_> = fs::read_dir(root.data().join("assets/music"))
            .unwrap()
            .collect();
        assert_eq!(leftovers.len(), 1, "不应留下临时文件：{leftovers:?}");
    }
}

#[test]
fn 启动时清理上次崩溃遗留的临时目录() {
    let fx = fixture();
    fs::create_dir_all(fx.root.app().join(".1.2.3.unpack-99999")).unwrap();
    fs::create_dir_all(fx.root.data().join("models")).unwrap();
    fs::create_dir_all(fx.root.data().join("models/.model.bin.tmp-99999")).unwrap();
    // 另一个实例刚创建的临时目录（新）不能被误删
    fs::create_dir_all(fx.root.app().join(".1.2.3.unpack-88888")).unwrap();
    for stale in [
        fx.root.app().join(".1.2.3.unpack-99999"),
        fx.root.data().join("models/.model.bin.tmp-99999"),
    ] {
        let old = std::time::SystemTime::now() - Duration::from_secs(2 * 3600);
        fs::File::open(&stale).unwrap().set_modified(old).unwrap();
    }

    sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();

    assert!(!fx.root.app().join(".1.2.3.unpack-99999").exists());
    assert!(!fx.root.data().join("models/.model.bin.tmp-99999").exists());
    assert!(
        fx.root.app().join(".1.2.3.unpack-88888").exists(),
        "不到 1 小时的不清理"
    );
}

#[test]
fn entries项的输出不在dest目录内时二次运行也能跳过() {
    let server = TestServer::start();
    let zip = zip_bytes(&[("a.ttf", b"FONT")]);
    server.route("/f.zip", vec![Behavior::Serve(zip.clone())]);
    let it = Item {
        entries: vec![Entry {
            entry: "a.ttf".into(),
            dest: "data/assets/fonts/a.ttf".into(),
            transcode: None,
        }],
        ..archive_item(
            "font",
            &zip,
            "data/assets/unused-dir",
            UnpackKind::Zip,
            0,
            vec![server.url("/f.zip")],
        )
    };
    let manifest = Manifest {
        version: "1.0.0".into(),
        items: vec![it],
    };
    let (_tmp, root) = new_root();

    sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    let before = server.total_requests();
    let second = sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    assert_eq!(second.skipped, vec!["font"]);
    assert_eq!(server.total_requests(), before);
}

#[cfg(unix)]
#[test]
fn zip里丢了权限位时exec仍被设为可执行() {
    let server = TestServer::start();
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    // 不写 unix_permissions：模拟外部属性丢失
    w.start_file("bin/chrome", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(b"CHROME").unwrap();
    let zip = w.finish().unwrap().into_inner();
    server.route("/c.zip", vec![Behavior::Serve(zip.clone())]);
    let it = Item {
        exec: Some("runtime/chrome/bin/chrome".into()),
        kind: "chrome".into(),
        ..archive_item(
            "chrome",
            &zip,
            "runtime/chrome",
            UnpackKind::Zip,
            0,
            vec![server.url("/c.zip")],
        )
    };
    let manifest = Manifest {
        version: "1.0.0".into(),
        items: vec![it],
    };
    let (_tmp, root) = new_root();
    sync(&root, &manifest, PLATFORM, &downloader()).unwrap();

    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(root.root().join("runtime/chrome/bin/chrome"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0o111);
}

// ---- Task 3：可选项、过滤、逐项阶段 ----

use mingzhi_launcher::install::sync_with;
use mingzhi_launcher::progress::Phase;

#[test]
fn 可选项失败记入已跳过且不让sync失败() {
    let fx = fixture();
    let mut manifest = fx.manifest.clone();
    let mut music = item(
        "music",
        b"never",
        "data/assets/m.zip",
        vec![fx.server.url("/missing.bin")],
    );
    music.optional = true;
    manifest.items.push(music);

    let dl = downloader();
    let report = sync(&fx.root, &manifest, PLATFORM, &dl).unwrap();
    assert_eq!(report.deferred, vec!["music"]);
    assert!(report.installed.contains(&"model".to_string()));
    let music_row = dl
        .progress()
        .items()
        .into_iter()
        .find(|i| i.id == "music")
        .unwrap();
    assert_eq!(music_row.phase, Phase::Deferred);
    assert!(music_row.error.unwrap().contains("music"));
    assert!(!State::load(&fx.root.state_file())
        .unwrap()
        .installed
        .contains_key("music"));
}

#[test]
fn 必需项失败时其余项照常装完() {
    let fx = fixture();
    let mut manifest = fx.manifest.clone();
    // 失败项排在最前，其它项仍应全部装好
    manifest.items.insert(
        0,
        item(
            "broken",
            b"never",
            "data/broken.bin",
            vec![fx.server.url("/missing.bin")],
        ),
    );
    let dl = downloader();
    let err = sync(&fx.root, &manifest, PLATFORM, &dl).unwrap_err();
    assert!(err.to_string().contains("broken"));
    let state = State::load(&fx.root.state_file()).unwrap();
    assert!(state.installed.contains_key(MODEL_KEY) && state.installed.contains_key(APP_KEY));
    let rows = dl.progress().items();
    let phase = |id: &str| rows.iter().find(|r| r.id == id).unwrap().phase;
    assert_eq!(phase("broken"), Phase::Failed);
    assert_eq!(phase("model"), Phase::Done);
}

#[test]
fn 按过滤条件只装部分项() {
    let fx = fixture();
    let dl = downloader();
    let report = sync_with(&fx.root, &fx.manifest, PLATFORM, &dl, |i| i.id == "model").unwrap();
    assert_eq!(report.installed, vec!["model"]);
    assert!(!fx.root.app().join("1.2.3").exists());
    let ids: Vec<_> = dl.progress().items().into_iter().map(|i| i.id).collect();
    assert_eq!(ids, vec!["model"], "过滤掉的项不登记");
}

#[test]
fn 二次运行逐项标为已就绪() {
    let fx = fixture();
    sync(&fx.root, &fx.manifest, PLATFORM, &downloader()).unwrap();
    let dl = downloader();
    sync(&fx.root, &fx.manifest, PLATFORM, &dl).unwrap();
    for row in dl.progress().items() {
        assert_eq!(row.phase, Phase::Ready, "{}", row.id);
        assert!(!row.needed);
    }
}

#[test]
fn 安装途中写入的设置不会被覆盖() {
    use mingzhi_launcher::settings::{Mirror, Settings};
    let fx = fixture();
    // 用一个慢项拖住安装，期间由「进度页」写设置
    let slow = sample_bytes(400_000, 30);
    fx.server.route(
        "/slow.bin",
        vec![
            Behavior::CutAfter(slow.clone(), 1),
            Behavior::Serve(slow.clone()),
        ],
    );
    let mut manifest = fx.manifest.clone();
    manifest.items.push(item(
        "slow",
        &slow,
        "data/slow.bin",
        vec![fx.server.url("/slow.bin")],
    ));
    let state_path = fx.root.state_file();
    let s = Settings::new(Mirror::Global, "").unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let dl = Downloader::new(ProxyConfig::none(), Progress::new())
                .with_retry_delay(Duration::from_millis(300));
            sync(&fx.root, &manifest, PLATFORM, &dl).unwrap();
        });
        std::thread::sleep(Duration::from_millis(150));
        State::update(&state_path, |st| st.with_settings(&s)).unwrap();
    });
    let state = State::load(&state_path).unwrap();
    assert_eq!(state.settings(), s);
    assert!(state.installed.contains_key("slow@data/slow.bin"));
}

// ---- 终审修复：记录按 id + dest，新旧启动器交替运行不重下 ----

/// 只含 app 项的清单；`seed` 不同则包内容、sha 不同
fn app_manifest(server: &TestServer, version: &str, seed: u8) -> Manifest {
    let mut b = tar::Builder::new(Vec::new());
    let body = format!("v{version}-{seed}");
    let mut h = tar::Header::new_gnu();
    h.set_size(body.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    b.append_data(&mut h, "pkg/src/index.js", body.as_bytes())
        .unwrap();
    let tar = b.into_inner().unwrap();
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(&tar).unwrap();
    let gz = e.finish().unwrap();
    let path = format!("/app-{version}.tar.gz");
    server.route(&path, vec![Behavior::Serve(gz.clone())]);
    Manifest {
        version: version.to_string(),
        items: vec![archive_item(
            "app-darwin-arm64",
            &gz,
            "{app}",
            UnpackKind::TarGz,
            1,
            vec![server.url(&path)],
        )],
    }
}

#[test]
fn 新旧版本的清单交替同步不重复下载() {
    let server = TestServer::start();
    let old = app_manifest(&server, "0.1.0", 1);
    let new = app_manifest(&server, "0.2.0", 2);
    let tmp = tempfile::tempdir().unwrap();
    let root = AppRoot::new(tmp.path().join("Mingzhi"));

    assert_eq!(
        sync(&root, &old, PLATFORM, &downloader())
            .unwrap()
            .installed,
        vec!["app-darwin-arm64"]
    );
    assert_eq!(
        sync(&root, &new, PLATFORM, &downloader())
            .unwrap()
            .installed,
        vec!["app-darwin-arm64"]
    );
    let after_both = server.total_requests();
    assert_eq!(after_both, 2);

    // 再换回来：两边都已装好，只应跳过，不再有任何请求
    for manifest in [&old, &new, &old, &new] {
        let report = sync(&root, manifest, PLATFORM, &downloader()).unwrap();
        assert!(report.installed.is_empty(), "{report:?}");
        assert_eq!(report.skipped, vec!["app-darwin-arm64"]);
    }
    assert_eq!(server.total_requests(), after_both);
    assert_eq!(
        fs::read_to_string(root.app().join("0.1.0/src/index.js")).unwrap(),
        "v0.1.0-1"
    );
    assert_eq!(
        fs::read_to_string(root.app().join("0.2.0/src/index.js")).unwrap(),
        "v0.2.0-2"
    );
    let state = State::load(&root.state_file()).unwrap();
    assert!(state.installed.contains_key("app-darwin-arm64@app/0.1.0"));
    assert!(state.installed.contains_key("app-darwin-arm64@app/0.2.0"));
}

#[test]
fn 旧版按id存的记录能沿用并迁移() {
    let server = TestServer::start();
    let manifest = app_manifest(&server, "0.1.0", 1);
    let tmp = tempfile::tempdir().unwrap();
    let root = AppRoot::new(tmp.path().join("Mingzhi"));
    sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    let requests = server.total_requests();

    // 改写成旧格式：只按 id 存
    let mut legacy = State::load(&root.state_file()).unwrap();
    let rec = legacy.installed["app-darwin-arm64@app/0.1.0"].clone();
    legacy.installed.clear();
    legacy.installed.insert("app-darwin-arm64".to_string(), rec);
    legacy.save(&root.state_file()).unwrap();

    let report = sync(&root, &manifest, PLATFORM, &downloader()).unwrap();
    assert!(report.installed.is_empty(), "旧记录应沿用：{report:?}");
    assert_eq!(server.total_requests(), requests);

    // 下次写入该项记录时，同 sha 的旧键被迁移掉
    let item = &manifest.items[0];
    let key = item.record_key("0.1.0").unwrap();
    let migrated = legacy.with_installed(&key, State::record_for(item, &root.app().join("0.1.0")));
    assert!(!migrated.installed.contains_key("app-darwin-arm64"));
    assert!(migrated.installed.contains_key(&key));
}
