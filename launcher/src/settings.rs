//! 用户在进度页里改的下载设置：镜像顺序与 GitHub 代理前缀。存进 state.json 的 `settings`。
//!
//! - 镜像：清单 urls 的顺序是「国内镜像优先」；选「官方源优先」时倒序尝试。
//! - GitHub 代理前缀：github.com / raw.githubusercontent.com / objects.githubusercontent.com 的地址
//!   先试 `<前缀><原地址>`，再试原地址兜底。不内置任何第三方代理。

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
            "代理前缀格式不对，应形如 https://代理地址/（填完整的 http:// 或 https:// 开头的地址）",
        )
    };
    if p.len() > MAX_PREFIX_LEN || p.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid());
    }
    let lower = p.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(invalid)?;
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains(['@', '?', '#']) {
        return Err(invalid());
    }
    Ok(if p.ends_with('/') {
        p.to_string()
    } else {
        format!("{p}/")
    })
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
