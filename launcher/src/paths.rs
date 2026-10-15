//! 应用根目录（AppRoot）与子目录布局。
//!
//! - macOS：`~/Library/Application Support/Mingzhi`
//! - Windows：`%LOCALAPPDATA%\Mingzhi`
//! - 环境变量 `MINGZHI_APP_ROOT` 可覆盖（测试用）

use crate::error::{Context, Error, Result};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRoot {
    root: PathBuf,
}

impl AppRoot {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 按当前系统与环境变量解析。
    pub fn resolve() -> Result<Self> {
        let os = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            "other"
        };
        Self::resolve_for(os, |k| std::env::var_os(k))
    }

    /// 可注入系统名与环境读取，便于在任意平台测试三种布局。
    pub fn resolve_for(os: &str, get: impl Fn(&str) -> Option<OsString>) -> Result<Self> {
        let get = |k: &str| get(k).filter(|v| !v.is_empty());
        if let Some(v) = get("MINGZHI_APP_ROOT") {
            return Ok(Self::new(v));
        }
        let root = match os {
            "macos" => {
                let home =
                    get("HOME").ok_or_else(|| Error::new("无法确定用户主目录（HOME 未设置）"))?;
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Mingzhi")
            }
            "windows" => {
                let base = get("LOCALAPPDATA")
                    .ok_or_else(|| Error::new("无法确定应用数据目录（LOCALAPPDATA 未设置）"))?;
                PathBuf::from(base).join("Mingzhi")
            }
            // 其它系统仅用于开发调试
            _ => match (get("XDG_DATA_HOME"), get("HOME")) {
                (Some(x), _) => PathBuf::from(x).join("Mingzhi"),
                (None, Some(h)) => PathBuf::from(h)
                    .join(".local")
                    .join("share")
                    .join("Mingzhi"),
                _ => return Err(Error::new("无法确定应用数据目录（HOME 未设置）")),
            },
        };
        Ok(Self::new(root))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn runtime(&self) -> PathBuf {
        self.root.join("runtime")
    }
    pub fn app(&self) -> PathBuf {
        self.root.join("app")
    }
    pub fn data(&self) -> PathBuf {
        self.root.join("data")
    }
    pub fn downloads(&self) -> PathBuf {
        self.root.join("downloads")
    }
    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    /// 创建全部子目录。
    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in [self.runtime(), self.app(), self.data(), self.downloads()] {
            std::fs::create_dir_all(&dir).ctx(format!("创建目录 {} 失败", dir.display()))?;
        }
        Ok(())
    }
}

/// Windows 保留设备名（不含扩展名部分，大小写不敏感）。
const DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 压缩包 / 清单里的单个路径组件是否安全（两个平台统一按 Windows 的严格规则）：
/// 拒绝含 `: < > " | ? *` 与控制字符、以点或空格结尾、Windows 设备名（含带扩展名形式）。
/// 这样既挡住 NTFS 备用数据流、结尾点/空格被规范化等绕过手法，也避免写进设备。
pub fn is_safe_component(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    if name
        .chars()
        .any(|c| c.is_control() || ":<>\"|?*".contains(c))
    {
        return false;
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").trim_end();
    !DEVICE_NAMES.iter().any(|d| stem.eq_ignore_ascii_case(d))
}
