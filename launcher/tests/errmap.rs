//! 错误文案映射与低配检测。

use mingzhi_launcher::errmap::{friendly, Kind};
use mingzhi_launcher::sysinfo::{low_spec_note, SystemSpec};

#[test]
fn 磁盘满() {
    for raw in [
        "写入 /x/node.part 失败：No space left on device (os error 28)",
        "node 下载失败，所有镜像均不可用（最后一次：u：无法写入 a：磁盘空间不足。 (os error 112)）",
        "There is not enough space on the disk. (os error 112)",
    ] {
        let f = friendly(raw);
        assert_eq!(f.kind, Kind::DiskFull, "{raw}");
        assert!(f.title.contains("磁盘空间不足"));
        assert!(f.hint.contains("清理"));
        assert_eq!(f.detail, raw);
    }
}

#[test]
fn 网络不通() {
    for raw in [
        "chrome 下载失败，所有镜像均不可用（最后一次：https://x：网络错误：Network Error: Network Error: Error encountered in the status line: Network is unreachable (os error 51)）",
        "网络错误：Dns Failed: resolve dns name 'npmmirror.com:443': failed to lookup address information",
        "网络错误：Connection Failed: Connect error: Connection refused (os error 61)",
        "https://x：45 秒没有收到数据，已换下一个地址",
        "网络错误：Network Error: timed out reading response",
        // 代理 / 防火墙在握手时断开：不是证书问题
        "网络错误：https://x: Connection Failed: tls connection init failed: unexpected end of file",
    ] {
        assert_eq!(friendly(raw).kind, Kind::Network, "{raw}");
    }
    assert!(friendly("Connection refused").hint.contains("代理"));
}

#[test]
fn 证书错误() {
    for raw in [
        "网络错误：Connection Failed: tls connection init failed: invalid peer certificate: UnknownIssuer",
        "invalid peer certificate: Expired",
        "certificate verify failed",
    ] {
        let f = friendly(raw);
        assert_eq!(f.kind, Kind::Certificate, "{raw}");
        assert!(f.hint.contains("时间"));
    }
}

#[test]
fn 杀毒软件占用() {
    for raw in [
        "文件被占用（可能是杀毒软件正在扫描），请稍后重试",
        "移动到 C:\\x 失败：另一个程序正在使用此文件，进程无法访问。 (os error 32)",
        "Access is denied. (os error 5)",
        "Permission denied (os error 13)",
    ] {
        let f = friendly(raw);
        assert_eq!(f.kind, Kind::Busy, "{raw}");
        assert!(f.hint.contains("杀毒"));
    }
}

#[test]
fn 端口冲突() {
    let f = friendly("启动失败：listen EADDRINUSE: address already in use 127.0.0.1:4330");
    assert_eq!(f.kind, Kind::Port);
    assert!(f.title.contains("端口"));
}

#[test]
fn 校验不符与地址失效() {
    assert_eq!(
        friendly("u：下载完成但校验不符，已删除重下").kind,
        Kind::Corrupt
    );
    assert_eq!(friendly("u：服务器返回 404").kind, Kind::Unavailable);
    assert_eq!(friendly("u：服务器返回 403").kind, Kind::Unavailable);
}

#[test]
fn 认不出的错误给通用文案并保留原文() {
    let f = friendly("某种奇怪的错误");
    assert_eq!(f.kind, Kind::Other);
    assert!(!f.title.is_empty() && !f.hint.is_empty());
    assert_eq!(f.detail, "某种奇怪的错误");
}

#[test]
fn 磁盘满优先于网络字样() {
    // 写盘失败后换镜像，最终信息里两种字样都可能出现
    let raw = "全部失败（最后一次：网络错误 …；写入失败：No space left on device (os error 28)）";
    assert_eq!(friendly(raw).kind, Kind::DiskFull);
}

#[test]
fn 低配判定() {
    let gb = 1024 * 1024 * 1024;
    let ok = SystemSpec {
        cores: 8,
        memory: 16 * gb,
    };
    assert!(low_spec_note(&ok).is_none());
    let few_cores = SystemSpec {
        cores: 4,
        memory: 32 * gb,
    };
    assert!(low_spec_note(&few_cores).unwrap().contains("4 核"));
    let low_mem = SystemSpec {
        cores: 10,
        memory: 8 * gb,
    };
    let note = low_spec_note(&low_mem).unwrap();
    assert!(note.contains("8 GB") && note.contains("慢"), "{note}");
    // 读不到内存（0）时不误报
    let unknown = SystemSpec {
        cores: 8,
        memory: 0,
    };
    assert!(low_spec_note(&unknown).is_none());
}

#[test]
fn 本机能读到核数与内存() {
    let spec = SystemSpec::detect();
    assert!(spec.cores >= 1);
    if cfg!(any(target_os = "macos", windows)) {
        assert!(spec.memory > 1024 * 1024 * 1024);
    }
}

// ---- 修复轮 1：更具体的规则优先；代理单独一类 ----

#[test]
fn socks代理警告加网络错误归为代理而不是端口() {
    let raw = "chrome 下载失败，所有镜像均不可用（最后一次：https://x：网络错误：Connection refused (os error 61)）；暂不支持 socks5://127.0.0.1:7890 这种代理，已改为直连；请改用 HTTP 代理（http://地址:端口）";
    let f = friendly(raw);
    assert_eq!(f.kind, Kind::Proxy, "{raw}");
    assert!(f.hint.contains("代理设置"), "{}", f.hint);
}

#[test]
fn 经代理的网络错误归为代理() {
    let raw = "node 下载失败，所有镜像均不可用（最后一次：https://x：网络错误（经代理 http://127.0.0.1:8080）：Connection Failed: tls connection init failed: unexpected end of file）";
    assert_eq!(friendly(raw).kind, Kind::Proxy);
    let raw = "https://x：45 秒没有收到数据，已换下一个地址（经代理 http://127.0.0.1:8080）";
    assert_eq!(friendly(raw).kind, Kind::Proxy);
}

#[test]
fn 只有端口字样不算端口冲突() {
    assert_ne!(friendly("请填 http://地址:端口").kind, Kind::Port);
    assert_eq!(
        friendly("Error: listen EADDRINUSE 127.0.0.1:4321").kind,
        Kind::Port
    );
    assert_eq!(
        friendly("bind: Address already in use (os error 48)").kind,
        Kind::Port
    );
}

#[test]
fn 更具体的规则优先() {
    // 磁盘满发生在经代理下载时：仍是磁盘满
    let raw = "网络错误（经代理 http://p:1）…；写入失败：No space left on device (os error 28)";
    assert_eq!(friendly(raw).kind, Kind::DiskFull);
    // 证书错误经代理：证书比代理更具体（多半是代理在中间改写了证书）
    let raw = "网络错误（经代理 http://p:1）：invalid peer certificate: UnknownIssuer";
    assert_eq!(friendly(raw).kind, Kind::Certificate);
    // 校验不符不受代理字样影响
    let raw = "u：下载完成但校验不符，已删除重下（经代理 http://p:1）";
    assert_eq!(friendly(raw).kind, Kind::Corrupt);
}

#[test]
fn 意外退出文案不提重试按钮() {
    let f = friendly("某种奇怪的错误");
    assert!(!f.hint.contains("「重试」"), "{}", f.hint);
}

// ---- 终审修复：应用本体 4xx、数据版本过新 ----

#[test]
fn 应用本体下载404时不建议换下载源() {
    let raw = "app-darwin-arm64 下载失败，所有镜像均不可用（最后一次：https://github.com/o/r/releases/download/v1/app.tar.zst：服务器返回 404）";
    let f = friendly(raw);
    assert_eq!(f.kind, Kind::AppUnavailable);
    assert!(f.title.contains("暂时无法下载应用本体"), "{}", f.title);
    assert!(
        f.hint.contains("稍后再试") && f.hint.contains("源码运行"),
        "{}",
        f.hint
    );
    assert!(!f.hint.contains("换一个下载源后"), "{}", f.hint);
    assert_eq!(f.detail, raw);
}

#[test]
fn 其它组件的4xx仍可换下载源() {
    let raw = "node 下载失败，所有镜像均不可用（最后一次：https://x/node.tar.xz：服务器返回 404）";
    assert_eq!(friendly(raw).kind, Kind::Unavailable);
}

#[test]
fn 应用本体的代理认证失败仍归为代理() {
    let raw = "app-win32-x64 下载失败，所有镜像均不可用（最后一次：https://x：服务器返回 407；经代理 http://p:1）";
    assert_eq!(friendly(raw).kind, Kind::Proxy);
}

#[test]
fn 数据版本过新归为请使用最新版启动器() {
    let f = friendly("请使用最新版启动器：这份数据已被 0.3.0 版使用过，当前启动器是 0.2.0 版");
    assert_eq!(f.kind, Kind::Outdated);
    assert_eq!(f.title, "请使用最新版启动器");
}

#[test]
fn 状态码408与429是临时错误不算地址不可用() {
    for code in [408, 429] {
        let app = format!("app-darwin-arm64 下载失败，所有镜像均不可用（最后一次：https://github.com/o/r/a：服务器返回 {code}）");
        assert_eq!(friendly(&app).kind, Kind::Network, "{code}");
        let node =
            format!("node 下载失败，所有镜像均不可用（最后一次：https://x：服务器返回 {code}）");
        assert_eq!(friendly(&node).kind, Kind::Network, "{code}");
    }
    for code in [403, 404, 410] {
        let app = format!(
            "app-darwin-arm64 下载失败，所有镜像均不可用（最后一次：https://x：服务器返回 {code}）"
        );
        assert_eq!(friendly(&app).kind, Kind::AppUnavailable, "{code}");
        let node =
            format!("node 下载失败，所有镜像均不可用（最后一次：https://x：服务器返回 {code}）");
        assert_eq!(friendly(&node).kind, Kind::Unavailable, "{code}");
    }
}
