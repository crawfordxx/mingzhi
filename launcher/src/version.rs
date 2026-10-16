//! 版本号 x.y.z[-预发布] 的解析与比较（只认这一种写法）。

use std::cmp::Ordering;

/// 可比较的版本号：(主, 次, 修, 是否正式版)；同号时正式版比预发布新。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(u64, u64, u64, bool);

impl Version {
    /// 认不出的写法返回 None（目录名、数据版本标记里可能有任何内容）。
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) if !pre.is_empty() => (core, true),
            Some(_) => return None,
            None => (text, false),
        };
        let mut parts = core.split('.');
        let mut next = || -> Option<u64> {
            let p = parts.next()?;
            (!p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).then_some(())?;
            p.parse().ok()
        };
        let (a, b, c) = (next()?, next()?, next()?);
        parts.next().is_none().then_some(Self(a, b, c, !pre))
    }

    pub fn cmp_str(a: &str, b: &str) -> Option<Ordering> {
        Some(Self::parse(a)?.cmp(&Self::parse(b)?))
    }
}
