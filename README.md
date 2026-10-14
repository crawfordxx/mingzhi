# 明知AI剪辑 · Mingzhi AI Editor

[中文](#中文) | [English](#english)

## 中文

口播视频自动精剪工具：本地语音识别 → 大模型判断废话/口误 → ffmpeg 剪切并压缩长停顿 → 生成并烧录字幕。一条命令出成片。

当前进度：P1（精剪内核，命令行）。花式字幕样式、换背景、B-roll、工作台界面等在后续阶段。

### 环境要求

- Node.js 22 或更高，以及 pnpm
- ffmpeg 和 ffprobe。**烧录字幕需要带 libass 的 ffmpeg**：Homebrew 默认安装的 ffmpeg 不带 libass，会在烧录步骤失败。程序会优先使用 `~/.mingzhi/bin/ffmpeg` 和 `~/.mingzhi/bin/ffprobe`，可以把带 libass 的静态版放到这里；也可以用环境变量 `MINGZHI_FFMPEG`、`MINGZHI_FFPROBE` 指定路径
- 联网（首次下载语音模型；剪辑判断需要调用大模型接口）

### 安装

```bash
pnpm install
pnpm fetch-models   # 下载本地语音识别模型到 ~/.mingzhi/models（可用 MINGZHI_DATA_DIR 改目录）
```

### 配置大模型 key

剪辑判断和字幕校对通过「可想 AI」调用 Gemini。到 https://kexiangai.com 注册（不需要邀请码），在控制台创建 key，然后：

```bash
export MINGZHI_KX_KEY=<你的可想 key>
```

key 只从环境变量读取，不会写入任何文件。

### 使用

```bash
pnpm mingzhi edit <口播视频.mp4> [-o 输出.mp4] [--work 工作目录]
```

- 不指定 `-o` 时，成片写到 `work/<视频名>/<视频名>_精剪.mp4`
- 工作目录里还会保留 `project.json`（识别稿、剪切点、剪辑方案、字幕）、`cut.mp4`（未加字幕的剪切结果）和 `captions.ass`
- 控制台依次打印 9 个步骤：probe、audio、asr、cuts、plan、render、captions、burn、done

### 开发

```bash
pnpm typecheck && pnpm test
```

### 许可证

MIT

## English

An automatic editor for talking-head videos: local speech recognition, an LLM that flags fillers and slips, ffmpeg cutting with long pauses squeezed, then captions generated and burned in. One command in, one finished video out.

Status: P1 (the editing core, command line only). Styled captions, background replacement, B-roll and a GUI come in later phases.

### Requirements

- Node.js 22+ and pnpm
- ffmpeg and ffprobe. **Burning captions needs an ffmpeg built with libass.** Homebrew's default ffmpeg lacks it and the burn step will fail. The app prefers `~/.mingzhi/bin/ffmpeg` and `~/.mingzhi/bin/ffprobe`, so drop a libass-enabled static build there, or point to your own with `MINGZHI_FFMPEG` / `MINGZHI_FFPROBE`
- Internet access (first-time model download; the LLM calls)

### Install

```bash
pnpm install
pnpm fetch-models   # downloads the local ASR models to ~/.mingzhi/models (override the root with MINGZHI_DATA_DIR)
```

### API key

Cut decisions and caption polishing call Gemini through Kexiang AI. Register at https://kexiangai.com (no invite code needed), create a key in the console, then:

```bash
export MINGZHI_KX_KEY=<your Kexiang key>
```

The key is read from the environment only and is never written to disk.

### Usage

```bash
pnpm mingzhi edit <video.mp4> [-o out.mp4] [--work workdir]
```

- Without `-o`, the result goes to `work/<name>/<name>_精剪.mp4`
- The work directory also keeps `project.json` (transcript, cuts, edit plan, captions), `cut.mp4` (cut without captions) and `captions.ass`
- The console prints nine steps: probe, audio, asr, cuts, plan, render, captions, burn, done

### Development

```bash
pnpm typecheck && pnpm test
```

### License

MIT
