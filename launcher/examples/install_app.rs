//! CI 烟测：用启动器真实的安装流程（下载 → 核对大小与 sha256 → 解压预算 → 严格文件名规则解包 → 写 state）
//! 装一遍本平台的 app 包与 Chrome Headless Shell，确认 `node --import tsx src/server/index.ts` 的入口在。
//!
//! 用法：`cargo run --release --example install_app -- <manifest.json> <app 包所在目录> <AppRoot>`
//!
//! 清单里本平台的 app 项原样使用（sha256 / size / unpack / dest），只把下载地址换成本机临时 HTTP 服务，
//! 服务从 <app 包所在目录> 按文件名提供压缩包；chrome 项照清单从镜像下载。其它项不装。
//! 最后一行输出 `MINGZHI_CHROME=<Chrome 可执行文件绝对路径>`（与启动器起服务时设的值相同），供渲染烟测使用。

use mingzhi_launcher::download::Downloader;
use mingzhi_launcher::install;
use mingzhi_launcher::manifest::{current_platform, Manifest};
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::progress::Progress;
use mingzhi_launcher::proxy::ProxyConfig;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

const ENTRY: &str = "src/server/index.ts";

/// 本机静态文件服务：只认 `/<文件名>`，整份返回（不支持 Range 时下载器会从头下）。
fn serve_dir(dir: PathBuf) -> Result<String, String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let base = format!("http://{}", server.server_addr());
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let name = req.url().trim_start_matches('/').to_string();
            let file = (!name.contains('/') && !name.contains(".."))
                .then(|| std::fs::File::open(dir.join(&name)).ok())
                .flatten();
            let _ = match file {
                Some(f) => req.respond(tiny_http::Response::from_file(f)),
                None => req.respond(tiny_http::Response::empty(404)),
            };
        }
    });
    Ok(base)
}

/// 只保留本平台的 app 项（下载地址换成本机服务）与 chrome 项。
fn smoke_manifest(path: &Path, platform: &str, base: &str) -> Result<Manifest, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let items = value["items"].as_array().cloned().unwrap_or_default();
    let mut apps: Vec<Value> = items
        .into_iter()
        .filter(|i| i["kind"] == "app" && i["platform"] == platform)
        .collect();
    let [app] = apps.as_mut_slice() else {
        return Err(format!(
            "清单里 {platform} 的 app 项应恰好 1 个，实际 {}",
            apps.len()
        ));
    };
    let url = app["urls"][0].as_str().ok_or("app 项没有 url")?;
    let file = url.rsplit('/').next().unwrap_or_default().to_string();
    app["urls"] = Value::Array(vec![Value::String(format!("{base}/{file}"))]);
    let chrome = value["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["kind"] == "chrome" && i["platform"] == platform)
        .cloned();
    value["items"] = Value::Array(apps.into_iter().chain(chrome).collect());
    Manifest::parse(&value.to_string()).map_err(|e| e.to_string())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [manifest_path, pkg_dir, root] = args.as_slice() else {
        return Err("用法：install_app <manifest.json> <app 包所在目录> <AppRoot>".into());
    };
    let platform = current_platform();
    let base = serve_dir(PathBuf::from(pkg_dir))?;
    let manifest = smoke_manifest(Path::new(manifest_path), platform, &base)?;
    let root = AppRoot::new(root);
    let downloader = Downloader::new(ProxyConfig::none(), Progress::new());

    let t0 = Instant::now();
    let report =
        install::sync(&root, &manifest, platform, &downloader).map_err(|e| e.to_string())?;
    let app_dir = root.app().join(&manifest.version);
    if !app_dir.join(ENTRY).is_file() {
        return Err(format!("解包后缺少 {}", app_dir.join(ENTRY).display()));
    }
    let chrome = manifest
        .for_platform(platform)
        .into_iter()
        .find(|i| i.kind == "chrome")
        .ok_or(format!("清单里没有 {platform} 的 chrome 项"))?
        .resolve_exec(&root, &manifest.version)
        .map_err(|e| e.to_string())?
        .filter(|p| p.is_file())
        .ok_or("chrome 项装完后找不到可执行文件")?;
    println!(
        "启动器安装 app 包与 Chrome 成功（{:.1}s）：装了 {:?}，跳过 {:?}\n应用目录：{}",
        t0.elapsed().as_secs_f64(),
        report.installed,
        report.skipped,
        app_dir.display()
    );
    println!("MINGZHI_CHROME={}", chrome.display());
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("烟测失败：{e}");
            ExitCode::FAILURE
        }
    }
}
