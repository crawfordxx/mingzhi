# 明知AI剪辑 · 第四轮 Spec：ego (lite) 设计风格

> 用户指定：「用他的设计风格吧，https://lite.ego.app/」
> 内容/真实字幕/真实帧沿用 `SPEC.md`；布局与交互范式沿用 `SPEC-v2-chat.md`（左对话 + 右 9:16 大预览 + 最左极窄项目栏，无时间线/轨道/检查器/步进键条）；技术栈、10 个设计资源参考、品质自检循环（5 维每维 ≥8.5）沿用 `SPEC-v3.md`。
> **注意：底部不要再出现按 18 段分格的条带/步进键/刻度尺**——那仍然像剪辑软件。只保留一条细播放进度条（可带两三个“本版改动”小点）。

## ego (lite) 设计 DNA（已从线上实测抽取，务必遵守）
截图：`/private/tmp/claude-501/-Users-crawford-workspace-mingzhi/33f03909-6312-4bc7-87c5-6cf211a66a30/scratchpad/ego/hero.png`、`sheet.jpg`（先 Read 看）。也可自行用 ego-browser 或 WebFetch 打开 https://lite.ego.app/ 细看（页面滚动在内部容器）。

- **字体**：`system-ui, -apple-system, "PingFang SC", sans-serif`；标题 700、44–48px、行高 1.0、颜色 `#000000e6`/`#000000b3`；**每个大标题里一个词用细斜体衬线点缀**（ego 用的是类似 Instrument Serif / Newsreader Italic 300 的字形，如 *browser*、*(lite)*、*(yes, free)*）。中文可用「思源宋体 Light/Noto Serif SC 300 + 斜体变换」或用英文斜体衬线词做点缀（例：「把一条口播，变成 *finished cut*」），自行判断哪种更好看。正文 16–20px、字重 300–400、颜色 `#0000007a`。
- **色彩 token（照抄）**：
  - 背景：`--bg-1:#fff --bg-2:#f7f7f7 --bg-3:#f5f5f5 --bg-4:#eee --bg-5:#e0e0e0`
  - 文字：`--text-1:#000000e6 --text-2:#000000b3 --text-3:#0000007a --text-4:#0000003d`
  - 品牌蓝阶：`--brand-1:#d6dff5 --brand-2:#adc0eb --brand-3:#85a0e0 --brand-4:#5c81d6 --brand-5:#3361cc --brand-6:#294ea3`；`--accent:#5c81d6 --accent-light:#d6dff5 --accent-dark:#2e57b8 --negative:#d65c5c`
  - 暗色（html.dark）：`--bg-1:#2e2e2e --bg-2:#292929 --bg-3:#242424 --bg-4:#141414 --bg-5:#0d0d0d`，文字为白的 e6/b3/7a/3d 透明度
  - 点阵：`--dot-grid-base:#3737371a --dot-grid-active:#004cfe80`；发光边：`--glow-border:#adc0eb`；`--positive-ripple` 蓝色渐变
- **阴影**：`--shadow-1: 0 0 0 1px #0000000f`；`--shadow-2-1: 0 8px 32px 4px #0000000f`；`--shadow-3: 0 0 0 1px #0000000f, 0 16px 48px 0 #00000059`；浮窗 `0 25px 50px -12px rgba(0,0,0,.6)`
- **圆角**：6 / 10 / 13 / 18 / 26 / 36（大浮窗 26–36），按钮胶囊
- **招牌构图**：**印象派油画作底 + 白色 macOS 浮窗（红黄绿三点）+ 深色终端窗叠放**。本项目的油画在 `assets/art/01-studio.png`（书房+三脚架相机）、`02-garden.png`（花园露台+相机补光灯）、`03-cinema.png`（小影院）——gpt-image-2 生成，正在落盘，没有就先占位、交付前换上。
- **关键短语高亮**：浅蓝胶囊底 `--brand-1` + 文字 `--brand-5` 半粗（如 hero 里的「sharing your logged-in browser state」）。
- **按钮**：主 CTA 黑底白字大胶囊（带图标）；次 CTA `#eee` 底灰字胶囊；旁边可用斜体衬线小注（如「(yes, free)」→「(只花 ¥3.84)」）。
- **顶部公告条**：`--brand-1` 底，居中一句话 + 黑色小胶囊按钮。
- **Spaces 隐喻**：ego 把工作区叫 Space，带缩略图；本项目的「项目」可以借这个隐喻。
- 整体气质：明亮、安静、精致、友好，大量留白，信息克制；一处油画带来温度与记忆点。

## 三种诠释（每个 subagent 只做自己那一个）
- **G1 · ego 原味（浅色）** → `G1-ego-light.html`：最忠实的 ego 语言；右侧预览区是一幅油画画框，9:16 成片作为白色浮窗立在画上；对话区是干净的白卡片流；剪辑直播做成那种「深色终端窗」叠在白窗上。
- **G2 · ego 暗色** → `G2-ego-dark.html`：用 ego 自己的 html.dark token 做全暗版（看片更准）；油画降低亮度作为舞台背景氛围；蓝阶做唯一彩色；点阵网格做背景纹理，AI 工作时点阵中的点被蓝色点亮扩散（`--dot-grid-active`）。
- **G3 · ego 沉浸画布** → `G3-ego-canvas.html`：整个工作台铺在一幅全幅油画上，所有面板（项目栏、对话、预览、输入框）都是浮在画上的白色/半透明窗口，像 ego hero 放大成一个 App；切项目（Space）时背景油画随之切换（三幅轮换）；大标题斜体衬线点缀最显眼。

## 交付
同目录 `<G1-ego-light|G2-ego-dark|G3-ego-canvas>.html` + 默认态 `.png` + `-replay.png` + `-compare.png`（1440×900）。HTML 顶部注释写「ego 设计 DNA 对照表」（用了哪些 token/构图）+ 参考清单。回报：文件路径、5 维分数变化、已知缺陷。
