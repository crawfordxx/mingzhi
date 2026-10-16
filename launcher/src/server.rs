//! 进度页的本机 HTTP 服务：只监听 127.0.0.1，页面与资源都编译进二进制。
//!
//! - GET  /                     进度页（ui.html）
//! - GET  /api/state            状态 JSON（页面每秒轮询）
//! - GET  /api/ping             单实例确认
//! - POST /api/retry|restart    重试下载 / 重新启动工作台
//! - POST /api/settings         保存镜像与 GitHub 代理前缀
//! - GET  /assets/*             油画、字体
//!
//! 安全：Host 必须是本机地址（防 DNS 重绑定）；POST 必须带 `X-Mingzhi: 1`
//! （跨站页面带不了自定义头而不触发预检，我们不应答预检），且 Origin 若有必须是本页。

use crate::app::{Command, Shared};
use crate::error::{Error, Result};
use crate::instance::PING_REPLY;
use crate::settings::Mirror;
use serde::Deserialize;
use std::io::Read;
use std::sync::Arc;
use tiny_http::{Header, Method, Request, Response, Server};

const PAGE: &str = include_str!("ui.html");
const ASSETS: [(&str, &str, &[u8]); 5] = [
    (
        "art.webp",
        "image/webp",
        include_bytes!("../assets/art.webp"),
    ),
    (
        "plex-serif-200i.woff2",
        "font/woff2",
        include_bytes!("../assets/plex-serif-200i.woff2"),
    ),
    (
        "plex-serif-300i.woff2",
        "font/woff2",
        include_bytes!("../assets/plex-serif-300i.woff2"),
    ),
    (
        "plex-mono-400.woff2",
        "font/woff2",
        include_bytes!("../assets/plex-mono-400.woff2"),
    ),
    (
        "plex-mono-500.woff2",
        "font/woff2",
        include_bytes!("../assets/plex-mono-500.woff2"),
    ),
];
/// 端口被占用时最多往后试这么多个，再不行交给系统分配
const PORT_TRIES: u16 = 20;
const MAX_BODY: u64 = 4 * 1024;

pub struct UiServer {
    port: u16,
}

impl UiServer {
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// 从 `base_port` 起找空闲端口并在后台线程里服务；`base_port` 为 0 时由系统分配。
pub fn start(shared: Arc<Shared>, base_port: u16) -> Result<UiServer> {
    let server = bind(base_port)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| Error::new("进度页服务地址异常"))?;
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            handle(&shared, port, req);
        }
    });
    Ok(UiServer { port })
}

fn bind(base: u16) -> Result<Server> {
    let candidates = (0..PORT_TRIES)
        .filter_map(|i| base.checked_add(i))
        .filter(|_| base != 0)
        .chain(std::iter::once(0));
    let mut last = String::new();
    for port in candidates {
        match Server::http(("127.0.0.1", port)) {
            Ok(s) => return Ok(s),
            Err(e) => last = e.to_string(),
        }
    }
    Err(Error::new(format!("进度页找不到可用端口：{last}")))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("固定的响应头")
}

fn req_header<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

fn host_ok(req: &Request, port: u16) -> bool {
    req_header(req, "Host")
        .is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
}

/// POST 防跨站：必须带自定义头；Origin 若有必须是本页。
fn command_ok(req: &Request, port: u16) -> bool {
    let custom = req_header(req, "X-Mingzhi") == Some("1");
    let origin_ok = req_header(req, "Origin").is_none_or(|o| {
        o == format!("http://127.0.0.1:{port}") || o == format!("http://localhost:{port}")
    });
    custom && origin_ok
}

type Resp = Response<std::io::Cursor<Vec<u8>>>;

fn bytes(status: u16, content_type: &str, body: Vec<u8>, cache: &str) -> Resp {
    Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", cache))
        .with_header(header("X-Content-Type-Options", "nosniff"))
}

fn json(status: u16, value: &serde_json::Value) -> Resp {
    bytes(
        status,
        "application/json; charset=utf-8",
        value.to_string().into_bytes(),
        "no-store",
    )
}

fn text(status: u16, body: &str) -> Resp {
    bytes(
        status,
        "text/plain; charset=utf-8",
        body.as_bytes().to_vec(),
        "no-store",
    )
}

fn handle(shared: &Shared, port: u16, mut req: Request) {
    let resp = if !host_ok(&req, port) {
        text(403, "forbidden")
    } else {
        route(shared, port, &mut req)
    };
    let _ = req.respond(resp);
}

fn route(shared: &Shared, port: u16, req: &mut Request) -> Resp {
    let path = req.url().split('?').next().unwrap_or("").to_string();
    match (req.method(), path.as_str()) {
        (Method::Get, "/") => bytes(
            200,
            "text/html; charset=utf-8",
            PAGE.as_bytes().to_vec(),
            "no-store",
        )
        .with_header(header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )),
        (Method::Get, "/api/state") => json(200, &shared.view()),
        (Method::Get, "/api/ping") => text(200, PING_REPLY),
        (Method::Get, p) if p.starts_with("/assets/") => asset(&p["/assets/".len()..]),
        (Method::Post, _) if !command_ok(req, port) => text(403, "forbidden"),
        (Method::Post, "/api/retry") => command(shared, Command::Retry),
        (Method::Post, "/api/restart") => command(shared, Command::Restart),
        (Method::Post, "/api/settings") => save_settings(shared, req),
        _ => text(404, "not found"),
    }
}

fn asset(name: &str) -> Resp {
    match ASSETS.iter().find(|(n, _, _)| *n == name) {
        Some((_, ct, data)) => bytes(200, ct, data.to_vec(), "public, max-age=86400"),
        None => text(404, "not found"),
    }
}

fn command(shared: &Shared, cmd: Command) -> Resp {
    shared.send(cmd);
    json(200, &serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsBody {
    mirror: Mirror,
    #[serde(default)]
    github_prefix: String,
}

fn save_settings(shared: &Shared, req: &mut Request) -> Resp {
    let mut body = String::new();
    if req
        .as_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .is_err()
    {
        return json(400, &serde_json::json!({ "error": "请求内容读取失败" }));
    }
    let parsed: SettingsBody = match serde_json::from_str(&body) {
        Ok(b) => b,
        Err(_) => return json(400, &serde_json::json!({ "error": "设置格式不对" })),
    };
    match shared.save_settings(parsed.mirror, &parsed.github_prefix) {
        Ok(s) => json(200, &serde_json::json!({ "ok": true, "settings": s })),
        Err(e) => json(400, &serde_json::json!({ "error": e.to_string() })),
    }
}
