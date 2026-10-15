//! 下载清单 manifest.json 的解析与按平台过滤。
//!
//! 字段以 Task 1 的 schema 为准；serde 对未知字段宽容（不加 deny_unknown_fields）。

use crate::error::{Context, Error, Result};
use crate::paths::AppRoot;
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

/// 压缩包格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum UnpackKind {
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "tar.xz")]
    TarXz,
    #[serde(rename = "zip")]
    Zip,
    #[serde(rename = "tar.zst")]
    TarZst,
}

/// 清单中的一项。
#[derive(Debug, Clone, Deserialize)]
pub struct Item {
    pub id: String,
    /// node / ffmpeg / chrome / model / asset / app；用字符串，新增类别时不至于解析失败
    #[serde(default)]
    pub kind: String,
    /// darwin-arm64 / darwin-x64 / win32-x64 / any
    pub platform: String,
    pub sha256: String,
    pub size: u64,
    /// 相对 AppRoot，可含 `{app}` 占位符
    pub dest: String,
    #[serde(default)]
    pub unpack: Option<UnpackKind>,
    /// 解包时剥掉的前导目录层数（压缩包带一层顶级目录时用），缺省 0
    #[serde(default, alias = "strip_components")]
    pub strip: usize,
    /// 按优先级排列的镜像地址
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    /// 应用版本，`{app}` 占位符展开为 `app/<version>`
    pub version: String,
    #[serde(default, alias = "entries", alias = "files")]
    pub items: Vec<Item>,
}

impl Manifest {
    pub fn parse(json: &str) -> Result<Self> {
        let manifest: Manifest = serde_json::from_str(json).ctx("清单格式有误")?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn load(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).ctx(format!("读取清单 {} 失败", path.display()))?;
        Self::parse(&text)
    }

    /// 清单来自外部，进入后续流程前先把边界校验掉。
    fn validate(&self) -> Result<()> {
        if self.version.is_empty()
            || self.version.contains(['/', '\\'])
            || self.version == ".."
            || self.version == "."
        {
            return Err(Error::new(format!("清单版本号不合法：{:?}", self.version)));
        }
        for item in &self.items {
            if item.id.is_empty() {
                return Err(Error::new("清单中存在没有 id 的项"));
            }
            if item.urls.is_empty() {
                return Err(Error::new(format!("清单项 {} 没有下载地址", item.id)));
            }
        }
        Ok(())
    }

    /// 只保留适用于指定平台的项（含 `any`）。
    pub fn for_platform(&self, platform: &str) -> Vec<&Item> {
        self.items
            .iter()
            .filter(|i| i.platform == platform || i.platform == "any")
            .collect()
    }
}

/// 当前编译目标对应的平台标识。
pub fn current_platform() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        "win32-x64"
    } else {
        "unsupported"
    }
}

impl Item {
    /// 展开占位符并拼出绝对目标路径；拒绝绝对路径与 `..`。
    pub fn resolve_dest(&self, root: &AppRoot, version: &str) -> Result<PathBuf> {
        let expanded = self.dest.replace("{app}", &format!("app/{version}"));
        let mut path = root.root().to_path_buf();
        let mut any = false;
        for comp in Path::new(&expanded).components() {
            match comp {
                Component::Normal(c) => {
                    path.push(c);
                    any = true;
                }
                Component::CurDir => {}
                _ => {
                    return Err(Error::new(format!(
                        "清单项 {} 的 dest 不合法：{}",
                        self.id, self.dest
                    )))
                }
            }
        }
        if !any {
            return Err(Error::new(format!("清单项 {} 的 dest 为空", self.id)));
        }
        Ok(path)
    }

    /// 下载中的 .part 文件名：带上 sha 前缀，清单换版本后不会误续传旧内容。
    pub fn part_name(&self) -> String {
        let safe: String = self
            .id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let short: String = self.sha256.chars().take(8).collect();
        format!("{safe}-{short}.part")
    }
}
