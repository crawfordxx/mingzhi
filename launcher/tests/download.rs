//! 下载核心：Range 续传、Range 不支持、坏哈希重下、镜像回退。

mod common;

use common::{item, sample_bytes, Behavior, TestServer};
use mingzhi_launcher::download::Downloader;
use mingzhi_launcher::progress::Progress;
use mingzhi_launcher::proxy::ProxyConfig;
use std::fs;
use std::time::Duration;

fn downloader() -> Downloader {
    Downloader::new(ProxyConfig::none(), Progress::new()).with_retry_delay(Duration::ZERO)
}

#[test]
fn 中途断开后从断点续传() {
    let data = sample_bytes(300_000, 1);
    let server = TestServer::start();
    // 第一次发出 100_000 字节后断线，第二次正常
    server.route(
        "/a.bin",
        vec![
            Behavior::CutAfter(data.clone(), 100_000),
            Behavior::Serve(data.clone()),
        ],
    );
    let it = item("a", &data, "data/a.bin", vec![server.url("/a.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("a.part");

    let dl = downloader();
    dl.download(&it, &part).expect("应能续传成功");

    assert_eq!(fs::read(&part).unwrap(), data);
    let reqs = server.requests("/a.bin");
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].range, None);
    let resumed_from: u64 = reqs[1]
        .range
        .as_deref()
        .unwrap()
        .trim_start_matches("bytes=")
        .trim_end_matches('-')
        .parse()
        .unwrap();
    assert!(
        resumed_from > 0 && resumed_from <= 100_000,
        "应从已收到的断点续传，实际 {resumed_from}"
    );
    // 进度没有重复计数
    assert_eq!(dl.progress().snapshot().downloaded, data.len() as u64);
}

#[test]
fn 已有part文件时第一次请求就带range() {
    let data = sample_bytes(50_000, 2);
    let server = TestServer::start();
    server.route("/b.bin", vec![Behavior::Serve(data.clone())]);
    let it = item("b", &data, "data/b.bin", vec![server.url("/b.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("b.part");
    fs::write(&part, &data[..20_000]).unwrap(); // 上次运行遗留

    let dl = downloader();
    dl.download(&it, &part).unwrap();

    assert_eq!(fs::read(&part).unwrap(), data);
    assert_eq!(
        server.requests("/b.bin")[0].range.as_deref(),
        Some("bytes=20000-")
    );
    assert_eq!(dl.progress().snapshot().downloaded, data.len() as u64);
}

#[test]
fn 服务器不支持range时从头下载() {
    let data = sample_bytes(80_000, 3);
    let server = TestServer::start();
    server.route("/c.bin", vec![Behavior::ServeIgnoreRange(data.clone())]);
    let it = item("c", &data, "data/c.bin", vec![server.url("/c.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("c.part");
    fs::write(&part, &data[..30_000]).unwrap();

    let dl = downloader();
    dl.download(&it, &part).unwrap();

    assert_eq!(
        fs::read(&part).unwrap(),
        data,
        "不能把整份内容接在旧数据后面"
    );
    assert_eq!(dl.progress().snapshot().downloaded, data.len() as u64);
}

#[test]
fn 坏哈希删除后同镜像重下成功() {
    let data = sample_bytes(40_000, 4);
    let mut bad = data.clone();
    bad[100] ^= 0xff;
    let server = TestServer::start();
    server.route(
        "/d.bin",
        vec![Behavior::Serve(bad), Behavior::Serve(data.clone())],
    );
    let it = item("d", &data, "data/d.bin", vec![server.url("/d.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("d.part");

    downloader().download(&it, &part).unwrap();

    assert_eq!(fs::read(&part).unwrap(), data);
    let reqs = server.requests("/d.bin");
    assert_eq!(reqs.len(), 2);
    assert_eq!(
        reqs[1].range, None,
        "坏文件应整个删除后从头重下，而不是续传"
    );
}

#[test]
fn 坏哈希三次后换下一个镜像() {
    let data = sample_bytes(40_000, 5);
    let mut bad = data.clone();
    bad[7] ^= 0x01;
    let server = TestServer::start();
    server.route("/m1.bin", vec![Behavior::Serve(bad)]);
    server.route("/m2.bin", vec![Behavior::Serve(data.clone())]);
    let it = item(
        "e",
        &data,
        "data/e.bin",
        vec![server.url("/m1.bin"), server.url("/m2.bin")],
    );
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("e.part");

    downloader().download(&it, &part).unwrap();

    assert_eq!(fs::read(&part).unwrap(), data);
    assert_eq!(
        server.requests("/m1.bin").len(),
        3,
        "第一个镜像最多尝试 3 次"
    );
    assert_eq!(server.requests("/m2.bin").len(), 1);
}

#[test]
fn 首个镜像404立即回退第二个() {
    let data = sample_bytes(10_000, 6);
    let server = TestServer::start();
    server.route("/gone.bin", vec![Behavior::NotFound]);
    server.route("/ok.bin", vec![Behavior::Serve(data.clone())]);
    let it = item(
        "f",
        &data,
        "data/f.bin",
        vec![server.url("/gone.bin"), server.url("/ok.bin")],
    );
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("f.part");

    downloader().download(&it, &part).unwrap();

    assert_eq!(fs::read(&part).unwrap(), data);
    assert_eq!(
        server.requests("/gone.bin").len(),
        1,
        "404 不应重试同一镜像"
    );
}

#[test]
fn 所有镜像都失败时报错() {
    let data = sample_bytes(1_000, 7);
    let server = TestServer::start();
    let it = item(
        "g",
        &data,
        "data/g.bin",
        vec![server.url("/x.bin"), server.url("/y.bin")],
    );
    let tmp = tempfile::tempdir().unwrap();

    let err = downloader()
        .download(&it, &tmp.path().join("g.part"))
        .unwrap_err();
    assert!(err.to_string().contains("下载失败"), "{err}");
}

// ---- 以下为审查后补的用例 ----

#[test]
fn 响应超出清单大小立即中止并换镜像() {
    let data = sample_bytes(20_000, 11);
    let mut chunked = data.clone();
    chunked.extend(sample_bytes(2_000_000, 12)); // 不声明长度，多出 2MB
    let server = TestServer::start();
    server.route("/big.bin", vec![Behavior::ServeChunked(chunked)]);
    server.route(
        "/declared.bin",
        vec![Behavior::ServeIgnoreRange(sample_bytes(500_000, 13))],
    );
    server.route("/ok.bin", vec![Behavior::Serve(data.clone())]);
    let it = item(
        "h",
        &data,
        "data/h.bin",
        vec![
            server.url("/big.bin"),
            server.url("/declared.bin"),
            server.url("/ok.bin"),
        ],
    );
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("h.part");

    let dl = downloader();
    dl.download(&it, &part).unwrap();

    assert_eq!(fs::read(&part).unwrap(), data);
    assert_eq!(
        server.requests("/big.bin").len(),
        1,
        "超限属于镜像问题，不应重试"
    );
    assert_eq!(server.requests("/declared.bin").len(), 1);
    assert_eq!(
        dl.progress().snapshot().downloaded,
        data.len() as u64,
        "被丢弃的字节要从进度里扣掉"
    );
}

#[test]
fn 超限且无其它镜像时不留part文件() {
    let data = sample_bytes(20_000, 14);
    let mut chunked = data.clone();
    chunked.extend(vec![7u8; 100_000]);
    let server = TestServer::start();
    server.route("/big.bin", vec![Behavior::ServeChunked(chunked)]);
    let it = item("i", &data, "data/i.bin", vec![server.url("/big.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("i.part");

    assert!(downloader().download(&it, &part).is_err());
    assert!(!part.exists());
}

#[test]
fn 五百错误重试同一镜像() {
    let data = sample_bytes(10_000, 15);
    let server = TestServer::start();
    server.route(
        "/s.bin",
        vec![Behavior::Status(503), Behavior::Serve(data.clone())],
    );
    let it = item("j", &data, "data/j.bin", vec![server.url("/s.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("j.part");

    downloader().download(&it, &part).unwrap();
    assert_eq!(server.requests("/s.bin").len(), 2);
}

#[test]
fn 续传时收到416则丢弃重来() {
    let data = sample_bytes(30_000, 16);
    let server = TestServer::start();
    server.route(
        "/r.bin",
        vec![Behavior::Status(416), Behavior::Serve(data.clone())],
    );
    let it = item("k", &data, "data/k.bin", vec![server.url("/r.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("k.part");
    fs::write(&part, &data[..10_000]).unwrap();

    let dl = downloader();
    dl.download(&it, &part).unwrap();

    assert_eq!(fs::read(&part).unwrap(), data);
    let reqs = server.requests("/r.bin");
    assert_eq!(reqs[0].range.as_deref(), Some("bytes=10000-"));
    assert_eq!(reqs[1].range, None);
    assert_eq!(dl.progress().snapshot().downloaded, data.len() as u64);
}

#[test]
fn 续传位置与服务器不一致时丢弃重来() {
    let data = sample_bytes(30_000, 17);
    let server = TestServer::start();
    server.route(
        "/c.bin",
        vec![
            Behavior::BadContentRange(data.clone()),
            Behavior::Serve(data.clone()),
        ],
    );
    let it = item("l", &data, "data/l.bin", vec![server.url("/c.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("l.part");
    fs::write(&part, &data[..10_000]).unwrap();

    downloader().download(&it, &part).unwrap();
    assert_eq!(
        fs::read(&part).unwrap(),
        data,
        "不能把错位的内容接在旧数据后面"
    );
}

#[test]
fn 经http代理下载() {
    let data = sample_bytes(10_000, 18);
    let proxy = TestServer::start();
    // 代理收到的是绝对形式的请求目标
    proxy.route(
        "http://files.example.invalid/x.bin",
        vec![Behavior::Serve(data.clone())],
    );
    let cfg =
        ProxyConfig::from_sources(|k| (k == "HTTP_PROXY").then(|| proxy.base.clone()), || None);
    let it = item(
        "m",
        &data,
        "data/m.bin",
        vec!["http://files.example.invalid/x.bin".to_string()],
    );
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("m.part");

    Downloader::new(cfg, Progress::new())
        .with_retry_delay(Duration::ZERO)
        .download(&it, &part)
        .unwrap();

    assert_eq!(fs::read(&part).unwrap(), data);
    assert_eq!(
        proxy.requests("http://files.example.invalid/x.bin").len(),
        1
    );
}

#[test]
fn 错误信息不含url里的凭据() {
    let data = sample_bytes(100, 19);
    let server = TestServer::start();
    let url = server
        .url("/nope.bin")
        .replace("http://", "http://user:s3cret@");
    let it = item("n", &data, "data/n.bin", vec![url]);
    let tmp = tempfile::tempdir().unwrap();

    let err = downloader()
        .download(&it, &tmp.path().join("n.part"))
        .unwrap_err()
        .to_string();
    assert!(!err.contains("s3cret"), "{err}");
}

#[test]
fn 不支持的socks代理有明确提示() {
    let data = sample_bytes(100, 20);
    let server = TestServer::start();
    let cfg = ProxyConfig::from_sources(
        |k| (k == "HTTPS_PROXY").then(|| "socks5://user:s3cret@127.0.0.1:1080".to_string()),
        || None,
    );
    assert_eq!(cfg.warnings().len(), 1);
    assert!(cfg.warnings()[0].contains("不支持") && !cfg.warnings()[0].contains("s3cret"));

    let it = item("o", &data, "data/o.bin", vec![server.url("/none.bin")]);
    let tmp = tempfile::tempdir().unwrap();
    let err = Downloader::new(cfg, Progress::new())
        .with_retry_delay(Duration::ZERO)
        .download(&it, &tmp.path().join("o.part"))
        .unwrap_err();
    assert!(err.to_string().contains("不支持"), "{err}");
}

#[test]
fn 无数据超时后换下一个地址并续传() {
    let data = sample_bytes(300_000, 21);
    let slow = TestServer::start();
    let fast = TestServer::start();
    slow.route("/f", vec![Behavior::Stall(data.clone(), 100_000, 3_000)]);
    fast.route("/f", vec![Behavior::Serve(data.clone())]);
    let it = item(
        "stall",
        &data,
        "data/f",
        vec![slow.url("/f"), fast.url("/f")],
    );
    let dir = tempfile::tempdir().unwrap();
    let part = dir.path().join("f.part");

    let dl = downloader().with_stall_timeout(Duration::from_millis(500));
    let started = std::time::Instant::now();
    dl.download(&it, &part).unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(2_500),
        "应在卡住后很快换地址"
    );
    assert_eq!(std::fs::read(&part).unwrap(), data);
    assert_eq!(slow.requests("/f").len(), 1, "卡住的地址不再重试");
    let resumed = fast.requests("/f");
    assert_eq!(resumed.len(), 1);
    // 卡住前收到的部分（受服务端缓冲影响，不一定正好 100000）在新地址续传
    let offset: usize = resumed[0]
        .range
        .as_deref()
        .and_then(|r| r.strip_prefix("bytes="))
        .and_then(|r| r.strip_suffix('-'))
        .and_then(|n| n.parse().ok())
        .expect("应带 Range 续传");
    assert!(offset > 0 && offset <= 100_000, "{offset}");
}

#[test]
fn 代理前缀与镜像顺序按设置生效() {
    use mingzhi_launcher::settings::{Mirror, Settings};
    use std::sync::{Arc, RwLock};

    let data = sample_bytes(5_000, 22);
    let proxy = TestServer::start();
    let gh = "https://github.com/o/r/releases/download/v1/f.bin";
    proxy.route(&format!("/p/{gh}"), vec![Behavior::Serve(data.clone())]);
    let it = item("gh", &data, "data/f", vec![gh.to_string()]);
    let dir = tempfile::tempdir().unwrap();

    let settings = Arc::new(RwLock::new(Settings::default()));
    let dl = downloader().with_settings(settings.clone());
    // 设置在下载器建好之后才改，也要生效
    *settings.write().unwrap() = Settings::new(Mirror::Cn, &proxy.url("/p/")).unwrap();
    dl.download(&it, &dir.path().join("f.part")).unwrap();
    assert_eq!(proxy.requests(&format!("/p/{gh}")).len(), 1);
}

#[test]
fn 单项进度按项计数() {
    let data = sample_bytes(50_000, 23);
    let server = TestServer::start();
    server.route(
        "/f",
        vec![
            Behavior::CutAfter(data.clone(), 20_000),
            Behavior::Serve(data.clone()),
        ],
    );
    let it = item("one", &data, "data/f", vec![server.url("/f")]);
    let dir = tempfile::tempdir().unwrap();
    let dl = downloader();
    dl.progress().register(&[&it]);
    dl.download(&it, &dir.path().join("f.part")).unwrap();
    assert_eq!(dl.progress().items()[0].downloaded, data.len() as u64);
}
