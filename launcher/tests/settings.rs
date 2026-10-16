//! 下载设置（镜像顺序、GitHub 代理前缀）与 state.json 读改写、清单 optional/license 字段。

use mingzhi_launcher::manifest::Manifest;
use mingzhi_launcher::settings::{is_github, Mirror, Settings};
use mingzhi_launcher::state::State;

fn urls(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn 默认国内镜像优先且不改地址() {
    let s = Settings::default();
    assert_eq!(s.mirror, Mirror::Cn);
    let list = urls(&["https://npmmirror.com/a", "https://nodejs.org/a"]);
    assert_eq!(s.urls_for(&list), list);
}

#[test]
fn 官方源优先时倒序() {
    let s = Settings::new(Mirror::Global, "").unwrap();
    assert_eq!(
        s.urls_for(&urls(&["https://npmmirror.com/a", "https://nodejs.org/a"])),
        urls(&["https://nodejs.org/a", "https://npmmirror.com/a"])
    );
}

#[test]
fn github地址套代理前缀且保留直链兜底() {
    let s = Settings::new(Mirror::Cn, "https://gh.example.com").unwrap();
    assert_eq!(s.github_prefix, "https://gh.example.com/");
    let got = s.urls_for(&urls(&[
        "https://cdn.jsdelivr.net/gh/x",
        "https://raw.githubusercontent.com/x",
        "https://github.com/a/b/releases/download/v1/f.zip",
        "https://objects.githubusercontent.com/o",
    ]));
    assert_eq!(
        got,
        urls(&[
            "https://cdn.jsdelivr.net/gh/x",
            "https://gh.example.com/https://raw.githubusercontent.com/x",
            "https://raw.githubusercontent.com/x",
            "https://gh.example.com/https://github.com/a/b/releases/download/v1/f.zip",
            "https://github.com/a/b/releases/download/v1/f.zip",
            "https://gh.example.com/https://objects.githubusercontent.com/o",
            "https://objects.githubusercontent.com/o",
        ])
    );
}

#[test]
fn 只认三个github域名() {
    assert!(is_github("https://github.com/a"));
    assert!(is_github("https://GitHub.com:443/a"));
    assert!(is_github("https://raw.githubusercontent.com/a"));
    assert!(is_github("https://objects.githubusercontent.com/a"));
    assert!(!is_github("https://github.com.evil.cn/a"));
    assert!(!is_github("https://evil.cn/https://github.com/a"));
    assert!(!is_github("https://gist.github.com/a"));
}

#[test]
fn 代理前缀校验() {
    assert!(Settings::new(Mirror::Cn, "  ")
        .unwrap()
        .github_prefix
        .is_empty());
    assert_eq!(
        Settings::new(Mirror::Cn, " https://p.cn/x/ ")
            .unwrap()
            .github_prefix,
        "https://p.cn/x/"
    );
    // 允许 ?u= 这类查询式代理
    assert!(Settings::new(Mirror::Cn, "https://p.cn/get?u=").is_ok());
    for bad in [
        "ftp://p.cn/",
        "p.cn",
        "https://",
        "https://a b.cn/",
        "javascript:alert(1)",
        "https://p.cn/\nx",
        // 只收 https
        "http://p.cn/",
        // 本机与内网地址
        "https://localhost/",
        "https://LOCALHOST:8080/",
        "https://a.localhost/",
        "https://127.0.0.1/",
        "https://127.8.9.1:443/",
        "https://10.1.2.3/",
        "https://192.168.1.1/",
        "https://172.16.0.1/",
        "https://172.31.255.255/",
        "https://169.254.1.1/",
        "https://0.0.0.0/",
        "https://[::1]/",
        "https://[fd00::1]/",
        "https://[fe80::1]/",
        // 带 # 的会把原地址截掉
        "https://p.cn/#",
        "https://p.cn/x#y/",
    ] {
        assert!(Settings::new(Mirror::Cn, bad).is_err(), "{bad:?} 应被拒绝");
    }
    let long = format!("https://p.cn/{}", "a".repeat(600));
    assert!(Settings::new(Mirror::Cn, &long).is_err());
}

#[test]
fn 设置存进state且不影响已装记录() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(
        &path,
        r#"{"installed":{"node":{"sha256":"ab","size":1,"mtime_ms":null}},"other":1}"#,
    )
    .unwrap();

    let s = Settings::new(Mirror::Global, "https://gh.example.com/").unwrap();
    State::update(&path, |st| st.with_settings(&s)).unwrap();

    let st = State::load(&path).unwrap();
    assert_eq!(st.settings(), s);
    assert!(st.installed.contains_key("node"));
    assert_eq!(st.extra.get("other"), Some(&serde_json::json!(1)));
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"githubPrefix\""), "{raw}");
}

#[test]
fn state里设置损坏时退回默认() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(&path, r#"{"settings":{"mirror":"火星","githubPrefix":3}}"#).unwrap();
    assert_eq!(State::load(&path).unwrap().settings(), Settings::default());
}

#[test]
fn 清单的optional与license字段() {
    let m = Manifest::parse(
        r#"{"version":"1.0.0","items":[
          {"id":"a","platform":"any","sha256":"00","size":1,"dest":"data/a","urls":["http://x/a"],
           "optional":true,"license":"CC0 1.0"},
          {"id":"b","platform":"any","sha256":"00","size":1,"dest":"data/b","urls":["http://x/b"]}
        ]}"#,
    )
    .unwrap();
    assert!(m.items[0].optional);
    assert_eq!(m.items[0].license.as_deref(), Some("CC0 1.0"));
    assert!(!m.items[1].optional);
    assert_eq!(m.items[1].license, None);
}

#[test]
fn 公网地址与172其它网段可用() {
    for ok in [
        "https://172.15.0.1/",
        "https://172.32.0.1/",
        "https://8.8.8.8/",
        "https://gh.example.com:8443/p/",
    ] {
        assert!(Settings::new(Mirror::Cn, ok).is_ok(), "{ok}");
    }
}

#[test]
fn state里手改的非法前缀读回时退回默认() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(
        &path,
        r#"{"settings":{"mirror":"global","githubPrefix":"http://127.0.0.1:9/"}}"#,
    )
    .unwrap();
    let st = State::load(&path).unwrap();
    assert_eq!(st.settings().github_prefix, "");
    assert_eq!(st.settings().mirror, Mirror::Global, "镜像设置保留");
}
