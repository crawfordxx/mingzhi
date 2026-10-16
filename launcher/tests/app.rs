//! 主流程端到端（进程内）：本地 tiny_http 镜像 + 假清单 + 假 node（shell 脚本跑假服务）。
//! 下载必需项 → 起服务 → Running；可选项失败不阻塞并在后台补齐；失败重试；崩溃后重新启动。
#![cfg(unix)]

mod common;

use common::{archive_item, item, sample_bytes, Behavior, TestServer};
use mingzhi_launcher::app::{self, Command, Info, Plan, Shared, Stage};
use mingzhi_launcher::download::Downloader;
use mingzhi_launcher::manifest::{Manifest, UnpackKind};
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::progress::{Phase, Progress};
use mingzhi_launcher::proxy::ProxyConfig;
use mingzhi_launcher::settings::Settings;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, RwLock};
use std::time::{Duration, Instant};

const PLATFORM: &str = "darwin-arm64";

/// 只含 bin/node 一个可执行脚本的 tar.gz。
fn node_targz(mode: &str) -> Vec<u8> {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-server.mjs");
    let script = format!(
        "#!/bin/sh\nFAKE_MODE={mode} exec node {:?}\n",
        fixture.display().to_string()
    );
    let mut b = tar::Builder::new(Vec::new());
    let mut h = tar::Header::new_gnu();
    h.set_size(script.len() as u64);
    h.set_mode(0o755);
    h.set_cksum();
    b.append_data(&mut h, "bin/node", script.as_bytes())
        .unwrap();
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(&b.into_inner().unwrap()).unwrap();
    e.finish().unwrap()
}

struct Fx {
    server: TestServer,
    done: std::thread::JoinHandle<()>,
    shared: Arc<Shared>,
    _tmp: tempfile::TempDir,
    _app: tempfile::TempDir,
}

fn launch(mode: &str, model_ok: bool) -> Fx {
    let server = TestServer::start();
    let node = node_targz(mode);
    let model = sample_bytes(50_000, 41);
    let music = sample_bytes(20_000, 42);
    server.route("/node.tar.gz", vec![Behavior::Serve(node.clone())]);
    server.route(
        "/model.bin",
        vec![if model_ok {
            Behavior::Serve(model.clone())
        } else {
            Behavior::NotFound
        }],
    );
    server.route("/music.bin", vec![Behavior::NotFound]);

    let mut node_item = archive_item(
        "node-darwin-arm64",
        &node,
        "runtime/node",
        UnpackKind::TarGz,
        0,
        vec![server.url("/node.tar.gz")],
    );
    node_item.kind = "node".into();
    node_item.platform = PLATFORM.into();
    node_item.exec = Some("runtime/node/bin/node".into());
    let mut music_item = item(
        "music-chill",
        &music,
        "data/assets/music/chill.mp3",
        vec![server.url("/music.bin")],
    );
    music_item.kind = "asset".into();
    music_item.optional = true;
    let manifest = Manifest {
        version: "1.0.0".into(),
        items: vec![
            node_item,
            item(
                "model-rvm",
                &model,
                "data/models/rvm.onnx",
                vec![server.url("/model.bin")],
            ),
            music_item,
        ],
    };

    let tmp = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(app_dir.path().join("src/server")).unwrap();
    std::fs::write(app_dir.path().join("src/server/index.ts"), "").unwrap();

    let root = AppRoot::new(tmp.path());
    let progress = Progress::new();
    let settings = Arc::new(RwLock::new(Settings::default()));
    let downloader = Downloader::new(ProxyConfig::none(), progress.clone())
        .with_retry_delay(Duration::ZERO)
        .with_settings(settings.clone());
    let (tx, rx) = mpsc::channel();
    let shared = Shared::new(progress, settings, root.state_file(), Info::default(), tx);
    let plan = Arc::new(Plan {
        root,
        manifest,
        platform: PLATFORM.into(),
        app_dir: Some(app_dir.path().to_path_buf()),
        downloader: Arc::new(downloader),
    });
    let s = shared.clone();
    let done = std::thread::spawn(move || app::run(s, plan, rx));
    Fx {
        done,
        server,
        shared,
        _tmp: tmp,
        _app: app_dir,
    }
}

fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !cond() {
        assert!(Instant::now() < deadline, "等待超时：{what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn phase(shared: &Shared, id: &str) -> Phase {
    shared
        .progress
        .items()
        .into_iter()
        .find(|i| i.id == id)
        .map(|i| i.phase)
        .unwrap()
}

#[test]
fn 装好必需项后起服务_可选项后台补齐() {
    let fx = launch("ok", true);
    wait_until("服务就绪", || fx.shared.stage() == Stage::Running);
    let url = fx.shared.url().unwrap();
    assert_eq!(
        ureq::get(&format!("{url}/api/status"))
            .call()
            .unwrap()
            .status(),
        200
    );

    // 可选项失败：记为稍后补齐，页面上带友好文案
    wait_until("可选项记为稍后补齐", || {
        phase(&fx.shared, "music-chill") == Phase::Deferred
    });
    let view = fx.shared.view();
    let music = view["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == "music-chill")
        .unwrap()
        .clone();
    assert_eq!(music["name"], "配乐 · 轻松");
    assert_eq!(music["group"], "asset");
    assert_eq!(music["problem"]["kind"], "unavailable");
    assert_eq!(view["stage"], "running");

    // 地址恢复后「催一下」即补齐，无需重启服务
    fx.server.route(
        "/music.bin",
        vec![Behavior::Serve(sample_bytes(20_000, 42))],
    );
    fx.shared.send(Command::SettingsChanged);
    wait_until("可选项补齐", || {
        phase(&fx.shared, "music-chill") == Phase::Done
    });
    assert_eq!(fx.shared.url().unwrap(), url, "服务未被重启");
}

#[test]
fn 必需项失败后重试成功() {
    let fx = launch("ok", false);
    wait_until("进入失败", || fx.shared.stage() == Stage::Failed);
    let view = fx.shared.view();
    assert_eq!(view["error"]["kind"], "unavailable");
    assert!(view["error"]["detail"]
        .as_str()
        .unwrap()
        .contains("model-rvm"));
    assert_eq!(
        phase(&fx.shared, "node-darwin-arm64"),
        Phase::Done,
        "其它项照常装完"
    );

    fx.server.route(
        "/model.bin",
        vec![Behavior::Serve(sample_bytes(50_000, 41))],
    );
    fx.shared.send(Command::Retry);
    wait_until("重试后就绪", || fx.shared.stage() == Stage::Running);
    assert!(fx.shared.view()["error"].is_null());
}

#[test]
fn 服务崩溃后显示原因并可重新启动() {
    let fx = launch("crash-later", true);
    wait_until("进入已退出", || fx.shared.stage() == Stage::Crashed);
    let view = fx.shared.view();
    let title = view["error"]["title"].as_str().unwrap();
    assert!(title.contains("工作台意外退出了"), "{title}");
    assert!(view["error"]["detail"].as_str().unwrap().contains("boom"));

    fx.shared.send(Command::Restart);
    wait_until("重新启动", || fx.shared.stage() == Stage::Running);
}

#[test]
fn 服务正常退出时启动器随之结束且不显示崩溃() {
    let fx = launch("quit-later", true);
    wait_until("主流程结束", || fx.done.is_finished());
    assert_eq!(fx.shared.stage(), Stage::Running, "不应进入「意外退出」");
    assert!(fx.shared.view()["error"].is_null());
}

#[test]
fn 连点两次重新启动只重启一次() {
    let fx = launch("crash-later", true);
    wait_until("进入已退出", || fx.shared.stage() == Stage::Crashed);
    let epoch = fx.shared.view()["epoch"].as_u64().unwrap();
    fx.shared.send(Command::Restart);
    fx.shared.send(Command::Restart);
    wait_until("重新启动", || fx.shared.stage() == Stage::Running);
    let running_epoch = fx.shared.view()["epoch"].as_u64().unwrap();
    assert!(running_epoch > epoch);
    // 陈旧的第二个「重新启动」若没被丢弃，服务会立刻被停掉重启，阶段计数会再涨；
    // 假服务 400ms 后才会再崩，这 150ms 内阶段应纹丝不动
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(fx.shared.view()["epoch"].as_u64().unwrap(), running_epoch);
}

#[test]
fn 收到退出命令时停掉服务并结束主流程() {
    let fx = launch("ok", true);
    wait_until("服务就绪", || fx.shared.stage() == Stage::Running);
    assert!(fx.shared.accepts(Command::Quit));
    fx.shared.send(Command::Quit);
    wait_until("主流程结束", || fx.done.is_finished());
    assert_eq!(fx.shared.stage(), Stage::Running, "不应进入「意外退出」");
}

#[test]
fn 服务已崩溃等待重启时收到退出命令也结束() {
    let fx = launch("crash-later", true);
    wait_until("进入已退出", || fx.shared.stage() == Stage::Crashed);
    fx.shared.send(Command::Quit);
    wait_until("主流程结束", || fx.done.is_finished());
}

#[test]
fn 必需项失败等待重试时收到退出命令也结束() {
    let fx = launch("ok", false);
    wait_until("进入出错", || fx.shared.stage() == Stage::Failed);
    fx.shared.send(Command::Quit);
    wait_until("主流程结束", || fx.done.is_finished());
}
