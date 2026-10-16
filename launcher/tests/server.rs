//! 进度页 HTTP 服务：页面与资源、状态 JSON、命令、设置保存、防跨站与 DNS 重绑定、端口顺延。

use mingzhi_launcher::app::{Command, Info, Shared, Stage};
use mingzhi_launcher::progress::Progress;
use mingzhi_launcher::server;
use mingzhi_launcher::settings::Settings;
use mingzhi_launcher::state::State;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, RwLock};
use std::time::Duration;

struct Fx {
    shared: Arc<Shared>,
    url: String,
    port: u16,
    rx: Receiver<Command>,
    dir: tempfile::TempDir,
}

fn start() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel();
    let shared = Shared::new(
        Progress::new(),
        Arc::new(RwLock::new(Settings::default())),
        dir.path().join("state.json"),
        Info {
            version: "1.2.3".into(),
            ..Default::default()
        },
        tx,
    );
    // 用随机高位端口起步，避免与其它测试抢
    let ui = server::start(shared.clone(), 0).unwrap();
    Fx {
        shared,
        url: ui.url(),
        port: ui.port(),
        rx,
        dir,
    }
}

#[allow(clippy::result_large_err)]
fn post(url: &str, body: &str) -> Result<ureq::Response, ureq::Error> {
    ureq::post(url)
        .set("X-Mingzhi", "1")
        .set("Content-Type", "application/json")
        .send_string(body)
}

#[test]
fn 页面与资源() {
    let fx = start();
    let page = ureq::get(&fx.url).call().unwrap();
    assert_eq!(page.content_type(), "text/html");
    assert!(page.into_string().unwrap().contains("明知AI剪辑"));

    let art = ureq::get(&format!("{}/assets/art.webp", fx.url))
        .call()
        .unwrap();
    assert_eq!(art.content_type(), "image/webp");
    let mut bytes = Vec::new();
    art.into_reader().read_to_end(&mut bytes).unwrap();
    assert!(
        bytes.len() > 10_000 && bytes.len() <= 150 * 1024,
        "{}",
        bytes.len()
    );

    for (name, ct) in [("ui.css", "text/css"), ("ui.js", "text/javascript")] {
        let r = ureq::get(&format!("{}/assets/{name}", fx.url))
            .call()
            .unwrap();
        assert_eq!(r.content_type(), ct);
        assert_eq!(r.header("Cache-Control"), Some("no-store"));
    }

    let font = ureq::get(&format!("{}/assets/plex-serif-200i.woff2", fx.url))
        .call()
        .unwrap();
    assert_eq!(font.content_type(), "font/woff2");

    let ping = ureq::get(&format!("{}/api/ping", fx.url)).call().unwrap();
    assert_eq!(ping.into_string().unwrap(), "mingzhi-launcher");

    match ureq::get(&format!("{}/nope", fx.url)).call() {
        Err(ureq::Error::Status(404, _)) => {}
        other => panic!("应 404：{other:?}"),
    }
}

#[test]
fn 状态json() {
    let fx = start();
    let v: serde_json::Value = ureq::get(&format!("{}/api/state", fx.url))
        .call()
        .unwrap()
        .into_string()
        .map(|t| serde_json::from_str(&t).unwrap())
        .unwrap();
    assert_eq!(v["stage"], "preparing");
    assert_eq!(v["version"], "1.2.3");
    assert_eq!(v["settings"]["mirror"], "cn");
    assert!(v["items"].as_array().unwrap().is_empty());
}

#[test]
fn 命令要带自定义头() {
    let fx = start();
    match ureq::post(&format!("{}/api/retry", fx.url)).call() {
        Err(ureq::Error::Status(403, _)) => {}
        other => panic!("无头应 403：{other:?}"),
    }
    assert!(fx.rx.try_recv().is_err());

    // 阶段不对的命令直接拒绝，不进队列
    match post(&format!("{}/api/restart", fx.url), "") {
        Err(ureq::Error::Status(409, _)) => {}
        other => panic!("准备阶段重新启动应 409：{other:?}"),
    }
    assert!(fx.rx.try_recv().is_err());
    fx.shared.set(Stage::Crashed, None, None);
    post(&format!("{}/api/retry", fx.url), "").unwrap();
    assert_eq!(
        fx.rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        Command::Retry
    );
    post(&format!("{}/api/restart", fx.url), "").unwrap();
    assert_eq!(
        fx.rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        Command::Restart
    );

    // 带了别的来源（跨站页面）也拒绝
    let r = ureq::post(&format!("{}/api/retry", fx.url))
        .set("X-Mingzhi", "1")
        .set("Origin", "https://evil.example")
        .call();
    assert!(matches!(r, Err(ureq::Error::Status(403, _))));
}

#[test]
fn 保存设置() {
    let fx = start();
    let r = post(
        &format!("{}/api/settings", fx.url),
        r#"{"mirror":"global","githubPrefix":"https://gh.example.com"}"#,
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&r.into_string().unwrap()).unwrap();
    assert_eq!(v["settings"]["githubPrefix"], "https://gh.example.com/");
    assert_eq!(
        fx.rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        Command::SettingsChanged
    );
    let st = State::load(&fx.dir.path().join("state.json")).unwrap();
    assert_eq!(st.settings().github_prefix, "https://gh.example.com/");

    match post(
        &format!("{}/api/settings", fx.url),
        r#"{"mirror":"cn","githubPrefix":"不是网址"}"#,
    ) {
        Err(ureq::Error::Status(400, resp)) => {
            let v: serde_json::Value = serde_json::from_str(&resp.into_string().unwrap()).unwrap();
            assert!(v["error"].as_str().unwrap().contains("代理前缀"));
        }
        other => panic!("应 400：{other:?}"),
    }
    match post(&format!("{}/api/settings", fx.url), "{坏的") {
        Err(ureq::Error::Status(400, _)) => {}
        other => panic!("应 400：{other:?}"),
    }
}

/// 用原始 TCP 发请求，以便伪造 Host 头。
fn raw_get(port: u16, host: &str, path: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out
}

#[test]
fn 拒绝非本机host() {
    let fx = start();
    let ok = raw_get(fx.port, &format!("127.0.0.1:{}", fx.port), "/api/ping");
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    let ok = raw_get(fx.port, &format!("localhost:{}", fx.port), "/api/ping");
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    let bad = raw_get(fx.port, &format!("evil.example:{}", fx.port), "/api/state");
    assert!(bad.starts_with("HTTP/1.1 403"), "{bad}");
}

#[test]
fn 端口被占用时顺延() {
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = busy.local_addr().unwrap().port();
    let (tx, _rx) = mpsc::channel();
    let dir = tempfile::tempdir().unwrap();
    let shared = Shared::new(
        Progress::new(),
        Arc::default(),
        dir.path().join("state.json"),
        Info::default(),
        tx,
    );
    let ui = server::start(shared, port).unwrap();
    assert!(ui.port() > port);
    assert!(ui.url().starts_with("http://127.0.0.1:"));
}

#[test]
fn 慢连接不会卡住进度页() {
    let fx = start();
    // 声明了正文长度却一直不发
    let mut slow = TcpStream::connect(("127.0.0.1", fx.port)).unwrap();
    write!(
        slow,
        "POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Mingzhi: 1\r\nContent-Length: 4000\r\n\r\n{{",
        fx.port
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let started = std::time::Instant::now();
    let ok = raw_get(fx.port, &format!("127.0.0.1:{}", fx.port), "/api/ping");
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    assert!(started.elapsed() < Duration::from_secs(2));
    drop(slow);
}

#[test]
fn 运行中不接受重新启动() {
    let fx = start();
    fx.shared
        .set(Stage::Running, None, Some("http://127.0.0.1:1".into()));
    assert!(matches!(
        post(&format!("{}/api/restart", fx.url), ""),
        Err(ureq::Error::Status(409, _))
    ));
    // 运行中「重试」用来催后台补齐可选项，接受
    post(&format!("{}/api/retry", fx.url), "").unwrap();
    assert_eq!(
        fx.rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        Command::Retry
    );
}
