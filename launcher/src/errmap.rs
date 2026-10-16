//! 把底层错误（io / ureq 的英文信息、各模块的中文信息）归类成面向零技术用户的提示：
//! 一句话说清发生了什么 + 一句建议，原文作为「详细信息」保留。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    DiskFull,
    Busy,
    Certificate,
    Port,
    Corrupt,
    Proxy,
    Network,
    Unavailable,
    /// 应用本体（只有 GitHub Release 一个地址）下载不了：多半是发布地址还没公开
    AppUnavailable,
    /// 数据已被更新版本使用过，旧版启动器不能再用
    Outdated,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Friendly {
    pub kind: Kind,
    pub title: String,
    pub hint: String,
    pub detail: String,
}

/// 按顺序匹配，先命中先用，**越具体的越靠前**：
/// 磁盘满、文件占用、端口冲突、证书、校验不符这些「明确的原因」优先；
/// 其次是代理（失败信息里带「经代理」或代理警告）；最后才是笼统的网络不通 / 地址失效。
/// 例：写盘失败后会换镜像，最终信息里常同时带网络字样，仍应判为磁盘满。
const RULES: [(Kind, &[&str]); 9] = [
    // 数据版本比启动器新：不是下载问题，最优先
    (Kind::Outdated, &["请使用最新版启动器"]),
    (
        Kind::DiskFull,
        &[
            "os error 28)",
            "os error 112)",
            "no space left",
            "not enough space",
            "磁盘空间不足",
            "disk full",
        ],
    ),
    (
        Kind::Busy,
        &[
            "文件被占用",
            "os error 32)",
            "os error 33)",
            "os error 5)",
            "os error 13)",
            "access is denied",
            "permission denied",
        ],
    ),
    // 只认明确的端口冲突错误，不认「端口」两个字（代理提示里也会出现）
    (
        Kind::Port,
        &[
            "eaddrinuse",
            "address already in use",
            "os error 48)",
            "os error 10048)",
        ],
    ),
    (Kind::Certificate, &["certificate", "unknownissuer", "证书"]),
    (Kind::Corrupt, &["校验不符", "压缩包内容异常", "sha256"]),
    (
        Kind::Proxy,
        &["经代理", "这种代理", "socks", "proxy", "服务器返回 407"],
    ),
    (
        Kind::Network,
        &[
            "network is unreachable",
            "dns",
            "lookup address",
            "connection refused",
            "connection reset",
            "connect error",
            "connection failed",
            "unexpected end of file",
            "timed out",
            "没有收到数据",
            "网络错误",
            "连接中断",
            "连接提前结束",
            "os error 10060)",
            "os error 10061)",
            "os error 11001)",
        ],
    ),
    (
        Kind::Unavailable,
        &[
            "服务器返回 4",
            "文件长度超出清单",
            "文件总长度与清单不符",
            "超出清单声明",
        ],
    ),
];

/// 应用本体（id 以 `app-` 开头）所有地址都是 4xx（代理认证 407 除外）：
/// 它只有 GitHub Release 一个地址，换下载源没有用，要单独说。
fn app_unreachable(lower: &str) -> bool {
    lower.starts_with("app-") && lower.contains("服务器返回 4") && !lower.contains("服务器返回 407")
}

pub fn classify(raw: &str) -> Kind {
    let lower = raw.to_lowercase();
    for (kind, pats) in RULES.iter() {
        // 排在代理之前：明确的原因（磁盘满、证书、校验……）仍优先，但不被笼统的代理提示盖过
        if *kind == Kind::Proxy && app_unreachable(&lower) {
            return Kind::AppUnavailable;
        }
        if pats.iter().any(|p| lower.contains(p)) {
            return *kind;
        }
    }
    Kind::Other
}

pub fn friendly(raw: &str) -> Friendly {
    let kind = classify(raw);
    let (title, hint) = match kind {
        Kind::DiskFull => (
            "磁盘空间不足",
            "首次安装约 1.1 GB，下载中的临时文件还要多占一些，建议留出 1.5 GB。清理一些文件（比如清空废纸篓 / 回收站）后点「重试」。",
        ),
        Kind::Busy => (
            "文件被占用，暂时写不进去",
            "多半是杀毒软件正在扫描刚下载的文件。稍等半分钟再点「重试」；反复出现可把 Mingzhi 目录加入杀毒软件的信任名单。",
        ),
        Kind::Certificate => (
            "安全证书验证没通过",
            "先看看电脑的日期和时间对不对；公司或学校网络可能会拦截下载，换个网络（比如手机热点）再试。",
        ),
        Kind::Port => (
            "端口被别的程序占用了",
            "点「重新启动」会自动换一个端口；还不行就重启一下电脑。",
        ),
        Kind::Corrupt => (
            "下载的文件不完整",
            "已自动删掉坏文件。点「重试」重新下载，或在下载设置里换一个下载源。",
        ),
        Kind::Proxy => (
            "代理连不上下载服务器",
            "请检查代理设置：代理软件是否开着、地址端口对不对；暂不支持 SOCKS 代理，请改用 HTTP 代理，或关掉代理直连。GitHub 上的文件也可以在下载设置里填代理前缀。",
        ),
        Kind::Network => (
            "网络连不上下载服务器",
            "检查网络是否正常；如果在用代理或 VPN，可以在下载设置里换下载源，GitHub 上的文件可以填代理前缀。",
        ),
        Kind::Unavailable => (
            "下载地址暂时不可用",
            "在下载设置里换一个下载源后点「重试」，或者过一会儿再试。",
        ),
        Kind::AppUnavailable => (
            "暂时无法下载应用本体（发布地址不可用）",
            "应用本体只发布在 GitHub，目前这个地址打不开（项目可能还没有公开发布）。请稍后再试，或者从源码运行（见项目 README）；换下载源对它没有用。",
        ),
        Kind::Outdated => (
            "请使用最新版启动器",
            "你电脑上的数据已被更新版本的明知AI剪辑使用过，旧版启动器再去读写可能会出错。请到项目的 Release 页面下载最新版启动器，数据不会受影响。",
        ),
        Kind::Other => (
            "出了点意外",
            "再试一次；如果一直不行，请把下面的详细信息发到项目的 GitHub Issues。",
        ),
    };
    Friendly {
        kind,
        title: title.to_string(),
        hint: hint.to_string(),
        detail: raw.to_string(),
    }
}
