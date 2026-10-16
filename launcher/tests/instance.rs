//! 单实例锁、进度页名称/许可、启动行解析。

use mingzhi_launcher::catalog::{group_of, licenses, name_of, Group};
use mingzhi_launcher::instance::{acquire, Acquire, PING_REPLY};
use mingzhi_launcher::manifest::Manifest;
use mingzhi_launcher::run::parse_ready;
use std::time::{Duration, Instant};

/// 起一个只回应 /api/ping 的小服务，模拟已在运行的启动器。
fn ping_server() -> (tiny_http::Server, String) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", server.server_addr().to_ip().unwrap());
    (server, url)
}

#[test]
fn 第二个实例拿到已有地址() {
    let dir = tempfile::tempdir().unwrap();
    let Acquire::Primary(guard) = acquire(dir.path(), Duration::ZERO).unwrap() else {
        panic!("第一个应为主实例");
    };
    let (server, url) = ping_server();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let _ = req.respond(tiny_http::Response::from_string(PING_REPLY));
        }
    });
    guard.publish(&url).unwrap();

    match acquire(dir.path(), Duration::from_secs(2)).unwrap() {
        Acquire::Secondary(Some(got)) => assert_eq!(got, url),
        _ => panic!("应为第二实例并拿到地址"),
    }

    drop(guard);
    assert!(matches!(
        acquire(dir.path(), Duration::ZERO).unwrap(),
        Acquire::Primary(_)
    ));
}

#[test]
fn 地址无人应答时等到超时返回空() {
    let dir = tempfile::tempdir().unwrap();
    let Acquire::Primary(guard) = acquire(dir.path(), Duration::ZERO).unwrap() else {
        panic!();
    };
    // 公布了一个没人监听的地址（例如上次残留）
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    guard.publish(&url).unwrap();
    let started = Instant::now();
    assert!(matches!(
        acquire(dir.path(), Duration::from_millis(400)).unwrap(),
        Acquire::Secondary(None)
    ));
    assert!(started.elapsed() >= Duration::from_millis(400));
}

#[test]
fn 主实例启动时清掉旧地址() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("launcher.json"),
        r#"{"url":"http://127.0.0.1:1"}"#,
    )
    .unwrap();
    let _guard = acquire(dir.path(), Duration::ZERO).unwrap();
    assert!(!dir.path().join("launcher.json").exists());
}

#[test]
fn 名称分组与许可() {
    assert_eq!(name_of("node-darwin-arm64"), "Node.js 运行环境");
    assert_eq!(name_of("ffprobe-win32-x64"), "FFprobe 媒体分析");
    assert_eq!(name_of("ffmpeg-darwin-x64"), "FFmpeg 视频引擎");
    assert_eq!(name_of("chrome-darwin-arm64"), "Chrome 渲染内核");
    assert_eq!(name_of("app-darwin-arm64"), "明知AI剪辑 应用");
    assert_eq!(name_of("model-sensevoice-int8"), "语音识别模型");
    assert_eq!(name_of("font-lxgw-wenkai"), "字体 · 霞鹜文楷");
    assert_eq!(name_of("music-new"), "配乐");
    assert_eq!(name_of("mystery"), "mystery");
    assert_eq!(group_of("model", false), Group::Model);
    assert_eq!(group_of("asset", true), Group::Asset);
    assert_eq!(group_of("node", false), Group::Runtime);

    // 真实锁定清单：每个平台都有 ffmpeg 的 GPL 说明，配乐合并为一行
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("manifest.lock.json");
    let mut v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v["version"] = "0.1.0".into();
    let m = Manifest::parse(&v.to_string()).unwrap();
    for platform in ["darwin-arm64", "darwin-x64", "win32-x64"] {
        let list = licenses(&m.for_platform(platform));
        let ff = list
            .iter()
            .find(|l| l.name.starts_with("FFmpeg 视频引擎"))
            .unwrap();
        assert!(ff.name.contains("FFprobe"), "同许可应合并：{}", ff.name);
        assert!(ff.license.contains("GPL"), "{platform}");
        // 配乐如有，合并成一行（配乐项可能从清单移走，不要求一定有）
        assert!(list.iter().filter(|l| l.name.starts_with("配乐")).count() <= 1);
        assert_eq!(list[0].license, "MIT");
        // 与 README「许可证」一节一致：这些都要在「关于」里出现
        for needle in [
            "Remotion",
            "Kenney",
            "FunASR Model Open Source License",
            "GPL-3.0（RobustVideoMatting",
            "BSD-3-Clause（Chromium",
            "MIT（Node.js）",
            "SIL OFL 1.1",
            "CC0 1.0",
            "THIRD_PARTY_NOTICES.md",
        ] {
            let all: Vec<String> = list
                .iter()
                .map(|l| format!("{} {}", l.name, l.license))
                .collect();
            assert!(
                all.iter().any(|t| t.contains(needle)),
                "{platform} 的关于页缺 {needle}：{all:?}"
            );
        }
        for item in m.for_platform(platform) {
            assert_ne!(name_of(&item.id), item.id, "{} 缺中文名", item.id);
        }
    }
}

#[test]
fn 启动行解析() {
    assert_eq!(
        parse_ready("明知AI剪辑 已启动：http://127.0.0.1:4323"),
        Some("http://127.0.0.1:4323".into())
    );
    assert_eq!(
        parse_ready("明知AI剪辑 已启动：http://127.0.0.1:4321/  "),
        Some("http://127.0.0.1:4321".into())
    );
    assert_eq!(parse_ready("明知AI剪辑 已启动：http://evil.cn:80"), None);
    assert_eq!(parse_ready("明知AI剪辑 已启动：http://127.0.0.1:abc"), None);
    assert_eq!(parse_ready("别的日志"), None);
}

#[test]
fn 弹窗文字作为参数传入而不拼进脚本() {
    use mingzhi_launcher::notify::osascript_args;
    let msg = "路径 \"C:\\x\" 里有引号'和 end run";
    let args = osascript_args("标题\"", msg);
    assert_eq!(args[args.len() - 2], msg);
    assert_eq!(args[args.len() - 1], "标题\"");
    // 脚本部分是固定的，不含用户文字
    assert!(args[..args.len() - 2].iter().all(|a| !a.contains("引号")));
}
