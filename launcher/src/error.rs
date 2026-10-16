//! 统一错误类型：消息直接面向用户（中文），不引入额外依赖。

use std::fmt;

#[derive(Debug)]
pub struct Error {
    msg: String,
}

impl Error {
    pub fn new(msg: impl Into<String>) -> Self {
        Self { msg: msg.into() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// 给任意错误补一句「在做什么」的上下文。
pub trait Context<T> {
    fn ctx(self, what: impl AsRef<str>) -> Result<T>;
}

impl<T, E: fmt::Display> Context<T> for std::result::Result<T, E> {
    fn ctx(self, what: impl AsRef<str>) -> Result<T> {
        self.map_err(|e| Error::new(format!("{}：{}", what.as_ref(), e)))
    }
}
