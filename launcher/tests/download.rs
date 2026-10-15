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
