//! 用户在进度页里改的下载设置：镜像顺序与 GitHub 代理前缀。存进 state.json 的 `settings`。
//!
//! - 镜像：清单 urls 的顺序是「国内镜像优先」；选「官方源优先」时倒序尝试。
//! - GitHub 代理前缀：github.com / raw.githubusercontent.com / objects.githubusercontent.com 的地址
//!   先试 `<前缀><原地址>`，再试原地址兜底。不内置任何第三方代理。
//!   前缀只收 https，且不能指向本机 / 内网地址。

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

/// 前缀最长字符数（防止误粘贴大段文本）
const MAX_PREFIX_LEN: usize = 512;

const GITHUB_HOSTS: [&str; 3] = [
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mirror {
    /// 国内镜像优先（清单原顺序）
    #[default]
    Cn,
    /// 官方源优先（倒序）
    Global,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub mirror: Mirror,
    /// 空串表示不用；非空时以 `/` 结尾
    #[serde(default)]
    pub github_prefix: String,
}

impl Settings {
    /// 重新校验（从 state.json 读回时用）：前缀不合法就清空，镜像保留。
    pub fn sanitized(self) -> Self {
        let github_prefix = normalize_prefix(&self.github_prefix).unwrap_or_default();
        Self {
            github_prefix,
            ..self
        }
    }

    /// 校验并规范化用户输入的前缀。
    pub fn new(mirror: Mirror, github_prefix: &str) -> Result<Self> {
        Ok(Self {
            mirror,
            github_prefix: normalize_prefix(github_prefix)?,
        })
    }

    /// 按设置展开一项的下载地址（顺序即尝试顺序）。
    pub fn urls_for(&self, urls: &[String]) -> Vec<String> {
        let ordered: Vec<&String> = match self.mirror {
            Mirror::Cn => urls.iter().collect(),
            Mirror::Global => urls.iter().rev().collect(),
        };
        let mut out = Vec::with_capacity(urls.len() * 2);
        for url in ordered {
            if !self.github_prefix.is_empty() && is_github(url) {
                out.push(format!("{}{}", self.github_prefix, url));
            }
            out.push(url.clone());
        }
        out
    }
}

fn normalize_prefix(raw: &str) -> Result<String> {
    let p = raw.trim();
    if p.is_empty() {
        return Ok(String::new());
    }
    let invalid = || {
        Error::new(
            "代理前缀格式不对，应形如 https://代理地址/（只支持 https，不能是本机或内网地址）",
        )
    };
    // `#` 之后的内容不会发给服务器，拼上去的原地址会丢
    if p.len() > MAX_PREFIX_LEN
        || p.chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '#')
    {
        return Err(invalid());
    }
    let rest = p
        .get(..8)
        .filter(|s| s.eq_ignore_ascii_case("https://"))
        .map(|_| &p[8..])
        .ok_or_else(invalid)?;
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') || is_private_host(&host_part(authority)) {
        return Err(invalid());
    }
    Ok(if p.ends_with('/') || p.ends_with('=') {
        p.to_string()
    } else {
        format!("{p}/")
    })
}

/// 去掉端口，IPv6 去掉方括号，转小写。
fn host_part(authority: &str) -> String {
    let lower = authority.to_ascii_lowercase();
    if let Some(v6) = lower.strip_prefix('[') {
        return v6.split(']').next().unwrap_or("").to_string();
    }
    lower.split(':').next().unwrap_or("").to_string()
}

/// 本机、回环、内网、链路本地地址：不允许当代理前缀（避免对本机端口发请求）。
fn is_private_host(host: &str) -> bool {
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        return v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified();
    }
    if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        let first = v6.segments()[0];
        return v6.is_loopback()
            || v6.is_unspecified()
            || (first & 0xfe00) == 0xfc00 // 唯一本地 fc00::/7
            || (first & 0xffc0) == 0xfe80; // 链路本地 fe80::/10
    }
    false
}

/// 地址的主机是否为需要套代理前缀的 GitHub 域名。
pub fn is_github(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    GITHUB_HOSTS.contains(&host)
}
