//! 用系统默认浏览器打开地址。设了 MINGZHI_NO_BROWSER=1 时不打开（测试与联调用）。

use std::process::Command;

/// 打开失败时返回错误（由调用方弹窗提示用户手动访问）。
pub fn open(url: &str) -> std::io::Result<()> {
    if std::env::var_os("MINGZHI_NO_BROWSER").is_some_and(|v| v == "1") {
        return Ok(());
    }
    command(url).spawn().map(|_| ())
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
    // rundll32 不弹控制台窗口，也不经过 cmd 解析特殊字符；写绝对路径，
    // 免得启动器所在目录（比如「下载」）里的同名 exe 被先找到
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let exe = std::path::PathBuf::from(root)
        .join("System32")
        .join("rundll32.exe");
    let mut c = Command::new(exe);
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
