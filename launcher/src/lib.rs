//! 明知AI剪辑 启动器核心：清单、下载（续传/校验/镜像）、解包、安装状态。
//! 进度页与启动流程在上层（Task 3）。

pub mod download;
pub mod error;
pub mod hash;
pub mod install;
pub mod manifest;
pub mod paths;
pub mod progress;
pub mod proxy;
pub mod state;
pub mod unpack;
