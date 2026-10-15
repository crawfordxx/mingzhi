//! 测试公共件：本地 tiny_http 模拟镜像服务器 + 构造清单项的小工具。
#![allow(dead_code)]

use mingzhi_launcher::hash::sha256_bytes;
use mingzhi_launcher::manifest::{Item, UnpackKind};
use std::collections::HashMap;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Response, Server, StatusCode};

/// 某个路径对一次请求的应答方式。
#[derive(Clone)]
pub enum Behavior {
    /// 正常返回，支持 `Range: bytes=N-`
    Serve(Vec<u8>),
    /// 无视 Range，永远整份返回 200
    ServeIgnoreRange(Vec<u8>),
    /// 声明完整长度，却只发出前 N 字节就断开连接
    CutAfter(Vec<u8>, usize),
    NotFound,
}

/// 一条请求记录。
#[derive(Debug, Clone)]
pub struct Req {
    pub path: String,
    pub range: Option<String>,
}

pub struct TestServer {
    pub base: String,
    server: Arc<Server>,
    routes: Arc<Mutex<HashMap<String, Vec<Behavior>>>>,
    log: Arc<Mutex<Vec<Req>>>,
}

/// 读到第 `cut` 字节后报错，使 tiny_http 中途断开连接。
struct CutReader {
    data: Vec<u8>,
    pos: usize,
    cut: usize,
}

impl Read for CutReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.cut {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "模拟断线"));
        }
        let end = (self.pos + buf.len()).min(self.cut).min(self.data.len());
        let n = end - self.pos;
        buf[..n].copy_from_slice(&self.data[self.pos..end]);
        self.pos = end;
        Ok(n)
    }
}

impl TestServer {
    pub fn start() -> Self {
        let server = Arc::new(Server::http("127.0.0.1:0").expect("启动测试服务器失败"));
        let base = format!("http://{}", server.server_addr().to_ip().expect("监听地址"));
        let routes: Arc<Mutex<HashMap<String, Vec<Behavior>>>> = Arc::default();
        let log: Arc<Mutex<Vec<Req>>> = Arc::default();

        let (srv, rts, lg) = (server.clone(), routes.clone(), log.clone());
        std::thread::spawn(move || {
            for request in srv.incoming_requests() {
                let path = request.url().to_string();
                let range = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .map(|h| h.value.as_str().to_string());
                lg.lock().unwrap().push(Req {
                    path: path.clone(),
                    range: range.clone(),
                });

                // 按序消费行为，最后一个重复生效
                let behavior = {
                    let mut map = rts.lock().unwrap();
                    match map.get_mut(&path) {
                        Some(list) if list.len() > 1 => list.remove(0),
                        Some(list) if list.len() == 1 => list[0].clone(),
                        _ => Behavior::NotFound,
                    }
                };
                respond(request, behavior, range);
            }
        });
        Self {
            base,
            server,
            routes,
            log,
        }
    }

    /// 为路径设置依次生效的应答行为。
    pub fn route(&self, path: &str, behaviors: Vec<Behavior>) {
        self.routes
            .lock()
            .unwrap()
            .insert(path.to_string(), behaviors);
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub fn requests(&self, path: &str) -> Vec<Req> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.path == path)
            .cloned()
            .collect()
    }

    pub fn total_requests(&self) -> usize {
        self.log.lock().unwrap().len()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn respond(request: tiny_http::Request, behavior: Behavior, range: Option<String>) {
    if *request.method() != Method::Get {
        let _ = request.respond(Response::empty(405));
        return;
    }
    match behavior {
        Behavior::NotFound => {
            let _ = request.respond(Response::empty(404));
        }
        Behavior::ServeIgnoreRange(data) => {
            let _ = request.respond(Response::from_data(data));
        }
        Behavior::Serve(data) => {
            let start = range
                .as_deref()
                .and_then(|r| r.strip_prefix("bytes="))
                .and_then(|r| r.strip_suffix('-'))
                .and_then(|n| n.parse::<usize>().ok());
            match start {
                Some(start) if start < data.len() => {
                    let body = data[start..].to_vec();
                    let content_range =
                        format!("bytes {}-{}/{}", start, data.len() - 1, data.len());
                    let len = body.len();
                    let resp = Response::new(
                        StatusCode(206),
                        vec![header("Content-Range", &content_range)],
                        io::Cursor::new(body),
                        Some(len),
                        None,
                    );
                    let _ = request.respond(resp);
                }
                Some(_) => {
                    let _ = request.respond(Response::empty(416));
                }
                None => {
                    let _ = request.respond(Response::from_data(data));
                }
            }
        }
        Behavior::CutAfter(data, cut) => {
            let len = data.len();
            let reader = CutReader { data, pos: 0, cut };
            let _ = request.respond(Response::new(
                StatusCode(200),
                vec![],
                reader,
                Some(len),
                None,
            ));
        }
    }
}

/// 生成可复现的伪随机内容（不可压缩，便于测续传）。
pub fn sample_bytes(len: usize, seed: u8) -> Vec<u8> {
    let mut x = seed as u32 + 12345;
    (0..len)
        .map(|_| {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            (x >> 24) as u8
        })
        .collect()
}

pub fn item(id: &str, data: &[u8], dest: &str, urls: Vec<String>) -> Item {
    Item {
        id: id.to_string(),
        kind: "model".to_string(),
        platform: "any".to_string(),
        sha256: sha256_bytes(data),
        size: data.len() as u64,
        dest: dest.to_string(),
        unpack: None,
        strip: 0,
        urls,
    }
}

pub fn archive_item(
    id: &str,
    data: &[u8],
    dest: &str,
    kind: UnpackKind,
    strip: usize,
    urls: Vec<String>,
) -> Item {
    Item {
        unpack: Some(kind),
        strip,
        kind: "app".to_string(),
        ..item(id, data, dest, urls)
    }
}
