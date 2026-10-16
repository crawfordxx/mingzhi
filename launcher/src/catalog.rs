//! 清单项在进度页上的中文名称、分组，以及「关于」里的许可列表。

use crate::manifest::Item;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    /// 运行环境与应用本体
    Runtime,
    /// 本地模型
    Model,
    /// 配乐、字体（可选）
    Asset,
}

/// id 前缀 → 中文名（按前缀最长匹配的顺序排列）
const NAMES: [(&str, &str); 19] = [
    ("app", "明知AI剪辑 应用"),
    ("node", "Node.js 运行环境"),
    ("ffmpeg", "FFmpeg 视频引擎"),
    ("ffprobe", "FFprobe 媒体分析"),
    ("chrome", "Chrome 渲染内核"),
    ("model-silero-vad", "人声检测模型"),
    ("model-sensevoice-int8", "语音识别模型"),
    ("model-sensevoice-tokens", "语音识别词表"),
    ("model-rvm", "人像抠像模型"),
    ("music-chill", "配乐 · 轻松"),
    ("music-happy", "配乐 · 欢快"),
    ("music-electronic", "配乐 · 电子"),
    ("font-noto-sans-sc", "字体 · 思源黑体"),
    ("font-noto-serif-sc", "字体 · 思源宋体"),
    ("font-zcool-kuaile", "字体 · 站酷快乐体"),
    ("font-zcool-huangyou", "字体 · 站酷庆科黄油体"),
    ("font-lxgw-wenkai", "字体 · 霞鹜文楷"),
    ("font-smiley-sans", "字体 · 得意黑"),
    ("music", "配乐"),
];

pub fn name_of(id: &str) -> String {
    NAMES
        .iter()
        .find(|(prefix, _)| id == *prefix || id.starts_with(&format!("{prefix}-")))
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| id.to_string())
}

pub fn group_of(kind: &str, optional: bool) -> Group {
    match kind {
        "model" => Group::Model,
        _ if optional || kind == "asset" => Group::Asset,
        _ => Group::Runtime,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct License {
    pub name: String,
    pub license: String,
}

/// 「关于」里的许可列表：启动器自身 + 清单各项（同名或同许可合并）+ 进度页字体。
pub fn licenses(items: &[&Item]) -> Vec<License> {
    let mut out = vec![License {
        name: "明知AI剪辑（含本启动器）".into(),
        license: "MIT".into(),
    }];
    for item in items {
        let Some(license) = item.license.as_deref() else {
            continue;
        };
        // 配乐、字体逐个列出太长，按类合并
        let name = match name_of(&item.id) {
            n if n.starts_with("配乐") => "配乐（HoliznaCC0）".to_string(),
            n if n.starts_with("字体") => "字幕字体（思源、站酷、霞鹜、得意黑）".to_string(),
            n => n,
        };
        // 同一份许可（如 FFmpeg 与 FFprobe）合并成一行
        if let Some(same) = out.iter_mut().find(|l| l.license == license) {
            if !same.name.split(" / ").any(|n| n == name) {
                same.name = format!("{} / {name}", same.name);
            }
        } else if !out.iter().any(|l| l.name == name) {
            out.push(License {
                name,
                license: license.to_string(),
            });
        }
    }
    out.push(License {
        name: "IBM Plex 字体（本页面）".into(),
        license: "SIL OFL 1.1".into(),
    });
    out
}
