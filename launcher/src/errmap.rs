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
    Network,
    Unavailable,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Friendly {
    pub kind: Kind,
    pub title: String,
    pub hint: String,
    pub detail: String,
}

/// 按顺序匹配，先命中先用：磁盘满、占用这类「本机问题」排在网络之前，
/// 因为写盘失败后会换镜像，最终信息里常常同时带着网络字样。
const RULES: [(Kind, &[&str]); 7] = [
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
    (Kind::Certificate, &["certificate", "unknownissuer", "证书"]),
    (
        Kind::Port,
        &[
            "eaddrinuse",
            "address already in use",
            "os error 48)",
            "os error 10048)",
            "端口",
        ],
    ),
    (Kind::Corrupt, &["校验不符", "压缩包内容异常", "sha256"]),
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

pub fn classify(raw: &str) -> Kind {
    let lower = raw.to_lowercase();
    RULES
        .iter()
        .find(|(_, pats)| pats.iter().any(|p| lower.contains(p)))
        .map(|(k, _)| *k)
        .unwrap_or(Kind::Other)
}

pub fn friendly(raw: &str) -> Friendly {
    let kind = classify(raw);
    let (title, hint) = match kind {
        Kind::DiskFull => (
            "磁盘空间不足",
            "首次需要约 1 GB 空间。清理一些文件（比如清空废纸篓 / 回收站）后点「重试」。",
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
        Kind::Network => (
            "网络连不上下载服务器",
            "检查网络是否正常；如果在用代理或 VPN，可以在下载设置里换下载源，GitHub 上的文件可以填代理前缀。",
        ),
        Kind::Unavailable => (
            "下载地址暂时不可用",
            "在下载设置里换一个下载源后点「重试」，或者过一会儿再试。",
        ),
        Kind::Other => (
            "出了点意外",
            "点「重试」再试一次；如果一直不行，把下面的详细信息发给我们。",
        ),
    };
    Friendly {
        kind,
        title: title.to_string(),
        hint: hint.to_string(),
        detail: raw.to_string(),
    }
}
