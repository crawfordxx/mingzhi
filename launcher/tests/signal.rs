//! 终端信号 → 优雅退出：真实起一个启动器进程（假 node 跑假服务），发 SIGINT / SIGHUP / SIGTERM，
//! 确认启动器在宽限期内退出，且服务进程随之退出（不残留）。
#![cfg(unix)]

mod common;

use common::{archive_item, Behavior, TestServer};
use mingzhi_launcher::manifest::UnpackKind;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 三个用例都会占用启动器的固定端口段，串行跑
static SERIAL: Mutex<()> = Mutex::new(());

fn node_targz() -> Vec<u8> {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-server.mjs");
    let script = format!("#!/bin/sh\nexec node {:?}\n", fixture.display().to_string());
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

fn pid_alive(pid: i32) -> bool {
    // SAFETY：kill(pid, 0) 只探测进程是否存在
    unsafe { libc::kill(pid, 0) == 0 }
}

/// 写好假清单（一个假 node，下载后用假服务脚本充当）与假应用目录，返回（清单路径，应用目录，清单）。
/// `node_route_ok` 为 false 时 node 的下载地址返回 404，必需项安装会失败。
fn write_fixture(
    root: &std::path::Path,
    server: &TestServer,
    node_route_ok: bool,
) -> (PathBuf, PathBuf) {
    let node = node_targz();
    let behavior = if node_route_ok {
        Behavior::Serve(node.clone())
    } else {
        Behavior::NotFound
    };
    server.route("/node.tar.gz", vec![behavior]);
    let mut it = archive_item(
        "node-fake",
        &node,
        "runtime/node",
        UnpackKind::TarGz,
        0,
        vec![server.url("/node.tar.gz")],
    );
    it.kind = "node".into();
    it.platform = "any".into();
    it.exec = Some("runtime/node/bin/node".into());
    let manifest = serde_json::json!({
        "version": "1.0.0",
        "items": [{
            "id": it.id, "kind": "node", "platform": "any", "sha256": it.sha256, "size": it.size,
            "dest": "runtime/node", "unpack": "tar.gz", "exec": "runtime/node/bin/node",
            "urls": it.urls,
        }]
    });
    let manifest_path = root.join("manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    let app = root.join("appdir");
    std::fs::create_dir_all(app.join("src/server")).unwrap();
    std::fs::write(app.join("src/server/index.ts"), "").unwrap();
    (manifest_path, app)
}

/// 带好环境变量的启动器命令（不弹浏览器、不走代理）。
fn launcher_command(root: &std::path::Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_mingzhi-launcher"));
    cmd.env("MINGZHI_APP_ROOT", root.join("root"))
        .env("MINGZHI_MANIFEST", root.join("manifest.json"))
        .env("MINGZHI_APP_DIR", root.join("appdir"))
        .env("MINGZHI_NO_BROWSER", "1")
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("http_proxy")
        .env_remove("https_proxy")
        .env_remove("ALL_PROXY")
        .env_remove("all_proxy");
    cmd
}

/// 起启动器，等到「工作台已就绪」，返回（进程，服务进程 pid）。
/// `keep_reading` 为 false 时丢掉 stderr 的读端，模拟终端窗口已经断开（之后任何写 stderr 都会失败）。
fn spawn_launcher(root: &std::path::Path, server: &TestServer, keep_reading: bool) -> (Child, i32) {
    spawn_launcher_seeded(root, server, keep_reading, |_| {})
}

/// 同上，启动前先让 `seed` 往应用根目录（`<root>/root`）里放东西。
fn spawn_launcher_seeded(
    root: &std::path::Path,
    server: &TestServer,
    keep_reading: bool,
    seed: impl FnOnce(&std::path::Path),
) -> (Child, i32) {
    write_fixture(root, server, true);
    seed(&root.join("root"));
    let mut child = launcher_command(root)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut ready = false;
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline {
        let Some(Ok(line)) = lines.next() else { break };
        if line.contains("工作台已就绪") {
            ready = true;
            break;
        }
    }
    assert!(ready, "启动器没有进入就绪状态");
    if keep_reading {
        // 后台继续读 stderr，避免管道写满
        std::thread::spawn(move || for _ in lines {});
    } else {
        drop(lines);
    }
    let out = Command::new("pgrep")
        .args(["-P", &child.id().to_string()])
        .output()
        .unwrap();
    let pid = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .and_then(|p| p.trim().parse().ok())
        .expect("没找到服务子进程");
    (child, pid)
}

fn exits_within(child: &mut Child, d: Duration) -> bool {
    let deadline = Instant::now() + d;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn check(sig: i32, keep_reading: bool) {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let server = TestServer::start();
    let (mut child, service_pid) = spawn_launcher(tmp.path(), &server, keep_reading);
    // SAFETY：向刚起的子进程发信号
    unsafe { libc::kill(child.id() as i32, sig) };
    let status_ok = exits_within(&mut child, Duration::from_secs(12));
    if !status_ok {
        let _ = child.kill();
    }
    assert!(status_ok, "启动器没有在信号后退出");
    let deadline = Instant::now() + Duration::from_secs(8);
    while pid_alive(service_pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!pid_alive(service_pid), "服务进程没有随启动器退出");
}

#[test]
fn sigint_优雅退出并带走服务() {
    check(libc::SIGINT, true);
}

#[test]
fn sighup_关闭终端窗口时优雅退出并带走服务() {
    check(libc::SIGHUP, true);
}

#[test]
fn sigterm_优雅退出并带走服务() {
    check(libc::SIGTERM, true);
}

/// 关闭终端窗口：tty 先断开，之后写 stderr 会失败（这里用关闭管道读端模拟）。
/// 信号路径上的日志写失败不能 panic，否则 Quit 发不出去，启动器与服务成为孤儿进程。
#[test]
fn sighup_终端已断开_stderr不可写时仍然退出并带走服务() {
    check(libc::SIGHUP, false);
}

#[test]
fn sigint_终端已断开_stderr不可写时仍然退出并带走服务() {
    check(libc::SIGINT, false);
}

/// 第二次双击：把页面交给已在运行的启动器，自己以专用退出码 10 退出，
/// 并在终端里说「已在运行……这个窗口可以关闭」（.command 据此不再打印「已退出」）；第一个启动器照常运行。
#[test]
fn 第二次启动交接后以退出码10退出且原实例不受影响() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let server = TestServer::start();
    let (mut first, _service_pid) = spawn_launcher(tmp.path(), &server, true);

    let second = launcher_command(tmp.path()).output().unwrap();
    let err = String::from_utf8_lossy(&second.stderr);
    assert_eq!(second.status.code(), Some(10), "{err}");
    assert!(
        err.contains("明知AI剪辑已在运行，已为你打开浏览器；这个窗口可以关闭"),
        "{err}"
    );
    assert!(!err.contains("已退出"), "{err}");
    assert!(first.try_wait().unwrap().is_none(), "原实例应继续运行");

    // SAFETY：向刚起的子进程发信号
    unsafe { libc::kill(first.id() as i32, libc::SIGINT) };
    if !exits_within(&mut first, Duration::from_secs(12)) {
        let _ = first.kill();
    }
}

// ---- 接线：dataver / prune 在 main 与 flow 里的调用 ----

fn marker(root: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(root.join("root/data/data-version")).ok()
}

fn stop(mut child: Child) {
    // SAFETY：向刚起的子进程发信号
    unsafe { libc::kill(child.id() as i32, libc::SIGINT) };
    if !exits_within(&mut child, Duration::from_secs(12)) {
        let _ = child.kill();
    }
}

fn seed_dirs(app_root: &std::path::Path, marker: &str) {
    for dir in ["app/0.9.0", "app/0.8.0", "app/my-notes"] {
        std::fs::create_dir_all(app_root.join(dir)).unwrap();
        std::fs::write(app_root.join(dir).join("f"), "x").unwrap();
    }
    std::fs::create_dir_all(app_root.join("data")).unwrap();
    std::fs::write(app_root.join("data/data-version"), marker).unwrap();
}

/// 服务启动成功后：数据版本记成自己的版本，旧 app 目录在后台被清掉，其它目录不动。
#[test]
fn 启动成功后登记数据版本并后台清理旧版本() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let server = TestServer::start();
    let (child, _service_pid) =
        spawn_launcher_seeded(tmp.path(), &server, true, |r| seed_dirs(r, "0.5.0"));

    let root = tmp.path().join("root");
    let deadline = Instant::now() + Duration::from_secs(10);
    while (root.join("app/0.9.0").exists() || marker(tmp.path()).as_deref() != Some("1.0.0"))
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(marker(tmp.path()).as_deref(), Some("1.0.0"));
    assert!(!root.join("app/0.9.0").exists() && !root.join("app/0.8.0").exists());
    assert!(
        root.join("app/my-notes/f").exists(),
        "名字不是版本号的目录不能动"
    );
    stop(child);
}

/// 数据已被更新版本用过：只读检查就拒绝，不装任何东西、不改标记、不清理。
#[test]
fn 数据版本比启动器新时拒绝启动且不动任何数据() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let server = TestServer::start();
    write_fixture(tmp.path(), &server, true);
    seed_dirs(&tmp.path().join("root"), "9.0.0");

    let out = launcher_command(tmp.path()).output().unwrap();

    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "{err}");
    assert!(err.contains("请使用最新版启动器"), "{err}");
    assert_eq!(marker(tmp.path()).as_deref(), Some("9.0.0"));
    assert!(tmp.path().join("root/app/0.9.0/f").exists(), "不清理");
    assert!(!tmp.path().join("root/runtime/node").exists(), "不安装");
    assert_eq!(server.total_requests(), 0, "不下载");
}

/// 升级中途失败（必需项下载不到）：标记保持不变，不清理旧版本，留着的旧启动器照常能用。
#[test]
fn 安装失败时数据版本标记不变也不清理旧版本() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let server = TestServer::start();
    write_fixture(tmp.path(), &server, false);
    seed_dirs(&tmp.path().join("root"), "0.5.0");

    let mut child = launcher_command(tmp.path())
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut page = None;
    let deadline = Instant::now() + Duration::from_secs(20);
    while page.is_none() && Instant::now() < deadline {
        let Some(Ok(line)) = lines.next() else { break };
        page = line
            .split_once("进度页：")
            .map(|(_, u)| u.trim().to_string());
    }
    let page = page.expect("没拿到进度页地址");
    std::thread::spawn(move || for _ in lines {});

    let mut failed = false;
    while !failed && Instant::now() < deadline {
        let body = ureq::get(&format!("{page}/api/state"))
            .call()
            .unwrap()
            .into_string()
            .unwrap();
        let state: serde_json::Value = serde_json::from_str(&body).unwrap();
        failed = state["stage"] == "failed";
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(failed, "应停在「出错」阶段");
    std::thread::sleep(Duration::from_millis(300)); // 给（本不该发生的）后台清理一点时间

    assert_eq!(marker(tmp.path()).as_deref(), Some("0.5.0"));
    assert!(tmp.path().join("root/app/0.9.0/f").exists());
    stop(child);
}
