//! 把下载清单编译进启动器：CI 用 MINGZHI_MANIFEST_FILE 指定 build-manifest 生成的
//! dist/manifest.json（含 app 项与版本号）；未指定时用仓库里的锁定清单（开发用，无 app 项）。
//! release 构建必须指定，否则编译失败（避免产出装不上应用本体的启动器）。
//! 目标是 Windows 时，另把 windows/mingzhi.rc（图标与版本信息）嵌进 exe。

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

    // 看的是编译目标而不是宿主机（Linux/macOS 上交叉编译 Windows 同样要嵌）
    println!("cargo:rerun-if-changed=windows");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("windows/mingzhi.rc", embed_resource::NONE)
            .manifest_required()
            .unwrap_or_else(|e| panic!("嵌入 Windows 资源失败：{e}"));
    }
}
