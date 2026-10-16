//! 进度页出现之前的错误提示：终端 / 控制台窗口里的输出用户不一定看得到（窗口可能一闪而过），所以另外弹系统对话框。
//! - macOS：`osascript`，文字作为 argv 传入脚本（不拼进 AppleScript 源码，不经 shell）
//! - Windows：MessageBoxW
//! - 其它：只打印
//!
//! 设了 MINGZHI_NO_BROWSER=1（测试 / 联调的无界面模式）时只打印，不弹窗。

/// 打印并弹出提示（阻塞到用户点「好」）。
pub fn alert(title: &str, message: &str) {
    eprintln!("{title}：{message}");
    if std::env::var_os("MINGZHI_NO_BROWSER").is_some_and(|v| v == "1") {
        return;
    }
    show(title, message);
}

/// osascript 的参数：脚本固定，标题与正文通过 `argv` 传进去。
pub fn osascript_args(title: &str, message: &str) -> Vec<String> {
    [
        "-e",
        "on run argv",
        "-e",
        "display dialog (item 1 of argv) with title (item 2 of argv) buttons {\"好\"} default button 1 with icon caution",
        "-e",
        "end run",
        message,
        title,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[cfg(target_os = "macos")]
fn show(title: &str, message: &str) {
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(osascript_args(title, message))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(windows)]
fn show(title: &str, message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND,
    };
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let (text, caption) = (wide(message), wide(title));
    // SAFETY：两个缓冲区都以 0 结尾，在调用期间有效
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONWARNING | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn show(_title: &str, _message: &str) {}
