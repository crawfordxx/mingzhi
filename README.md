# 明知AI剪辑 · Mingzhi AI Editor

[中文](#中文) | [English](#english)

## 中文

口播视频自动精剪工具：本地语音识别 → 大模型判断废话/口误 → ffmpeg 剪切并压缩长停顿 →（可选）抠像换背景 → 生成字幕 → 大模型设计分镜（上半屏信息卡片、下半屏人物，或人物全屏）→ Remotion 渲染成片（卡片、人像版式切换与字幕一起画，不再用 ffmpeg 烧录字幕）。一条命令出成片。

当前进度：P3c（分镜与成片渲染、B-roll 素材、配乐音效与响度统一、字幕样式、封面，命令行）。工作台界面在后续阶段。

### 环境要求

- Node.js 22 或更高，以及 pnpm
- ffmpeg 和 ffprobe。程序会优先使用 `~/.mingzhi/bin/ffmpeg` 和 `~/.mingzhi/bin/ffprobe`，也可以用环境变量 `MINGZHI_FFMPEG`、`MINGZHI_FFPROBE` 指定路径
- 联网（首次下载语音模型；剪辑判断与分镜需要调用大模型接口）
- 成片由 [Remotion](https://www.remotion.dev) 渲染。**首次渲染会自动下载 Chrome Headless Shell（约 94MB）**；需要走代理时设置 `NODE_USE_ENV_PROXY=1`（Node 22.21 及以上支持，让 Node 使用 `HTTPS_PROXY` 等环境变量），或使用镜像

### 安装

```bash
pnpm install
pnpm fetch-models   # 从 GitHub Releases 下载本地语音识别模型到 ~/.mingzhi/models（可用 MINGZHI_DATA_DIR 改目录）
```

模型从 GitHub Releases 下载，在中国大陆部分网络下可能失败，需要自行配置代理后重试。

### 配置大模型 key

剪辑判断和字幕校对通过「可想 AI」调用 Gemini。到 https://kexiangai.com 注册（不需要邀请码），在控制台创建 key，然后：

```bash
export MINGZHI_KX_KEY=<你的可想 key>
```

key 只从环境变量读取，不会写入任何文件。

### 下载配乐与字体

```bash
pnpm fetch-assets   # 约 136MB：配乐 58MB、字体 78MB，下载到 ~/.mingzhi/assets
```

- 配乐（19 首 CC0）和字幕字体都不随仓库分发，需要先运行这条命令；没下载时照常出片，只是没有背景乐、字幕改用系统字体，并在进度里提示
- 所有下载都校验 sha256，已下载的文件会跳过；单个文件下载超过 10 分钟会超时报错
- 需要走代理时：`NODE_USE_ENV_PROXY=1 pnpm fetch-assets`
- Windows 上解压使用系统自带的 `System32\tar.exe`（Windows 10 及以上）

### 使用

```bash
pnpm mingzhi edit <口播视频.mp4> [-o 输出.mp4] [--work 工作目录] [--bg 预设id|背景图片] [--bg-prompt 一句话描述背景] \
  [--no-broll] [--max-videos N] [--budget 元] [--bgm auto|none|曲目id] [--caption-style 样式id] [--cover-style 风格id] [--no-cover]
```

- 不指定 `-o` 时，成片写到 `work/<视频名>/<视频名>_精剪.mp4`
- 工作目录里还会保留 `project.json`（识别稿、剪切点、剪辑方案、字幕、分镜、配乐、响度、封面等）、`cut.mp4`（未加字幕的剪切结果）和 `captions.ass`（供外部使用，成片里的字幕由 Remotion 绘制）
- 控制台依次打印步骤：probe、audio、asr、cuts、plan、render、captions、storyboard、broll、compose、loudness、cover、done（换背景时在 render 之后还有 background、matte）

| 参数 | 说明 |
| --- | --- |
| `--bg` / `--bg-prompt` | 抠像换背景：内置预设 id、本地图片，或一句话描述（后者需要可想 AI key） |
| `--no-broll` | 不取 B-roll 素材（截图、生图、生成视频），分镜里依赖素材的图片卡改为全屏人像 |
| `--max-videos N` | 最多生成几段 B-roll 视频，默认 1（视频较贵） |
| `--budget 元` | 每条视频的花费上限，默认 10 元（超限自动降级；剪口误、字幕校对、分镜这三步不查预算）。**重跑同一工作目录会重新付费**：只有 B-roll 素材与封面底图有缓存，其余 AI 步骤每次都重新调用；账户余额不足时会直接报错并提示充值 |
| `--bgm auto\|none\|曲目id` | 背景乐：`auto` 按分镜的情绪自动选曲（默认），`none` 不加，或指定曲目 id（见 `assets/music.json`） |
| `--caption-style 样式id` | 字幕样式，默认 `blade` |
| `--cover-style 风格id` | 封面风格，默认 `bauhaus` |
| `--no-cover` | 不生成封面 |

**字幕样式**：`blade` 刀锋（默认）、`wenkai` 文楷、`smiley` 得意、`minimal` 简约、`kuaile` 快乐、`song` 宋韵。

**封面风格**：`bauhaus` 包豪斯（默认）、`swiss` 瑞士国际主义、`memphis` 孟菲斯、`editorial` 杂志极简、`neon` 赛博霓虹、`guochao` 国潮、`risograph` 孔版印刷、`neobrutal` 新粗野主义、`y2k` 千禧 Y2K、`japanese` 日系清新。

**封面**：每次生成竖版 3:4 和横版 4:3 两张，约 2 分钟、约 ¥1.2（需要可想 AI key）。底图在标题核对失败时最多重生一次；同样的风格和标题重跑会复用工作目录里已付费的底图。封面失败只会跳过，不影响成片。两张图保存在工作目录的 `cover-3x4.png`、`cover-4x3.png`；`-o` 指到工作目录之外时，会再复制一份到成片旁边（`<成片名>_封面3x4.png`、`<成片名>_封面4x3.png`）。

**响度**：成片统一到 -14 LUFS，真峰值不超过 -1.0 dBTP。

### 隐私

- 口播音频只在本机处理：语音识别用本地模型，音频不会上传
- 大模型只收到识别出的文字，用于判断剪切点、校对字幕和设计分镜
- 封面步骤会把视频的一张 6 帧联系表（缩略图拼图）发给读图模型，用来挑选人物帧；生成好的封面底图也会发给读图模型核对标题。人脸不会上传给生图模型：生图只收到文字提示词，要求画面里不出现人物，人物是在本机抠像后合成上去的

### 开发

```bash
pnpm typecheck && pnpm test
```

### 第三方素材与许可

- 配乐：HoliznaCC0 的音乐，CC0 1.0，来自 [OpenGameArt](https://opengameart.org)；运行 `pnpm fetch-assets` 时下载，不随仓库分发
- 音效：[Kenney](https://kenney.nl) 的 Interface Sounds，CC0，已随仓库放在 `assets/sfx/`
- 字体：SIL OFL 1.1（Noto Sans SC、Noto Serif SC、LXGW WenKai、得意黑 Smiley Sans、ZCOOL KuaiLe 等）；运行 `pnpm fetch-assets` 时从上游下载，不随仓库分发
- 抠像模型：[RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting)，GPL-3.0；运行 `pnpm fetch-models` 时从上游发布页下载，不随仓库分发

### 许可证

MIT

本项目依赖的 Remotion 使用自己的许可证：个人、非营利组织以及不超过 3 人的公司可以免费使用；**超过 3 人的公司需要购买 Remotion 公司许可证**，详见 https://www.remotion.dev/license 。

## English

An automatic editor for talking-head videos: local speech recognition, an LLM that flags fillers and slips, ffmpeg cutting with long pauses squeezed, optional matting onto a new background, captions, an LLM-designed storyboard (info cards on the top half with the speaker below, or the speaker full screen), then a Remotion render that draws cards, layout moves and captions together (captions are no longer burned in with ffmpeg). One command in, one finished video out.

Status: P3c (storyboard and final render, B-roll, music and sound effects with loudness normalisation, caption styles, covers; command line only). A GUI comes in a later phase.

### Requirements

- Node.js 22+ and pnpm
- ffmpeg and ffprobe. The app prefers `~/.mingzhi/bin/ffmpeg` and `~/.mingzhi/bin/ffprobe`, or point to your own with `MINGZHI_FFMPEG` / `MINGZHI_FFPROBE`
- Internet access (first-time model download; the LLM calls for cuts and the storyboard)
- The final video is rendered with [Remotion](https://www.remotion.dev). **The first render downloads Chrome Headless Shell (about 94MB).** Behind a proxy, set `NODE_USE_ENV_PROXY=1` (Node 22.21+) so Node honours `HTTPS_PROXY` and friends, or use a mirror

### Install

```bash
pnpm install
pnpm fetch-models   # downloads the local ASR models from GitHub releases to ~/.mingzhi/models (override the root with MINGZHI_DATA_DIR)
```

The models come from GitHub releases, which may fail on some networks in mainland China; set up a proxy and retry if so.

### API key

Cut decisions and caption polishing call Gemini through Kexiang AI. Register at https://kexiangai.com (no invite code needed), create a key in the console, then:

```bash
export MINGZHI_KX_KEY=<your Kexiang key>
```

The key is read from the environment only and is never written to disk.

### Download music and fonts

```bash
pnpm fetch-assets   # about 136MB (music 58MB, fonts 78MB) into ~/.mingzhi/assets
```

- The 19 CC0 background tracks and the caption fonts are not shipped with the repo. Without them the video still renders, just with no background music and a system font for captions, and the progress log says so
- Every download is checked against a sha256; files already present are skipped; a single download times out after 10 minutes
- Behind a proxy: `NODE_USE_ENV_PROXY=1 pnpm fetch-assets`
- On Windows, archives are extracted with the built-in `System32\tar.exe` (Windows 10+)

### Usage

```bash
pnpm mingzhi edit <video.mp4> [-o out.mp4] [--work workdir] [--bg preset-id|image] [--bg-prompt "one-line background"] \
  [--no-broll] [--max-videos N] [--budget yuan] [--bgm auto|none|track-id] [--caption-style id] [--cover-style id] [--no-cover]
```

- Without `-o`, the result goes to `work/<name>/<name>_精剪.mp4`
- The work directory also keeps `project.json` (transcript, cuts, edit plan, captions, storyboard, music, loudness, cover, ...), `cut.mp4` (cut without captions) and `captions.ass` (for external use; captions in the video are drawn by Remotion)
- The console prints the steps: probe, audio, asr, cuts, plan, render, captions, storyboard, broll, compose, loudness, cover, done (with a background replacement, background and matte follow render)

| Flag | Meaning |
| --- | --- |
| `--bg` / `--bg-prompt` | Matte the speaker onto a new background: a built-in preset id, a local image, or a one-line description (the latter needs a Kexiang key) |
| `--no-broll` | Skip B-roll (screenshots, generated images, generated video); picture cards that depend on it become full-screen speaker |
| `--max-videos N` | At most N generated B-roll videos, default 1 (videos are the expensive part) |
| `--budget yuan` | Spending cap for B-roll, default 10 yuan |
| `--bgm auto\|none\|track-id` | Background music: `auto` picks by the storyboard's mood (default), `none` disables it, or a track id from `assets/music.json` |
| `--caption-style id` | Caption style, default `blade` |
| `--cover-style id` | Cover style, default `bauhaus` |
| `--no-cover` | Do not generate covers |

**Caption styles**: `blade` (default), `wenkai`, `smiley`, `minimal`, `kuaile`, `song`.

**Cover styles**: `bauhaus` (default), `swiss`, `memphis`, `editorial`, `neon`, `guochao`, `risograph`, `neobrutal`, `y2k`, `japanese`.

**Covers**: a portrait 3:4 and a landscape 4:3 cover per run, about 2 minutes and about 1.2 yuan (needs a Kexiang key). If the title check on the generated art fails it is regenerated once; rerunning with the same style and title reuses the art already paid for in the work directory. A cover failure is skipped without affecting the video. Covers are saved as `cover-3x4.png` and `cover-4x3.png` in the work directory; when `-o` points outside it, they are copied next to the output as `<output name>_封面3x4.png` and `<output name>_封面4x3.png`.

**Loudness**: the final video is normalised to -14 LUFS with a true peak of at most -1.0 dBTP.

### Privacy

- Your speech audio never leaves the machine: recognition runs on a local model
- The LLM only sees the recognised text, to decide cuts, polish captions and design the storyboard
- The cover step sends a 6-frame contact sheet of the video to the vision model to pick a frame with the speaker, and sends the generated cover art back to it to verify the title. Faces are never uploaded for image generation: the image model only gets a text prompt that asks for no people, and the speaker is cut out locally and composited on top

### Development

```bash
pnpm typecheck && pnpm test
```

### Third-party assets

- Music: HoliznaCC0 tracks, CC0 1.0, from [OpenGameArt](https://opengameart.org); downloaded by `pnpm fetch-assets`, not redistributed
- Sound effects: Kenney's [Interface Sounds](https://kenney.nl), CC0, included in the repo under `assets/sfx/`
- Fonts: SIL OFL 1.1 (Noto Sans SC, Noto Serif SC, LXGW WenKai, Smiley Sans, ZCOOL KuaiLe, ...); downloaded from upstream by `pnpm fetch-assets`, not redistributed
- Matting model: [RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting), GPL-3.0; downloaded from the upstream release by `pnpm fetch-models`, not redistributed

### License

MIT

Remotion, which this project depends on, has its own license: individuals, non-profits and companies of up to 3 people may use it for free; **companies with more than 3 people need a Remotion company license**. See https://www.remotion.dev/license .
