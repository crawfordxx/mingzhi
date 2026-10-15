//! paths / manifest / proxy / progress 的单元测试。

use mingzhi_launcher::manifest::{Manifest, UnpackKind};
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::progress::Progress;
use mingzhi_launcher::proxy::{host_of, parse_scutil, ProxyConfig};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |k| map.get(k).map(OsString::from)
}

#[test]
fn 应用根目录按平台解析() {
    let mac = AppRoot::resolve_for("macos", env(&[("HOME", "/Users/u")])).unwrap();
    assert_eq!(
        mac.root(),
        PathBuf::from("/Users/u/Library/Application Support/Mingzhi")
    );

    let win = AppRoot::resolve_for(
        "windows",
        env(&[("LOCALAPPDATA", "C:/Users/u/AppData/Local")]),
    )
    .unwrap();
    assert_eq!(
        win.root(),
        PathBuf::from("C:/Users/u/AppData/Local").join("Mingzhi")
    );

    let over = AppRoot::resolve_for(
        "macos",
        env(&[("HOME", "/h"), ("MINGZHI_APP_ROOT", "/tmp/x")]),
    )
    .unwrap();
    assert_eq!(over.root(), PathBuf::from("/tmp/x"));

    assert!(AppRoot::resolve_for("macos", env(&[])).is_err());
    assert!(AppRoot::resolve_for("windows", env(&[])).is_err());
}

#[test]
fn 子目录布局() {
    let root = AppRoot::new("/r");
    assert_eq!(root.runtime(), PathBuf::from("/r/runtime"));
    assert_eq!(root.app(), PathBuf::from("/r/app"));
    assert_eq!(root.data(), PathBuf::from("/r/data"));
    assert_eq!(root.downloads(), PathBuf::from("/r/downloads"));
    assert_eq!(root.state_file(), PathBuf::from("/r/state.json"));
}

const MANIFEST: &str = r#"{
  "version": "0.3.0",
  "generatedAt": "2026-10-15",
  "items": [
    {"id":"node","kind":"node","platform":"darwin-arm64","sha256":"aa","size":10,
     "dest":"runtime/node","unpack":"tar.gz","strip":1,"urls":["https://a/n.tgz"],"extra":"忽略"},
    {"id":"node-win","kind":"node","platform":"win32-x64","sha256":"bb","size":10,
     "dest":"runtime/node","unpack":"zip","urls":["https://a/n.zip"]},
    {"id":"model","kind":"model","platform":"any","sha256":"cc","size":5,
     "dest":"data/models/m.bin","urls":["https://a/m","https://b/m"]},
    {"id":"app","kind":"app","platform":"darwin-arm64","sha256":"dd","size":7,
     "dest":"{app}","unpack":"tar.zst","urls":["https://a/app"]}
  ]
}"#;

#[test]
fn 清单解析并按平台过滤() {
    let m = Manifest::parse(MANIFEST).unwrap();
    assert_eq!(m.version, "0.3.0");
    let ids: Vec<_> = m
        .for_platform("darwin-arm64")
        .iter()
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(ids, vec!["node", "model", "app"]);
    let win: Vec<_> = m
        .for_platform("win32-x64")
        .iter()
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(win, vec!["node-win", "model"]);
    assert_eq!(m.items[0].unpack, Some(UnpackKind::TarGz));
    assert_eq!(m.items[0].strip, 1);
    assert_eq!(m.items[2].unpack, None);
    assert_eq!(m.items[2].urls.len(), 2);
}

#[test]
fn app占位符展开且拒绝越界dest() {
    let m = Manifest::parse(MANIFEST).unwrap();
    let root = AppRoot::new("/r");
    assert_eq!(
        m.items[3].resolve_dest(&root, "0.3.0").unwrap(),
        PathBuf::from("/r/app/0.3.0")
    );
    assert_eq!(
        m.items[0].resolve_dest(&root, "0.3.0").unwrap(),
        PathBuf::from("/r/runtime/node")
    );

    let mut bad = m.items[0].clone();
    for dest in ["../x", "/abs/x", "a/../../x", ""] {
        bad.dest = dest.to_string();
        assert!(
            bad.resolve_dest(&root, "0.3.0").is_err(),
            "{dest:?} 应被拒绝"
        );
    }
}

#[test]
fn 清单边界校验() {
    assert!(Manifest::parse("not json").is_err());
    assert!(Manifest::parse(r#"{"version":"../x","items":[]}"#).is_err());
    let no_url = r#"{"version":"1","items":[{"id":"a","platform":"any","sha256":"x","size":1,"dest":"d","urls":[]}]}"#;
    assert!(Manifest::parse(no_url).is_err());
    let bad_unpack = r#"{"version":"1","items":[{"id":"a","platform":"any","sha256":"x","size":1,"dest":"d","unpack":"rar","urls":["u"]}]}"#;
    assert!(Manifest::parse(bad_unpack).is_err());
}

#[test]
fn part文件名带哈希前缀且安全() {
    let m = Manifest::parse(MANIFEST).unwrap();
    let mut it = m.items[0].clone();
    it.id = "a/b c".to_string();
    it.sha256 = "0123456789abcdef".to_string();
    assert_eq!(it.part_name(), "a_b_c-01234567.part");
}

fn get(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |k| map.get(k).cloned()
}

#[test]
fn 环境变量代理() {
    let cfg = ProxyConfig::from_sources(
        get(&[("HTTPS_PROXY", "http://p1:8080"), ("HTTP_PROXY", "p2:3128")]),
        || panic!("环境变量齐全时不应再问系统"),
    );
    assert_eq!(
        cfg.proxy_for("https://example.com/a"),
        Some("http://p1:8080")
    );
    assert_eq!(
        cfg.proxy_for("http://example.com/a"),
        Some("http://p2:3128")
    );

    // 只设了 HTTP_PROXY 时 https 目标沿用它
    let cfg = ProxyConfig::from_sources(get(&[("http_proxy", "http://p:1")]), || None);
    assert_eq!(cfg.proxy_for("https://example.com"), Some("http://p:1"));

    // 不支持的 socks 代理被忽略，而不是让下载整体失败
    let cfg = ProxyConfig::from_sources(get(&[("HTTPS_PROXY", "socks5://p:1")]), || None);
    assert_eq!(cfg.proxy_for("https://example.com"), None);
}

#[test]
fn 回环与no_proxy直连() {
    let cfg = ProxyConfig::from_sources(
        get(&[
            ("HTTPS_PROXY", "http://p:1"),
            ("HTTP_PROXY", "http://p:1"),
            ("NO_PROXY", "internal.corp, .lan"),
        ]),
        || None,
    );
    for url in [
        "http://127.0.0.1:9000/x",
        "http://localhost/x",
        "https://a.internal.corp/x",
        "https://h.lan/x",
        "https://internal.corp/x",
    ] {
        assert_eq!(cfg.proxy_for(url), None, "{url} 应直连");
    }
    assert_eq!(cfg.proxy_for("https://example.com"), Some("http://p:1"));
}

const SCUTIL: &str = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n  HTTPEnable : 1\n  HTTPPort : 7897\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7898\n  HTTPSProxy : 10.0.0.2\n}\n";

#[test]
fn 解析scutil系统代理() {
    let (http, https) = parse_scutil(SCUTIL);
    assert_eq!(http.as_deref(), Some("http://127.0.0.1:7897"));
    assert_eq!(https.as_deref(), Some("http://10.0.0.2:7898"));

    let disabled = SCUTIL.replace("HTTPEnable : 1", "HTTPEnable : 0");
    assert_eq!(parse_scutil(&disabled).0, None);
    assert_eq!(parse_scutil("<dictionary> {\n}\n"), (None, None));
}

#[test]
fn 环境变量缺失时用系统代理兜底() {
    let cfg = ProxyConfig::from_sources(get(&[]), || Some(SCUTIL.to_string()));
    assert_eq!(
        cfg.proxy_for("https://example.com"),
        Some("http://10.0.0.2:7898")
    );
    assert_eq!(
        cfg.proxy_for("http://example.com"),
        Some("http://127.0.0.1:7897")
    );
}

#[test]
fn 主机名提取() {
    assert_eq!(
        host_of("https://User:pw@Example.COM:8443/a?b#c").as_deref(),
        Some("example.com")
    );
    assert_eq!(host_of("http://[::1]:80/x").as_deref(), Some("::1"));
    assert_eq!(host_of("not a url"), None);
}

#[test]
fn 进度计数与回退() {
    let p = Progress::new();
    p.set_total(100);
    p.add(60);
    p.sub(10);
    p.sub(1000); // 不会下溢
    p.add(5);
    p.set_active("b", "下载 b");
    p.set_active("a", "校验 a");
    p.clear_active("b");
    let s = p.snapshot();
    assert_eq!((s.downloaded, s.total), (5, 100));
    assert_eq!(s.active, vec!["校验 a"]);
}
