//! 把下载清单编译进启动器：CI 用 MINGZHI_MANIFEST_FILE 指定 build-manifest 生成的
//! dist/manifest.json（含 app 项与版本号）；未指定时用仓库里的锁定清单（开发用，无 app 项）。
//! release 构建必须指定，否则编译失败（避免产出装不上应用本体的启动器）。

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=MINGZHI_MANIFEST_FILE");
    let src = match std::env::var_os("MINGZHI_MANIFEST_FILE") {
        Some(p) => PathBuf::from(p),
        None if std::env::var("PROFILE").as_deref() == Ok("release") => panic!(
            "release 构建必须设置 MINGZHI_MANIFEST_FILE（build-manifest 生成的 dist/manifest.json 的绝对路径）"
        ),
        None => PathBuf::from("manifest.lock.json"),
    };
    println!("cargo:rerun-if-changed={}", src.display());
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("manifest.json");
    std::fs::copy(&src, &out).unwrap_or_else(|e| panic!("复制清单 {} 失败：{e}", src.display()));
}
