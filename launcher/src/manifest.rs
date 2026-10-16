//! 下载清单 manifest.json 的解析与按平台过滤。
//!
//! 字段以 Task 1 的 schema 为准；serde 对未知字段宽容（不加 deny_unknown_fields）。

use crate::error::{Context, Error, Result};
use crate::paths::{is_safe_component, AppRoot};
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
    /// 单文件 gzip（ffmpeg / ffprobe），解出的是文件而不是目录
    #[serde(rename = "gz")]
    Gz,
}

/// 只从压缩包里取出的单个文件（zip 内路径 -> AppRoot 下的 dest）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Entry {
    pub entry: String,
    pub dest: String,
    /// 目前只有 "mp3"：取出后用 data/bin/ffmpeg 转成 128k 立体声 44.1kHz
    #[serde(default)]
    pub transcode: Option<String>,
}

/// 清单中的一项。
#[derive(Debug, Clone, Default, Deserialize)]
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
    /// 安装后给 dest 设可执行位（Windows 忽略）
    #[serde(default)]
    pub executable: bool,
    /// 只取压缩包里的这些文件，而不是整体解包
    #[serde(default)]
    pub entries: Vec<Entry>,
    /// 安装后的可执行文件路径（相对 AppRoot，必须在 dest 之内）；装完设可执行位，
    /// Task 3 用它得到 Chrome 路径
    #[serde(default)]
    pub exec: Option<String>,
    /// 按优先级排列的镜像地址
    pub urls: Vec<String>,
    /// 可选项（配乐、字体）：下载失败不阻塞启动，服务起来后在后台补齐
    #[serde(default)]
    pub optional: bool,
    /// 许可说明，进度页「关于」里列出
    #[serde(default)]
    pub license: Option<String>,
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
            if !item.entries.is_empty() && item.unpack != Some(UnpackKind::Zip) {
                return Err(Error::new(format!(
                    "清单项 {} 的 entries 只能用于 zip",
                    item.id
                )));
            }
            // 所有路径都在入口处校验一遍，后续流程可以放心 join
            item.rel_dest()?;
            for e in &item.entries {
                rel_path(&item.id, &e.dest, &self.version)?;
            }
            if let Some(exec) = &item.exec {
                let exec_rel = rel_path(&item.id, exec, &self.version)?;
                let dest_rel = rel_path(&item.id, &item.dest, &self.version)?;
                if exec_rel == dest_rel || !exec_rel.starts_with(&dest_rel) {
                    return Err(Error::new(format!(
                        "清单项 {} 的 exec 必须在 dest 目录之内",
                        item.id
                    )));
                }
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
        resolve_rel(root, &self.id, &self.dest, version)
    }

    pub fn resolve_exec(&self, root: &AppRoot, version: &str) -> Result<Option<PathBuf>> {
        self.exec
            .as_ref()
            .map(|e| resolve_rel(root, &self.id, e, version))
            .transpose()
    }

    /// 单个 entry 的绝对输出路径。
    pub fn resolve_entry(&self, root: &AppRoot, entry: &Entry, version: &str) -> Result<PathBuf> {
        resolve_rel(root, &self.id, &entry.dest, version)
    }

    /// 解包到目录的「整体替换型」项（会清掉 dest 里原有内容）。
    pub fn replaces_dir(&self) -> bool {
        matches!(self.unpack, Some(k) if k != UnpackKind::Gz) && self.entries.is_empty()
    }

    /// 落盘结果不是下载文件本身（解包 / gz / 取 entry），无法用 dest 反推 sha。
    pub fn is_derived(&self) -> bool {
        self.unpack.is_some()
    }

    /// 该项会写入的全部路径（dest、entries、exec）。
    pub fn footprint(&self, root: &AppRoot, version: &str) -> Result<Vec<PathBuf>> {
        let mut paths = vec![self.resolve_dest(root, version)?];
        for e in &self.entries {
            paths.push(self.resolve_entry(root, e, version)?);
        }
        if let Some(e) = self.resolve_exec(root, version)? {
            paths.push(e);
        }
        Ok(paths)
    }

    /// state.json 里的记录键：`<id>@<展开后的 dest>`。
    /// 同一个 id 在不同版本的清单里 dest 不同（如 `app/0.1.0`、`app/0.2.0`），各有各的记录，
    /// 新旧启动器交替运行时不会互相作废。dest 统一用 `/` 分隔。
    pub fn record_key(&self, version: &str) -> Result<String> {
        let rel = rel_path(&self.id, &self.dest, version)?;
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        Ok(format!("{}@{}", self.id, parts.join("/")))
    }

    fn rel_dest(&self) -> Result<PathBuf> {
        rel_path(&self.id, &self.dest, "0")
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

/// 展开 `{app}` 并校验为相对路径（只允许普通组件）。
fn rel_path(id: &str, raw: &str, version: &str) -> Result<PathBuf> {
    let expanded = raw.replace("{app}", &format!("app/{version}"));
    let mut path = PathBuf::new();
    for comp in Path::new(&expanded).components() {
        match comp {
            Component::Normal(c) if is_safe_component(c) => path.push(c),
            Component::CurDir => {}
            _ => return Err(Error::new(format!("清单项 {id} 的路径不合法：{raw}"))),
        }
    }
    if path.as_os_str().is_empty() {
        return Err(Error::new(format!("清单项 {id} 的路径为空")));
    }
    Ok(path)
}

fn resolve_rel(root: &AppRoot, id: &str, raw: &str, version: &str) -> Result<PathBuf> {
    Ok(root.root().join(rel_path(id, raw, version)?))
}
