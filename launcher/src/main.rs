//! 启动器入口。完整的进度页与启动流程在 Task 3，这里只提供无界面的「按清单安装」，
//! 用于联调核心库：`mingzhi-launcher <manifest.json>`。

use mingzhi_launcher::download::Downloader;
use mingzhi_launcher::install::sync;
use mingzhi_launcher::manifest::{current_platform, Manifest};
use mingzhi_launcher::paths::AppRoot;
use mingzhi_launcher::progress::Progress;
use mingzhi_launcher::proxy::ProxyConfig;
use std::path::PathBuf;
use std::process::ExitCode;

fn run() -> mingzhi_launcher::error::Result<()> {
    let manifest_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| {
            mingzhi_launcher::error::Error::new("用法：mingzhi-launcher <manifest.json>")
        })?;
    let manifest = Manifest::load(&manifest_path)?;
    let root = AppRoot::resolve()?;
    let downloader = Downloader::new(ProxyConfig::from_env(), Progress::new());
    let report = sync(&root, &manifest, current_platform(), &downloader)?;
    println!(
        "新装 {} 项，跳过 {} 项",
        report.installed.len(),
        report.skipped.len()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("安装失败：{e}");
            ExitCode::FAILURE
        }
    }
}
