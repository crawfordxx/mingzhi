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

/// 起启动器，等到「工作台已就绪」，返回（进程，服务进程 pid）。
fn spawn_launcher(root: &std::path::Path, server: &TestServer) -> (Child, i32) {
    let node = node_targz();
    server.route("/node.tar.gz", vec![Behavior::Serve(node.clone())]);
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

    let mut child = Command::new(env!("CARGO_BIN_EXE_mingzhi-launcher"))
        .env("MINGZHI_APP_ROOT", root.join("root"))
        .env("MINGZHI_MANIFEST", &manifest_path)
        .env("MINGZHI_APP_DIR", &app)
        .env("MINGZHI_NO_BROWSER", "1")
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("http_proxy")
        .env_remove("https_proxy")
        .env_remove("ALL_PROXY")
        .env_remove("all_proxy")
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
    // 后台继续读 stderr，避免管道写满
    std::thread::spawn(move || for _ in lines {});
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

fn check(sig: i32) {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let server = TestServer::start();
    let (mut child, service_pid) = spawn_launcher(tmp.path(), &server);
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
    check(libc::SIGINT);
}

#[test]
fn sighup_关闭终端窗口时优雅退出并带走服务() {
    check(libc::SIGHUP);
}

#[test]
fn sigterm_优雅退出并带走服务() {
    check(libc::SIGTERM);
}
