//! 用系统默认浏览器打开地址。设了 MINGZHI_NO_BROWSER=1 时不打开（测试与联调用）。

use std::process::Command;

pub fn open(url: &str) {
    if std::env::var_os("MINGZHI_NO_BROWSER").is_some_and(|v| v == "1") {
        return;
    }
    let result = command(url).spawn();
    if let Err(e) = result {
        eprintln!("打开浏览器失败：{e}，请手动访问 {url}");
    }
}

#[cfg(target_os = "macos")]
fn command(url: &str) -> Command {
    let mut c = Command::new("/usr/bin/open");
    c.arg(url);
    c
}

#[cfg(windows)]
fn command(url: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // rundll32 不弹控制台窗口，也不经过 cmd 解析特殊字符
    let mut c = Command::new("rundll32");
    c.args(["url.dll,FileProtocolHandler", url])
        .creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(not(any(target_os = "macos", windows)))]
fn command(url: &str) -> Command {
    let mut c = Command::new("xdg-open");
    c.arg(url);
    c
}
