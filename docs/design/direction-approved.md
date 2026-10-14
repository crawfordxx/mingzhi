# 视觉方向确认

**选定：G1 · ego 原味（浅色）** — `G1-ego-light.html`
用户原话（2026-10-14）：「选这个吧, file:///Users/crawford/workspace/mingzhi/onetake/design-demos/G1-ego-light.html」

## 展示过的方向（共四轮）
| 轮次 | 方向 | 文件 | 结果 |
|---|---|---|---|
| 1（剪辑软件布局） | A 暗色专业 / B 杉浦编辑 / C 液态玻璃3D | A-dark-pro / B-bento-editorial / C-glass-3d | 用户：不做剪辑软件界面，改为 AI 自动出片 + 多轮对话 |
| 2（对话布局，进行中被叫停） | A2 / B2 / C2 | 未完成 | 用户：都不太好，参考苹果风 |
| 2.5（苹果风） | A3 暗场光晕 / B3 apple.com 白 / C3 Liquid Glass | A3-apple-dark / B3-apple-light / C3-apple-glass | 用户：再出三个不同风格 |
| 3 | D 工业硬件 / E 潮玩新粗野 / F 电影暗房 | D-industrial / E-neobrutal / F-darkroom | 用户：用 lite.ego.app 的设计风格 |
| 4（ego 风格） | **G1 原味浅色** / G2 暗色 / G3 沉浸画布 | G1-ego-light / G2-ego-dark / G3-ego-canvas | **选定 G1** |

## G1 设计要点（后续实现以此为准）
- ego (lite) token 照抄（见 SPEC-v4-ego.md），两处为对比度偏离：`--text-3` → `#0000008f`；蓝胶囊文字用 brand-6
- 斜体点缀：IBM Plex Serif Italic ExtraLight（仅数字/拉丁/括号小注）；中文点缀用 Noto Serif SC 直立
- 布局：最左 Spaces 栏 / 左对话流 / 右油画画框 + 9:16 白色 macOS 浮窗 + 深色终端窗
- 顶部 brand-1 公告条；主 CTA 黑胶囊，次 CTA #eee 胶囊；@时间 用浅蓝胶囊
- 底部只有细进度条 + 本版改动蓝点；无时间线/轨道/步进键
- 招牌油画 `assets/art/*.png`（gpt-image-2 生成，上线前需压缩）
