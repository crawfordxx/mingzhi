# P1 精剪核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 命令行 `pnpm mingzhi edit <口播.mp4>` 全自动去掉气口、口误、重复、停顿，并烧录校对过的字幕，输出竖屏 mp4 和 `project.json`。

**Architecture:** 纯 TypeScript（Node 22 ESM）。本地 sherpa-onnx（Silero VAD 切段 + SenseVoice 逐字识别，关闭 ITN）产出带时间戳的 token；可想 AI 的 `gemini-3.5-flash` 按 **token 下标**（不是秒数，避免模型编造时间）返回要剪的范围和字幕分行；纯函数把语音段与剪切合成保留区间；ffmpeg 一次 filter_complex 完成剪切，再用 ASS 字幕烧录。每一步都通过 `onProgress` 回调汇报，为 P5 的「剪辑直播」预留。

**Tech Stack:** Node 22、TypeScript 5.6、vitest 2、tsx、zod 3、sherpa-onnx-node 1.13.8、系统 ffmpeg/ffprobe（P6 再打包）

**Spec:** `docs/DECISIONS.md`、`docs/superpowers/plans/2026-10-14-roadmap.md`

## Global Constraints
- 仓库根：`/Users/crawford/workspace/mingzhi`；包管理器 pnpm；`"type": "module"`；许可证 MIT
- 代码注释、日志、报错信息用中文；commit message 用中文，格式 `<type>: <描述>`（feat/fix/test/chore/docs）；**不加任何署名行**
- 不得在仓库里写入任何 API key；可想 key 只从环境变量 `MINGZHI_KX_KEY` 读取（原始 key，不带 `sk-`，代码负责加前缀；若已带 `sk-` 不重复加）
- 可想文本接口：`POST https://kexiangai.com/api/v1/chat/completions`，`Authorization: Bearer sk-<key>`
- 剪口误/字幕校对模型：`google/gemini-3.5-flash`，必须带 `"reasoning_effort": "low"`、`"temperature": 0`、`"response_format": {"type": "json_object"}`
- ASR 模型目录：`~/.mingzhi/models`（可用 `MINGZHI_DATA_DIR` 覆盖数据根目录）；SenseVoice 目录名 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`，VAD 文件 `silero_vad.onnx`
- SenseVoice 配置：`language: 'zh'`、`useInverseTextNormalization: 0`
- 输出视频：H.264 `-crf 18 -preset veryfast`、30fps、AAC 192k，分辨率与输入一致
- 文件 ≤ 400 行、函数 ≤ 50 行；纯函数不修改入参（返回新数组/对象）
- 每个任务提交前运行 `pnpm typecheck && pnpm test`，全绿才提交

## File Structure

```
package.json / tsconfig.json / vitest.config.ts / .gitignore(已存在，追加)
scripts/
  fetch-models.mjs        下载 SenseVoice + Silero VAD 到 ~/.mingzhi/models
  make-fixture.sh         用 macOS say + ffmpeg 生成带口误/停顿的测试口播
src/
  config.ts               读取环境变量 → AppConfig
  types/sherpa-onnx-node.d.ts   sherpa-onnx-node 的最小类型声明
  media/exec.ts           execFile 封装（统一报错）
  media/probe.ts          ffprobe → MediaInfo
  media/extract-audio.ts  → 16k 单声道 wav
  asr/types.ts            Token / SpeechSegment / Transcript
  asr/tokens.ts           SenseVoice 原始输出 → 绝对时间 Token（纯函数）
  asr/local-asr.ts        VAD 切段 + SenseVoice 识别
  llm/kexiang.ts          可想 chat 客户端（重试、超时、JSON 解析）
  cut/llm-cuts.ts         剪口误：提示词、格式化、校验
  cut/plan.ts             语音段 + 剪切 → 保留区间；时间映射（纯函数）
  cut/render-cut.ts       ffmpeg 剪切
  captions/lines.ts       字幕分行：LLM 校对 + 兜底切分 + 映射到成片时间
  captions/ass.ts         生成 ASS
  captions/burn.ts        ffmpeg 烧录字幕
  pipeline/run.ts         串起全部步骤，写 project.json
  cli.ts                  命令行入口
tests/
  fixtures/talk.mp4       make-fixture.sh 生成并提交（~300KB）
  helpers/models.ts       判断本机是否已下载模型
  *.test.ts               与 src 一一对应
```

---

### Task 1: 项目脚手架与配置

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config.ts`, `tests/config.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`，`AppConfig = { dataDir: string; modelsDir: string; ffmpeg: string; ffprobe: string; kexiangKey?: string }`

- [ ] **Step 1: 写 package.json / tsconfig / vitest 配置**

`package.json`:
```json
{
  "name": "mingzhi",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "fetch-models": "node scripts/fetch-models.mjs",
    "make-fixture": "bash scripts/make-fixture.sh",
    "mingzhi": "tsx src/cli.ts"
  },
  "dependencies": {
    "sherpa-onnx-node": "1.13.8",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "@types/node": "22.10.2",
    "tsx": "4.19.2",
    "typescript": "5.6.3",
    "vitest": "2.1.8"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120_000 },
});
```

`.gitignore` 追加：
```
work/
*.local.mp4
```

Run: `cd /Users/crawford/workspace/mingzhi && pnpm install`
Expected: 安装成功，生成 `pnpm-lock.yaml`

- [ ] **Step 2: 写失败测试 `tests/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('默认使用 ~/.mingzhi 与系统 ffmpeg', () => {
    const cfg = loadConfig({});
    expect(cfg.dataDir).toBe(join(homedir(), '.mingzhi'));
    expect(cfg.modelsDir).toBe(join(homedir(), '.mingzhi', 'models'));
    expect(cfg.ffmpeg).toBe('ffmpeg');
    expect(cfg.ffprobe).toBe('ffprobe');
    expect(cfg.kexiangKey).toBeUndefined();
  });

  it('环境变量可覆盖', () => {
    const cfg = loadConfig({ MINGZHI_DATA_DIR: '/tmp/mz', MINGZHI_FFMPEG: '/opt/ff', MINGZHI_FFPROBE: '/opt/fp', MINGZHI_KX_KEY: 'abc' });
    expect(cfg.modelsDir).toBe('/tmp/mz/models');
    expect(cfg.ffmpeg).toBe('/opt/ff');
    expect(cfg.ffprobe).toBe('/opt/fp');
    expect(cfg.kexiangKey).toBe('abc');
  });
});
```

Run: `pnpm test tests/config.test.ts` → Expected: FAIL（找不到 `../src/config.js`）

- [ ] **Step 3: 实现 `src/config.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 运行配置：全部来自环境变量，便于启动器（P6）注入打包好的二进制路径 */
export interface AppConfig {
  dataDir: string;
  modelsDir: string;
  ffmpeg: string;
  ffprobe: string;
  kexiangKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.MINGZHI_DATA_DIR ?? join(homedir(), '.mingzhi');
  return {
    dataDir,
    modelsDir: join(dataDir, 'models'),
    ffmpeg: env.MINGZHI_FFMPEG ?? 'ffmpeg',
    ffprobe: env.MINGZHI_FFPROBE ?? 'ffprobe',
    kexiangKey: env.MINGZHI_KX_KEY || undefined,
  };
}
```

- [ ] **Step 4: 验证** — `pnpm typecheck && pnpm test` → Expected: 2 passed

- [ ] **Step 5: 提交**
```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore src/config.ts tests/config.test.ts
git commit -m "chore: 初始化 TypeScript 项目与运行配置"
```

---

### Task 2: 测试口播样片 + ffmpeg 媒体工具

**Files:**
- Create: `scripts/make-fixture.sh`, `tests/fixtures/talk.mp4`（脚本生成）, `src/media/exec.ts`, `src/media/probe.ts`, `src/media/extract-audio.ts`, `tests/media.test.ts`

**Interfaces:**
- Consumes: `AppConfig`（Task 1）
- Produces:
  - `run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>`
  - `parseProbe(json: unknown): MediaInfo`、`probe(path: string, cfg: AppConfig): Promise<MediaInfo>`，`MediaInfo = { durationSec: number; width: number; height: number; fps: number; hasAudio: boolean }`
  - `extractWav16k(input: string, outWav: string, cfg: AppConfig): Promise<void>`

- [ ] **Step 1: 写样片生成脚本 `scripts/make-fixture.sh`**（只需在 macOS 上运行一次，产物提交进仓库）

```bash
#!/usr/bin/env bash
# 生成带气口、重复、口误和 1.5 秒停顿的测试口播（540x960 竖屏，约 14 秒）
set -euo pipefail
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures"
TMP="$(mktemp -d)"
mkdir -p "$OUT_DIR"
say -v Tingting -o "$TMP/a.aiff" "然后呢，嗯，我平时经常在 GitHub 上面去逛，去逛 AI 项目。"
say -v Tingting -o "$TMP/b.aiff" "最近发现了一个，一个项目，叫高性价比人生指南。这个项目里面一共讲了六百，不对，讲了六百五十条。"
ffmpeg -v error -y -i "$TMP/a.aiff" -ar 44100 -ac 1 "$TMP/a.wav"
ffmpeg -v error -y -i "$TMP/b.aiff" -ar 44100 -ac 1 "$TMP/b.wav"
ffmpeg -v error -y -f lavfi -t 1.5 -i anullsrc=r=44100:cl=mono "$TMP/s.wav"
ffmpeg -v error -y -i "$TMP/a.wav" -i "$TMP/s.wav" -i "$TMP/b.wav" \
  -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]" -map "[a]" "$TMP/talk.wav"
ffmpeg -v error -y -f lavfi -i color=c=0x334455:s=540x960:r=30 -i "$TMP/talk.wav" \
  -shortest -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 96k "$OUT_DIR/talk.mp4"
rm -rf "$TMP"
echo "已生成 $OUT_DIR/talk.mp4"
```

Run: `pnpm make-fixture && ls -la tests/fixtures/talk.mp4`
Expected: 文件存在，大小 100–500KB

- [ ] **Step 2: 写失败测试 `tests/media.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { parseProbe, probe } from '../src/media/probe.js';
import { extractWav16k } from '../src/media/extract-audio.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'talk.mp4');
const cfg = loadConfig({});

describe('parseProbe', () => {
  it('解析视频流、音频流、帧率与时长', () => {
    const info = parseProbe({
      format: { duration: '12.5' },
      streams: [
        { codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30000/1001' },
        { codec_type: 'audio' },
      ],
    });
    expect(info).toEqual({ durationSec: 12.5, width: 1080, height: 1920, fps: 29.97, hasAudio: true });
  });

  it('没有视频流时报错', () => {
    expect(() => parseProbe({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] })).toThrow('没有视频流');
  });
});

describe('ffmpeg 集成', () => {
  it('probe 读取样片', async () => {
    const info = await probe(FIXTURE, cfg);
    expect(info.width).toBe(540);
    expect(info.height).toBe(960);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeGreaterThan(8);
  });

  it('extractWav16k 输出 16k 单声道 wav', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'mz-')), 'a.wav');
    await extractWav16k(FIXTURE, out, cfg);
    const info = statSync(out);
    expect(info.size).toBeGreaterThan(100_000);
  });
});
```

Run: `pnpm test tests/media.test.ts` → Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现三个模块**

`src/media/exec.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 执行外部命令；失败时把 stderr 末尾 800 字附在报错里，方便定位 ffmpeg 问题 */
export async function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const tail = (e.stderr ?? '').slice(-800);
    throw new Error(`命令执行失败：${cmd} ${args.slice(0, 6).join(' ')}…\n${tail || e.message}`);
  }
}
```

`src/media/probe.ts`:
```ts
import type { AppConfig } from '../config.js';
import { run } from './exec.js';

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

interface ProbeStream { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }
interface ProbeJson { format?: { duration?: string }; streams?: ProbeStream[] }

function parseRate(rate: string | undefined): number {
  const [num, den] = (rate ?? '30/1').split('/').map(Number);
  const fps = den ? num / den : num;
  return Math.round(fps * 100) / 100;
}

export function parseProbe(json: unknown): MediaInfo {
  const data = json as ProbeJson;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) throw new Error('输入文件没有视频流');
  return {
    durationSec: Number(data.format?.duration ?? 0),
    width: video.width,
    height: video.height,
    fps: parseRate(video.r_frame_rate),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

export async function probe(path: string, cfg: AppConfig): Promise<MediaInfo> {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path]);
  return parseProbe(JSON.parse(stdout));
}
```

`src/media/extract-audio.ts`:
```ts
import type { AppConfig } from '../config.js';
import { run } from './exec.js';

/** 抽取 16kHz 单声道 PCM wav，供 VAD 与 SenseVoice 使用 */
export async function extractWav16k(input: string, outWav: string, cfg: AppConfig): Promise<void> {
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
}
```

- [ ] **Step 4: 验证** — `pnpm typecheck && pnpm test` → Expected: 全部通过

- [ ] **Step 5: 提交**
```bash
git add scripts/make-fixture.sh tests/fixtures/talk.mp4 src/media tests/media.test.ts
git commit -m "feat: 媒体探测与音频抽取，附带口误测试样片"
```

---

### Task 3: 本地语音识别（VAD + SenseVoice）

**Files:**
- Create: `scripts/fetch-models.mjs`, `src/types/sherpa-onnx-node.d.ts`, `src/asr/types.ts`, `src/asr/tokens.ts`, `src/asr/local-asr.ts`, `tests/helpers/models.ts`, `tests/asr.test.ts`

**Interfaces:**
- Consumes: `AppConfig.modelsDir`、`extractWav16k`（Task 2）
- Produces:
  - `Token = { text: string; start: number; end: number }`（秒，绝对时间）
  - `SpeechSegment = { start: number; end: number }`
  - `Transcript = { durationSec: number; segments: SpeechSegment[]; tokens: Token[] }`
  - `buildTokens(raw: { tokens: string[]; timestamps: number[] }, offsetSec: number, segEndSec: number): Token[]`
  - `transcribeWav(wavPath: string, modelsDir: string): Transcript`
  - `SENSEVOICE_DIR`、`modelsReady(modelsDir: string): boolean`

- [ ] **Step 1: 写模型下载脚本 `scripts/fetch-models.mjs`**

```js
// 下载 SenseVoice（int8）与 Silero VAD 到 ~/.mingzhi/models（可用 MINGZHI_DATA_DIR 覆盖）
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const SV = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const dir = join(process.env.MINGZHI_DATA_DIR ?? join(homedir(), '.mingzhi'), 'models');
mkdirSync(dir, { recursive: true });

async function download(url, dest) {
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

if (!existsSync(join(dir, 'silero_vad.onnx'))) await download(`${BASE}/silero_vad.onnx`, join(dir, 'silero_vad.onnx'));
if (!existsSync(join(dir, SV, 'model.int8.onnx'))) {
  const tar = join(dir, `${SV}.tar.bz2`);
  await download(`${BASE}/${SV}.tar.bz2`, tar);
  execFileSync('tar', ['xjf', tar, '-C', dir]);
  execFileSync('rm', ['-f', tar, join(dir, SV, 'model.onnx')]); // 只保留 int8 版，省 700MB
}
console.log(`模型就绪：${dir}`);
```

Run: `pnpm fetch-models` → Expected: 末行 `模型就绪：/Users/…/.mingzhi/models`

- [ ] **Step 2: 写类型声明与类型文件**

`src/types/sherpa-onnx-node.d.ts`:
```ts
// sherpa-onnx-node 没有自带类型，这里只声明本项目用到的部分
declare module 'sherpa-onnx-node' {
  interface Wave { samples: Float32Array; sampleRate: number }
  interface VadSegment { start: number; samples: Float32Array }
  interface OfflineResult { text: string; tokens: string[]; timestamps: number[] }
  interface OfflineStream { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void }
  class Vad {
    constructor(config: unknown, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(): VadSegment;
    pop(): void;
    flush(): void;
  }
  class OfflineRecognizer {
    constructor(config: unknown);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineResult;
  }
  const sherpa: { readWave(path: string): Wave; Vad: typeof Vad; OfflineRecognizer: typeof OfflineRecognizer };
  export default sherpa;
}
```

`src/asr/types.ts`:
```ts
/** 单个识别单元（中文为单字，英文为子词），时间为原片绝对秒数 */
export interface Token { text: string; start: number; end: number }
export interface SpeechSegment { start: number; end: number }
export interface Transcript { durationSec: number; segments: SpeechSegment[]; tokens: Token[] }
```

- [ ] **Step 3: 写失败测试 `tests/asr.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTokens } from '../src/asr/tokens.js';
import { transcribeWav } from '../src/asr/local-asr.js';
import { extractWav16k } from '../src/media/extract-audio.js';
import { loadConfig } from '../src/config.js';
import { hasModels } from './helpers/models.js';

describe('buildTokens', () => {
  it('加上片段偏移，end 取下一个 token 的开始，最长 0.5 秒', () => {
    const tokens = buildTokens({ tokens: ['今', '天', ' ', '好'], timestamps: [0.1, 0.3, 0.4, 1.5] }, 10, 12);
    expect(tokens).toEqual([
      { text: '今', start: 10.1, end: 10.3 },
      { text: '天', start: 10.3, end: 10.4 },
      { text: '好', start: 11.5, end: 12 },
    ]);
  });

  it('不修改入参', () => {
    const raw = { tokens: ['a'], timestamps: [0] };
    buildTokens(raw, 0, 1);
    expect(raw).toEqual({ tokens: ['a'], timestamps: [0] });
  });
});

describe.skipIf(!hasModels())('transcribeWav（需要本地模型）', () => {
  it('识别样片并在 1.5 秒停顿处切段', async () => {
    const cfg = loadConfig({});
    const wav = join(mkdtempSync(join(tmpdir(), 'mz-')), 'a.wav');
    await extractWav16k(join(import.meta.dirname, 'fixtures', 'talk.mp4'), wav, cfg);
    const t = transcribeWav(wav, cfg.modelsDir);
    const text = t.tokens.map((x) => x.text).join('');
    expect(text).toContain('高性价比');
    expect(t.segments.length).toBeGreaterThanOrEqual(2);
    const maxGap = Math.max(...t.segments.slice(1).map((s, i) => s.start - t.segments[i].end));
    expect(maxGap).toBeGreaterThan(1.0);
    expect(t.tokens.every((x, i) => i === 0 || x.start >= t.tokens[i - 1].start)).toBe(true);
  });
});
```

`tests/helpers/models.ts`:
```ts
import { loadConfig } from '../../src/config.js';
import { modelsReady } from '../../src/asr/local-asr.js';

export const hasModels = (): boolean => modelsReady(loadConfig({}).modelsDir);
```

Run: `pnpm test tests/asr.test.ts` → Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `src/asr/tokens.ts` 与 `src/asr/local-asr.ts`**

`src/asr/tokens.ts`:
```ts
import type { Token } from './types.js';

const MAX_TOKEN_SEC = 0.5;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** SenseVoice 时间戳相对片段起点，这里转成原片绝对时间并补上 end；空白 token 丢弃 */
export function buildTokens(raw: { tokens: string[]; timestamps: number[] }, offsetSec: number, segEndSec: number): Token[] {
  const result: Token[] = [];
  raw.tokens.forEach((tok, i) => {
    const text = tok.trim();
    if (!text) return;
    const start = round(offsetSec + raw.timestamps[i]);
    const nextStart = i + 1 < raw.tokens.length ? offsetSec + raw.timestamps[i + 1] : segEndSec;
    const end = round(Math.min(nextStart, start + MAX_TOKEN_SEC, segEndSec));
    result.push({ text, start, end: Math.max(end, round(start + 0.02)) });
  });
  return result;
}
```

`src/asr/local-asr.ts`:
```ts
import sherpa from 'sherpa-onnx-node';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildTokens } from './tokens.js';
import type { SpeechSegment, Token, Transcript } from './types.js';

export const SENSEVOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const SR = 16000;
const WINDOW = 512;
const round = (n: number): number => Math.round(n * 1000) / 1000;

export function modelsReady(modelsDir: string): boolean {
  return existsSync(join(modelsDir, 'silero_vad.onnx')) && existsSync(join(modelsDir, SENSEVOICE_DIR, 'model.int8.onnx'));
}

function createVad(modelsDir: string) {
  return new sherpa.Vad({
    sileroVad: { model: join(modelsDir, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.1, maxSpeechDuration: 20, windowSize: WINDOW },
    sampleRate: SR, debug: 0, numThreads: 1,
  }, 60);
}

function createRecognizer(modelsDir: string) {
  const dir = join(modelsDir, SENSEVOICE_DIR);
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    // 关闭 ITN：保留口语原样（如「五毛一」），口误检测更准；数字格式交给字幕校对
    modelConfig: { senseVoice: { model: join(dir, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: 0 }, tokens: join(dir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0 },
  });
}

/** VAD 切出语音段（每段 ≤20 秒），逐段识别，返回绝对时间的 token 与语音段 */
export function transcribeWav(wavPath: string, modelsDir: string): Transcript {
  if (!modelsReady(modelsDir)) throw new Error(`缺少语音识别模型（${modelsDir}），请先运行 pnpm fetch-models`);
  const wave = sherpa.readWave(wavPath);
  if (wave.sampleRate !== SR) throw new Error(`需要 16kHz 音频，实际为 ${wave.sampleRate}Hz`);
  const vad = createVad(modelsDir);
  const rec = createRecognizer(modelsDir);
  const raw: { start: number; samples: Float32Array }[] = [];
  const drain = (): void => { while (!vad.isEmpty()) { raw.push(vad.front()); vad.pop(); } };
  for (let i = 0; i + WINDOW <= wave.samples.length; i += WINDOW) { vad.acceptWaveform(wave.samples.subarray(i, i + WINDOW)); drain(); }
  vad.flush();
  drain();
  const segments: SpeechSegment[] = [];
  const tokens: Token[] = [];
  for (const seg of raw) {
    const start = seg.start / SR;
    const end = start + seg.samples.length / SR;
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: SR, samples: seg.samples });
    rec.decode(stream);
    segments.push({ start: round(start), end: round(end) });
    tokens.push(...buildTokens(rec.getResult(stream), start, end));
  }
  return { durationSec: wave.samples.length / SR, segments, tokens };
}
```

- [ ] **Step 5: 验证** — `pnpm typecheck && pnpm test` → Expected: buildTokens 2 通过；已下载模型时 transcribeWav 通过，否则显示 skipped

- [ ] **Step 6: 提交**
```bash
git add scripts/fetch-models.mjs src/types src/asr tests/helpers tests/asr.test.ts
git commit -m "feat: 本地语音识别（Silero VAD + SenseVoice 字级时间戳）"
```

---

### Task 4: 可想 AI 客户端

**Files:**
- Create: `src/llm/kexiang.ts`, `tests/kexiang.test.ts`

**Interfaces:**
- Produces:
  - `interface LlmClient { chatJson(opts: ChatOptions): Promise<unknown> }`
  - `ChatOptions = { model: string; system: string; user: string; reasoningEffort?: 'low' | 'medium' | 'high'; timeoutMs?: number }`
  - `class KexiangClient implements LlmClient { constructor(apiKey: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>) }`
  - `parseJsonContent(content: string): unknown`
  - `KEXIANG_CHAT_URL`

- [ ] **Step 1: 写失败测试 `tests/kexiang.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { KexiangClient, KEXIANG_CHAT_URL, parseJsonContent } from '../src/llm/kexiang.js';

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const noSleep = async () => {};

describe('parseJsonContent', () => {
  it('去掉 ```json 代码块包裹', () => {
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('非 JSON 时报错', () => {
    expect(() => parseJsonContent('hello')).toThrow('不是合法 JSON');
  });
});

describe('KexiangClient', () => {
  it('没有 key 时构造即报错', () => {
    expect(() => new KexiangClient('')).toThrow('MINGZHI_KX_KEY');
  });

  it('发送正确的请求并解析 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"cuts":[]}'));
    const client = new KexiangClient('abc', fetchMock, noSleep);
    const out = await client.chatJson({ model: 'google/gemini-3.5-flash', system: 's', user: 'u', reasoningEffort: 'low' });
    expect(out).toEqual({ cuts: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(KEXIANG_CHAT_URL);
    expect(init.headers.Authorization).toBe('Bearer sk-abc');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'google/gemini-3.5-flash', temperature: 0, reasoning_effort: 'low', response_format: { type: 'json_object' } });
    expect(body.messages).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
  });

  it('key 已带 sk- 前缀时不重复添加', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{}'));
    await new KexiangClient('sk-abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-abc');
  });

  it('5xx/429 重试，最多 3 次', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 502 }))
      .mockResolvedValueOnce(new Response('limit', { status: 429 }))
      .mockResolvedValueOnce(ok('{"x":1}'));
    const out = await new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' });
    expect(out).toEqual({ x: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('4xx 直接报错并带上响应内容', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('余额不足', { status: 400 }));
    await expect(new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }))
      .rejects.toThrow('可想 AI 请求失败 400：余额不足');
  });
});
```

Run: `pnpm test tests/kexiang.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 `src/llm/kexiang.ts`**

```ts
export const KEXIANG_CHAT_URL = 'https://kexiangai.com/api/v1/chat/completions';
const MAX_ATTEMPTS = 3;

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

export interface LlmClient {
  chatJson(opts: ChatOptions): Promise<unknown>;
}

export function parseJsonContent(content: string): unknown {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`模型返回的不是合法 JSON：${cleaned.slice(0, 120)}`);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class KexiangClient implements LlmClient {
  private readonly auth: string;

  constructor(apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly sleep = defaultSleep) {
    if (!apiKey) throw new Error('未配置可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
    this.auth = `Bearer ${apiKey.startsWith('sk-') ? apiKey : `sk-${apiKey}`}`;
  }

  async chatJson(opts: ChatOptions): Promise<unknown> {
    const body = JSON.stringify({
      model: opts.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
    });
    let lastError = new Error('可想 AI 请求失败');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const res = await this.fetchImpl(KEXIANG_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`可想 AI 暂时不可用 ${res.status}：${(await res.text()).slice(0, 200)}`);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`可想 AI 请求失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('可想 AI 返回格式异常：缺少 choices[0].message.content');
      return parseJsonContent(content);
    }
    throw lastError;
  }
}
```

- [ ] **Step 3: 验证** — `pnpm typecheck && pnpm test` → Expected: 全部通过

- [ ] **Step 4: 提交**
```bash
git add src/llm tests/kexiang.test.ts
git commit -m "feat: 可想 AI 对话客户端（JSON 模式、重试、超时）"
```

---

### Task 5: 剪口误（按 token 下标）

**Files:**
- Create: `src/cut/llm-cuts.ts`, `tests/llm-cuts.test.ts`

**Interfaces:**
- Consumes: `Token`（Task 3）、`LlmClient`（Task 4）
- Produces:
  - `CutType = 'filler' | 'repeat' | 'slip' | 'false_start'`
  - `Cut = { from: number; to: number; type: CutType; reason: string }`（token 下标，闭区间）
  - `formatTokensForLlm(tokens: Token[]): string`
  - `validateCuts(raw: unknown, tokenCount: number): Cut[]`
  - `detectCuts(client: LlmClient, tokens: Token[]): Promise<Cut[]>`
  - `CUT_MODEL = 'google/gemini-3.5-flash'`、`MAX_CUT_RATIO = 0.35`

- [ ] **Step 1: 写失败测试 `tests/llm-cuts.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { Token } from '../src/asr/types.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { detectCuts, formatTokensForLlm, validateCuts } from '../src/cut/llm-cuts.js';

const tk = (text: string, start: number): Token => ({ text, start, end: start + 0.2 });
// 12 个字：正常剪 3 个（25%）不触发 35% 的防误删上限
const tokens = ['嗯', '我', '去', '逛', '去', '逛', 'A', 'I', '项', '目', '很', '好'].map((t, i) => tk(t, Math.round(i * 200) / 1000));

describe('formatTokensForLlm', () => {
  it('每个 token 带下标，停顿超过 0.3 秒换行', () => {
    const out = formatTokensForLlm([tk('我', 0), tk('们', 0.2), tk('好', 1.0)]);
    expect(out).toBe('[0]我[1]们\n[2]好');
  });
});

describe('validateCuts', () => {
  it('丢弃越界与倒序，按起点排序并合并重叠', () => {
    const cuts = validateCuts({ cuts: [
      { from: 4, to: 5, type: 'repeat', reason: '重复' },
      { from: 0, to: 0, type: 'filler', reason: '语气词' },
      { from: 5, to: 3, type: 'slip', reason: '倒序' },
      { from: 7, to: 99, type: 'slip', reason: '越界' },
      { from: 5, to: 6, type: 'repeat', reason: '重叠' },
    ] }, tokens.length);
    expect(cuts).toEqual([
      { from: 0, to: 0, type: 'filler', reason: '语气词' },
      { from: 4, to: 6, type: 'repeat', reason: '重复' },
    ]);
  });

  it('结构不对时报错', () => {
    expect(() => validateCuts({ nope: 1 }, 3)).toThrow('剪辑结果格式不对');
  });
});

describe('detectCuts', () => {
  it('调用 gemini-3.5-flash（low）并返回校验后的剪切', async () => {
    const calls: unknown[] = [];
    const client: LlmClient = { chatJson: async (o) => { calls.push(o); return { cuts: [{ from: 0, to: 0, type: 'filler', reason: '嗯' }, { from: 2, to: 3, type: 'repeat', reason: '去逛' }] }; } };
    const cuts = await detectCuts(client, tokens);
    expect(cuts.map((c) => [c.from, c.to])).toEqual([[0, 0], [2, 3]]);
    expect(calls[0]).toMatchObject({ model: 'google/gemini-3.5-flash', reasoningEffort: 'low' });
  });

  it('剪掉比例超过 35% 时拒绝（防止误删正文）', async () => {
    const client: LlmClient = { chatJson: async () => ({ cuts: [{ from: 0, to: 5, type: 'slip', reason: '' }] }) };
    await expect(detectCuts(client, tokens)).rejects.toThrow('剪掉比例异常');
  });
});
```

Run: `pnpm test tests/llm-cuts.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 `src/cut/llm-cuts.ts`**

```ts
import { z } from 'zod';
import type { Token } from '../asr/types.js';
import type { LlmClient } from '../llm/kexiang.js';

export const CUT_MODEL = 'google/gemini-3.5-flash';
export const MAX_CUT_RATIO = 0.35;
const LINE_BREAK_GAP = 0.3;

export const CUT_TYPES = ['filler', 'repeat', 'slip', 'false_start'] as const;
export type CutType = (typeof CUT_TYPES)[number];
export interface Cut { from: number; to: number; type: CutType; reason: string }

const CutsSchema = z.object({
  cuts: z.array(z.object({ from: z.number().int(), to: z.number().int(), type: z.enum(CUT_TYPES), reason: z.string().default('') })),
});

const SYSTEM_PROMPT = `你是专业口播剪辑师。输入是逐字识别稿，每个字前的 [n] 是它的下标，换行代表说话停顿。
找出应该删掉的部分，只删这四类：
- filler：无意义的语气词和口头禅（嗯、啊、呃、然后呢、就是说 等，出现在句首或句中停顿处时）
- repeat：结巴式重复，只保留最后一次（如「去逛，去逛」删第一个「去逛」）
- slip：说错后自己更正，删掉错误部分和更正提示词（如「六百，不对，六百五十」删「六百，不对，」）
- false_start：说了半句放弃、随后重说的开头
绝不删除有信息量的正文；拿不准就不删。
只输出 JSON：{"cuts":[{"from":起始下标,"to":结束下标(含),"type":"filler|repeat|slip|false_start","reason":"一句话原因"}]}`;

/** 每个 token 前标下标；token 之间间隔超过 0.3 秒视为停顿并换行，帮助模型理解语气 */
export function formatTokensForLlm(tokens: Token[]): string {
  return tokens
    .map((t, i) => {
      const gap = i > 0 ? t.start - tokens[i - 1].end : 0;
      return `${i > 0 && gap > LINE_BREAK_GAP ? '\n' : ''}[${i}]${t.text}`;
    })
    .join('');
}

export function validateCuts(raw: unknown, tokenCount: number): Cut[] {
  const parsed = CutsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`剪辑结果格式不对：${parsed.error.issues[0]?.message ?? ''}`);
  const valid = parsed.data.cuts
    .filter((c) => c.from >= 0 && c.from <= c.to && c.to < tokenCount)
    .sort((a, b) => a.from - b.from);
  return valid.reduce<Cut[]>((acc, c) => {
    const last = acc[acc.length - 1];
    if (last && c.from <= last.to + 1) return [...acc.slice(0, -1), { ...last, to: Math.max(last.to, c.to) }];
    return [...acc, { ...c }];
  }, []);
}

export async function detectCuts(client: LlmClient, tokens: Token[]): Promise<Cut[]> {
  if (tokens.length === 0) return [];
  const raw = await client.chatJson({ model: CUT_MODEL, reasoningEffort: 'low', system: SYSTEM_PROMPT, user: formatTokensForLlm(tokens) });
  const cuts = validateCuts(raw, tokens.length);
  const removed = cuts.reduce((n, c) => n + (c.to - c.from + 1), 0);
  if (removed / tokens.length > MAX_CUT_RATIO) {
    throw new Error(`剪掉比例异常（${Math.round((removed / tokens.length) * 100)}%），已停止以免误删正文`);
  }
  return cuts;
}
```

- [ ] **Step 3: 验证** — `pnpm typecheck && pnpm test` → Expected: 全部通过

- [ ] **Step 4: 提交**
```bash
git add src/cut/llm-cuts.ts tests/llm-cuts.test.ts
git commit -m "feat: 用 Gemini 按字下标判断气口、重复与口误"
```

---

### Task 6: 剪辑方案（纯函数）

**Files:**
- Create: `src/cut/plan.ts`, `tests/plan.test.ts`

**Interfaces:**
- Consumes: `Token`、`SpeechSegment`（Task 3）、`Cut`（Task 5）
- Produces:
  - `TimeRange = { start: number; end: number }`
  - `EditPlan = { keep: TimeRange[]; sourceDurationSec: number; outputDurationSec: number }`
  - `PlanOptions = { pad: number; mergeGap: number; minKeep: number }`、`DEFAULT_PLAN_OPTIONS`
  - `cutsToRanges(cuts: Cut[], tokens: Token[]): TimeRange[]`
  - `buildEditPlan(segments: SpeechSegment[], cutRanges: TimeRange[], sourceDurationSec: number, opts?: PlanOptions): EditPlan`
  - `mapToOutput(t: number, keep: TimeRange[]): number | null`

- [ ] **Step 1: 写失败测试 `tests/plan.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildEditPlan, cutsToRanges, mapToOutput } from '../src/cut/plan.js';

const opts = { pad: 0.1, mergeGap: 0.3, minKeep: 0.25 };

describe('cutsToRanges', () => {
  it('从首 token 的 start 到末 token 的 end', () => {
    const tokens = [{ text: 'a', start: 1, end: 1.2 }, { text: 'b', start: 1.2, end: 1.5 }, { text: 'c', start: 2, end: 2.2 }];
    expect(cutsToRanges([{ from: 0, to: 1, type: 'repeat', reason: '' }], tokens)).toEqual([{ start: 1, end: 1.5 }]);
  });
});

describe('buildEditPlan', () => {
  it('语音段加边距、短间隔合并、长停顿删除', () => {
    const plan = buildEditPlan([{ start: 1, end: 2 }, { start: 2.2, end: 3 }, { start: 5, end: 6 }], [], 8, opts);
    expect(plan.keep).toEqual([{ start: 0.9, end: 3.1 }, { start: 4.9, end: 6.1 }]);
    expect(plan.outputDurationSec).toBeCloseTo(3.4, 5);
    expect(plan.sourceDurationSec).toBe(8);
  });

  it('扣掉剪切区间，并丢弃过短碎片', () => {
    const plan = buildEditPlan([{ start: 0, end: 4 }], [{ start: 1, end: 2 }, { start: 3.9, end: 4.05 }], 4, opts);
    expect(plan.keep).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3.9 }]);
  });

  it('边距不超出片头片尾', () => {
    const plan = buildEditPlan([{ start: 0.05, end: 3.98 }], [], 4, opts);
    expect(plan.keep).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('mapToOutput', () => {
  const keep = [{ start: 1, end: 2 }, { start: 4, end: 6 }];
  it('映射到成片时间', () => {
    expect(mapToOutput(1.5, keep)).toBeCloseTo(0.5);
    expect(mapToOutput(4.5, keep)).toBeCloseTo(1.5);
  });
  it('被剪掉的时刻返回 null', () => {
    expect(mapToOutput(3, keep)).toBeNull();
  });
});
```

Run: `pnpm test tests/plan.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 `src/cut/plan.ts`**

```ts
import type { SpeechSegment, Token } from '../asr/types.js';
import type { Cut } from './llm-cuts.js';

export interface TimeRange { start: number; end: number }
export interface EditPlan { keep: TimeRange[]; sourceDurationSec: number; outputDurationSec: number }
export interface PlanOptions { pad: number; mergeGap: number; minKeep: number }

/** pad：语音段前后各留的气口；mergeGap：小于此间隔的两段直接连上；minKeep：短于此的碎片丢弃 */
export const DEFAULT_PLAN_OPTIONS: PlanOptions = { pad: 0.12, mergeGap: 0.3, minKeep: 0.25 };

const round = (n: number): number => Math.round(n * 1000) / 1000;

export function cutsToRanges(cuts: Cut[], tokens: Token[]): TimeRange[] {
  return cuts.map((c) => ({ start: tokens[c.from].start, end: tokens[c.to].end }));
}

function mergeClose(ranges: TimeRange[], gap: number): TimeRange[] {
  return [...ranges].sort((a, b) => a.start - b.start).reduce<TimeRange[]>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && r.start - last.end < gap) return [...acc.slice(0, -1), { start: last.start, end: Math.max(last.end, r.end) }];
    return [...acc, { ...r }];
  }, []);
}

function subtract(range: TimeRange, cuts: TimeRange[]): TimeRange[] {
  return cuts.reduce<TimeRange[]>((pieces, cut) => pieces.flatMap((p) => {
    if (cut.end <= p.start || cut.start >= p.end) return [p];
    return [{ start: p.start, end: cut.start }, { start: cut.end, end: p.end }].filter((x) => x.end > x.start);
  }), [range]);
}

export function buildEditPlan(segments: SpeechSegment[], cutRanges: TimeRange[], sourceDurationSec: number, opts: PlanOptions = DEFAULT_PLAN_OPTIONS): EditPlan {
  const padded = segments.map((s) => ({ start: Math.max(0, s.start - opts.pad), end: Math.min(sourceDurationSec, s.end + opts.pad) }));
  const keep = mergeClose(padded, opts.mergeGap)
    .flatMap((r) => subtract(r, cutRanges))
    .filter((r) => r.end - r.start >= opts.minKeep)
    .map((r) => ({ start: round(r.start), end: round(r.end) }));
  const outputDurationSec = round(keep.reduce((sum, r) => sum + (r.end - r.start), 0));
  return { keep, sourceDurationSec, outputDurationSec };
}

/** 原片时间 → 成片时间；落在被剪掉的区域返回 null */
export function mapToOutput(t: number, keep: TimeRange[]): number | null {
  let offset = 0;
  for (const r of keep) {
    if (t >= r.start && t <= r.end) return round(offset + (t - r.start));
    offset += r.end - r.start;
  }
  return null;
}
```

- [ ] **Step 3: 验证** — `pnpm typecheck && pnpm test` → Expected: 全部通过

- [ ] **Step 4: 提交**
```bash
git add src/cut/plan.ts tests/plan.test.ts
git commit -m "feat: 由语音段与剪切生成保留区间及时间映射"
```

---

### Task 7: ffmpeg 剪切渲染

**Files:**
- Create: `src/cut/render-cut.ts`, `tests/render-cut.test.ts`

**Interfaces:**
- Consumes: `TimeRange`（Task 6）、`run`、`probe`（Task 2）
- Produces:
  - `buildCutFilter(keep: TimeRange[], fadeSec?: number): string`
  - `renderCut(input: string, keep: TimeRange[], output: string, cfg: AppConfig): Promise<void>`

- [ ] **Step 1: 写失败测试 `tests/render-cut.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildCutFilter, renderCut } from '../src/cut/render-cut.js';
import { probe } from '../src/media/probe.js';

describe('buildCutFilter', () => {
  it('每段 trim/atrim + 20ms 淡入淡出，最后 concat', () => {
    const f = buildCutFilter([{ start: 0, end: 1 }, { start: 2.5, end: 3 }]);
    expect(f).toContain('[0:v]trim=start=0:end=1,setpts=PTS-STARTPTS[v0]');
    expect(f).toContain('[0:a]atrim=start=2.5:end=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.02,afade=t=out:st=0.48:d=0.02[a1]');
    expect(f.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]')).toBe(true);
  });

  it('没有保留区间时报错', () => {
    expect(() => buildCutFilter([])).toThrow('没有可保留的片段');
  });
});

describe('renderCut（ffmpeg）', () => {
  it('输出时长等于保留区间之和', async () => {
    const cfg = loadConfig({});
    const out = join(mkdtempSync(join(tmpdir(), 'mz-')), 'cut.mp4');
    await renderCut(join(import.meta.dirname, 'fixtures', 'talk.mp4'), [{ start: 0, end: 1 }, { start: 2, end: 3 }], out, cfg);
    const info = await probe(out, cfg);
    expect(info.durationSec).toBeGreaterThan(1.9);
    expect(info.durationSec).toBeLessThan(2.15);
    expect(info.fps).toBe(30);
  });
});
```

Run: `pnpm test tests/render-cut.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 `src/cut/render-cut.ts`**

```ts
import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';
import type { TimeRange } from './plan.js';

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** 每段视频 trim、音频 atrim 并做极短淡入淡出（防止剪切点爆音），最后按顺序 concat */
export function buildCutFilter(keep: TimeRange[], fadeSec = 0.02): string {
  if (keep.length === 0) throw new Error('没有可保留的片段，无法渲染');
  const parts = keep.map((r, i) => {
    const dur = r.end - r.start;
    const video = `[0:v]trim=start=${fmt(r.start)}:end=${fmt(r.end)},setpts=PTS-STARTPTS[v${i}]`;
    const audio = `[0:a]atrim=start=${fmt(r.start)}:end=${fmt(r.end)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fmt(dur - fadeSec)}:d=${fadeSec}[a${i}]`;
    return `${video};${audio}`;
  });
  const inputs = keep.map((_, i) => `[v${i}][a${i}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${keep.length}:v=1:a=1[outv][outa]`;
}

export async function renderCut(input: string, keep: TimeRange[], output: string, cfg: AppConfig): Promise<void> {
  await run(cfg.ffmpeg, [
    '-v', 'error', '-y', '-i', input,
    '-filter_complex', buildCutFilter(keep),
    '-map', '[outv]', '-map', '[outa]',
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', output,
  ]);
}
```

- [ ] **Step 3: 验证** — `pnpm typecheck && pnpm test` → Expected: 全部通过

- [ ] **Step 4: 提交**
```bash
git add src/cut/render-cut.ts tests/render-cut.test.ts
git commit -m "feat: ffmpeg 按保留区间剪切并消除剪切点爆音"
```

---

### Task 8: 字幕分行、校对与 ASS

**Files:**
- Create: `src/captions/lines.ts`, `src/captions/ass.ts`, `tests/captions.test.ts`

**Interfaces:**
- Consumes: `Token`、`Cut`、`TimeRange`、`mapToOutput`、`LlmClient`
- Produces:
  - `CaptionLine = { from: number; to: number; text: string }`（原始 token 下标，闭区间）
  - `TimedCaption = { start: number; end: number; text: string }`（成片时间）
  - `keptIndices(tokenCount: number, cuts: Cut[]): number[]`
  - `fallbackLines(tokens: Token[], kept: number[], maxChars?: number): CaptionLine[]`
  - `validateLines(raw: unknown, kept: number[]): CaptionLine[] | null`
  - `polishCaptions(client: LlmClient, tokens: Token[], kept: number[]): Promise<CaptionLine[]>`
  - `timeCaptions(lines: CaptionLine[], tokens: Token[], keep: TimeRange[]): TimedCaption[]`
  - `toAss(captions: TimedCaption[], video: { width: number; height: number }): string`
  - `MAX_LINE_CHARS = 14`

- [ ] **Step 1: 写失败测试 `tests/captions.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { Token } from '../src/asr/types.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { fallbackLines, keptIndices, polishCaptions, timeCaptions, validateLines } from '../src/captions/lines.js';
import { toAss } from '../src/captions/ass.js';

// 用毫秒整数计算再换算成秒，避免 0.4 + 0.2 = 0.6000000000000001 这类浮点误差
const toks = (s: string, gapAt = -1): Token[] => [...s].map((ch, i) => {
  const startMs = i * 200 + (gapAt >= 0 && i >= gapAt ? 1000 : 0);
  return { text: ch, start: startMs / 1000, end: (startMs + 200) / 1000 };
});

describe('keptIndices', () => {
  it('去掉被剪的下标', () => {
    expect(keptIndices(6, [{ from: 1, to: 2, type: 'repeat', reason: '' }])).toEqual([0, 3, 4, 5]);
  });
});

describe('fallbackLines', () => {
  it('按停顿和字数上限分行', () => {
    const tokens = toks('我平时经常逛项目今天看到一个', 8);
    const lines = fallbackLines(tokens, tokens.map((_, i) => i), 6);
    expect(lines.map((l) => l.text)).toEqual(['我平时经常逛', '项目', '今天看到一个']);
    expect(lines[0]).toMatchObject({ from: 0, to: 5 });
  });
});

describe('validateLines', () => {
  const kept = [0, 1, 2, 3, 4, 5];
  it('合法时原样返回', () => {
    const raw = { lines: [{ from: 0, to: 2, text: 'GitHub' }, { from: 3, to: 5, text: '650 条' }] };
    expect(validateLines(raw, kept)).toEqual(raw.lines);
  });
  it('乱序、越界、超长、引用被剪下标时返回 null', () => {
    expect(validateLines({ lines: [{ from: 3, to: 5, text: 'a' }, { from: 0, to: 2, text: 'b' }] }, kept)).toBeNull();
    expect(validateLines({ lines: [{ from: 0, to: 9, text: 'a' }] }, kept)).toBeNull();
    expect(validateLines({ lines: [{ from: 0, to: 5, text: '一二三四五六七八九十一二三四五六七' }] }, kept)).toBeNull();
    expect(validateLines({ lines: [{ from: 0, to: 1, text: 'a' }] }, [0, 2])).toBeNull(); // 下标 1 已被剪掉
  });
});

describe('polishCaptions', () => {
  it('模型结果不合法时退回兜底分行', async () => {
    const tokens = toks('你好世界');
    const client: LlmClient = { chatJson: async () => ({ lines: [{ from: 9, to: 9, text: 'x' }] }) };
    const lines = await polishCaptions(client, tokens, [0, 1, 2, 3]);
    expect(lines.map((l) => l.text)).toEqual(['你好世界']);
  });
});

describe('timeCaptions', () => {
  it('映射到成片时间，跳过被剪掉的行，并消除重叠', () => {
    const tokens = toks('一二三四五六');
    const keep = [{ start: 0, end: 0.6 }, { start: 0.8, end: 1.2 }];
    const out = timeCaptions([{ from: 0, to: 2, text: '一二三' }, { from: 4, to: 5, text: '五六' }], tokens, keep);
    expect(out).toEqual([{ start: 0, end: 0.6, text: '一二三' }, { start: 0.6, end: 1, text: '五六' }]);
  });
});

describe('toAss', () => {
  it('生成带样式与时间的 ASS，并转义花括号', () => {
    const ass = toAss([{ start: 1.5, end: 3.25, text: '怎么{少}花冤枉钱' }], { width: 1080, height: 1920 });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,怎么\\{少\\}花冤枉钱');
  });
});
```

Run: `pnpm test tests/captions.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 `src/captions/lines.ts`**

```ts
import { z } from 'zod';
import type { Token } from '../asr/types.js';
import type { Cut } from '../cut/llm-cuts.js';
import { mapToOutput, type TimeRange } from '../cut/plan.js';
import type { LlmClient } from '../llm/kexiang.js';

export const MAX_LINE_CHARS = 14;
const MAX_DISPLAY_CHARS = 16;
const BREAK_GAP = 0.35;
const MIN_CAPTION_SEC = 0.4;

export interface CaptionLine { from: number; to: number; text: string }
export interface TimedCaption { start: number; end: number; text: string }

const LinesSchema = z.object({ lines: z.array(z.object({ from: z.number().int(), to: z.number().int(), text: z.string() })) });

const SYSTEM_PROMPT = `你是短视频字幕编辑。输入是剪辑后保留的逐字识别稿，[n] 是下标。
把它分成字幕行：每行一个自然语义单位，不超过 ${MAX_LINE_CHARS} 个汉字；行与行按顺序覆盖全部下标，不重叠、不遗漏。
每行的 text 是校对后的显示文字：改正同音错字（如 geth→GitHub、疯人→帮人），英文专名用正确大小写，
数量与金额用短视频常见写法（六百五十条→650 条，三点五万→3.5 万；但口语化金额如「五毛一」保持原样），不要标点。
只输出 JSON：{"lines":[{"from":起始下标,"to":结束下标(含),"text":"显示文字"}]}`;

export function keptIndices(tokenCount: number, cuts: Cut[]): number[] {
  const removed = new Set(cuts.flatMap((c) => Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from + k)));
  return Array.from({ length: tokenCount }, (_, i) => i).filter((i) => !removed.has(i));
}

/** 不依赖模型的兜底分行：遇到停顿或达到字数上限就换行 */
export function fallbackLines(tokens: Token[], kept: number[], maxChars = MAX_LINE_CHARS): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let current: number[] = [];
  const flush = (): void => {
    if (current.length) lines.push({ from: current[0], to: current[current.length - 1], text: current.map((i) => tokens[i].text).join('') });
    current = [];
  };
  kept.forEach((idx, k) => {
    const prev = k > 0 ? tokens[kept[k - 1]] : undefined;
    const length = current.reduce((n, i) => n + tokens[i].text.length, 0);
    if (prev && (tokens[idx].start - prev.end > BREAK_GAP || length + tokens[idx].text.length > maxChars)) flush();
    current.push(idx);
  });
  flush();
  return lines;
}

/** 校验模型分行：顺序递增、首尾都是保留下标、显示字数不超限；任一不满足返回 null */
export function validateLines(raw: unknown, kept: number[]): CaptionLine[] | null {
  const parsed = LinesSchema.safeParse(raw);
  if (!parsed.success || parsed.data.lines.length === 0) return null;
  const keptSet = new Set(kept);
  const lines = parsed.data.lines;
  const ok = lines.every((l, i) => keptSet.has(l.from) && keptSet.has(l.to) && l.from <= l.to
    && l.text.trim().length > 0 && [...l.text].length <= MAX_DISPLAY_CHARS && (i === 0 || l.from > lines[i - 1].to));
  return ok ? lines.map((l) => ({ ...l, text: l.text.trim() })) : null;
}

export async function polishCaptions(client: LlmClient, tokens: Token[], kept: number[]): Promise<CaptionLine[]> {
  if (kept.length === 0) return [];
  const user = kept.map((i) => `[${i}]${tokens[i].text}`).join('');
  try {
    const raw = await client.chatJson({ model: 'google/gemini-3.5-flash', reasoningEffort: 'low', system: SYSTEM_PROMPT, user });
    return validateLines(raw, kept) ?? fallbackLines(tokens, kept);
  } catch {
    return fallbackLines(tokens, kept);
  }
}

export function timeCaptions(lines: CaptionLine[], tokens: Token[], keep: TimeRange[]): TimedCaption[] {
  const timed = lines.flatMap((l) => {
    const start = mapToOutput(tokens[l.from].start, keep);
    const end = mapToOutput(tokens[l.to].end, keep);
    if (start === null || end === null) return [];
    return [{ start, end: Math.max(end, start + MIN_CAPTION_SEC), text: l.text }];
  });
  return timed.map((c, i) => {
    const next = timed[i + 1];
    return next && c.end > next.start ? { ...c, end: next.start } : c;
  });
}
```

- [ ] **Step 3: 实现 `src/captions/ass.ts`**

```ts
import type { TimedCaption } from './lines.js';

/** P1 默认样式「刀锋」：白字黑描边，位于画面下方约 22% 处；P3 再扩展为 6–8 套预设 */
const FONT = 'PingFang SC';

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const escapeText = (t: string): string => t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');

export function toAss(captions: TimedCaption[], video: { width: number; height: number }): string {
  const fontSize = Math.round(video.height * 0.034);
  const outline = Math.max(2, Math.round(fontSize * 0.09));
  const marginV = Math.round(video.height * 0.22);
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${video.width}`, `PlayResY: ${video.height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${FONT},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,40,40,${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = captions.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${escapeText(c.text)}`);
  return [...header, ...events, ''].join('\n');
}
```

- [ ] **Step 4: 验证** — `pnpm typecheck && pnpm test` → Expected: 全部通过

- [ ] **Step 5: 提交**
```bash
git add src/captions/lines.ts src/captions/ass.ts tests/captions.test.ts
git commit -m "feat: 字幕分行校对（Gemini + 兜底）与 ASS 生成"
```

---

### Task 9: 字幕烧录、完整管线与命令行

**Files:**
- Create: `src/captions/burn.ts`, `src/pipeline/run.ts`, `src/cli.ts`, `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: 以上全部模块
- Produces:
  - `escapeFilterPath(p: string): string`、`burnSubtitles(input: string, assPath: string, output: string, cfg: AppConfig): Promise<void>`
  - `PipelineStep = 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'captions' | 'burn' | 'done'`
  - `ProgressEvent = { step: PipelineStep; message: string }`
  - `runPipeline(args: { input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; onProgress?: (e: ProgressEvent) => void }): Promise<PipelineResult>`
  - `PipelineResult = { output: string; projectPath: string; cuts: Cut[]; plan: EditPlan; captions: TimedCaption[] }`
  - `project.json` 结构：`{ version: 1, input, media: MediaInfo, transcript: Transcript, cuts: Cut[], plan: EditPlan, captions: TimedCaption[], createdAt: string }`

- [ ] **Step 1: 写失败测试 `tests/pipeline.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeFilterPath } from '../src/captions/burn.js';
import { loadConfig } from '../src/config.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { probe } from '../src/media/probe.js';
import { runPipeline } from '../src/pipeline/run.js';
import { hasModels } from './helpers/models.js';

describe('escapeFilterPath', () => {
  it('转义 ffmpeg 滤镜里的冒号、反斜杠和单引号', () => {
    expect(escapeFilterPath("C:\\a b\\it's.ass")).toBe("C\\:\\\\a b\\\\it\\'s.ass");
  });
});

describe.skipIf(!hasModels())('runPipeline（需要本地模型）', () => {
  it('样片：删掉停顿与「嗯」，输出成片、ASS 和 project.json', async () => {
    const cfg = loadConfig({});
    const work = mkdtempSync(join(tmpdir(), 'mz-'));
    // 假模型：剪掉文字为「嗯」的 token；字幕返回非法结果以走兜底分行
    const llm: LlmClient = {
      chatJson: async (o) => {
        if (o.system.includes('剪辑师')) {
          const idx = [...o.user.matchAll(/\[(\d+)\]嗯/g)].map((m) => Number(m[1]));
          return { cuts: idx.map((i) => ({ from: i, to: i, type: 'filler', reason: '语气词' })) };
        }
        return { lines: [] };
      },
    };
    const steps: string[] = [];
    const input = join(import.meta.dirname, 'fixtures', 'talk.mp4');
    const res = await runPipeline({ input, workDir: work, output: join(work, 'out.mp4'), cfg, llm, onProgress: (e) => steps.push(e.step) });
    const src = await probe(input, cfg);
    const out = await probe(res.output, cfg);
    expect(out.durationSec).toBeLessThan(src.durationSec - 1.0);
    expect(steps).toEqual(['probe', 'audio', 'asr', 'cuts', 'plan', 'render', 'captions', 'burn', 'done']);
    expect(readFileSync(join(work, 'captions.ass'), 'utf8')).toContain('高性价比');
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8'));
    expect(project.version).toBe(1);
    expect(project.transcript.tokens.length).toBeGreaterThan(20);
    expect(existsSync(join(work, 'cut.mp4'))).toBe(true);
  });
});
```

Run: `pnpm test tests/pipeline.test.ts` → Expected: FAIL

- [ ] **Step 2: 实现 `src/captions/burn.ts`**

```ts
import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';

/** ffmpeg 滤镜参数里 \ : ' 都有特殊含义，需要转义 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export async function burnSubtitles(input: string, assPath: string, output: string, cfg: AppConfig): Promise<void> {
  await run(cfg.ffmpeg, [
    '-v', 'error', '-y', '-i', input,
    '-vf', `ass=${escapeFilterPath(assPath)}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', output,
  ]);
}
```

- [ ] **Step 3: 实现 `src/pipeline/run.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { transcribeWav } from '../asr/local-asr.js';
import { burnSubtitles } from '../captions/burn.js';
import { toAss } from '../captions/ass.js';
import { keptIndices, polishCaptions, timeCaptions, type TimedCaption } from '../captions/lines.js';
import { detectCuts, type Cut } from '../cut/llm-cuts.js';
import { buildEditPlan, cutsToRanges, type EditPlan } from '../cut/plan.js';
import { renderCut } from '../cut/render-cut.js';
import type { LlmClient } from '../llm/kexiang.js';
import { extractWav16k } from '../media/extract-audio.js';
import { probe } from '../media/probe.js';

export type PipelineStep = 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'captions' | 'burn' | 'done';
export interface ProgressEvent { step: PipelineStep; message: string }
export interface PipelineArgs { input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; onProgress?: (e: ProgressEvent) => void }
export interface PipelineResult { output: string; projectPath: string; cuts: Cut[]; plan: EditPlan; captions: TimedCaption[] }

const fmtSec = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** 全流程：探测 → 抽音频 → 识别 → 剪口误 → 剪辑方案 → 剪切 → 字幕 → 烧录；每步回调一次，供 P5 剪辑直播使用 */
export async function runPipeline(args: PipelineArgs): Promise<PipelineResult> {
  const { input, workDir, output, cfg, llm } = args;
  const report = (step: PipelineStep, message: string): void => args.onProgress?.({ step, message });
  mkdirSync(workDir, { recursive: true });

  const media = await probe(input, cfg);
  if (!media.hasAudio) throw new Error('输入视频没有音轨，无法识别口播');
  report('probe', `${media.width}×${media.height} · ${fmtSec(media.durationSec)}`);

  const wav = join(workDir, 'audio16k.wav');
  await extractWav16k(input, wav, cfg);
  report('audio', '已抽取 16kHz 音频');

  const transcript = transcribeWav(wav, cfg.modelsDir);
  report('asr', `识别 ${transcript.tokens.length} 字 · ${transcript.segments.length} 个语音段`);

  const cuts = await detectCuts(llm, transcript.tokens);
  report('cuts', `标记 ${cuts.length} 处气口/重复/口误`);

  const plan = buildEditPlan(transcript.segments, cutsToRanges(cuts, transcript.tokens), media.durationSec);
  report('plan', `原片 ${fmtSec(media.durationSec)} → 成片 ${fmtSec(plan.outputDurationSec)}`);

  const cutPath = join(workDir, 'cut.mp4');
  await renderCut(input, plan.keep, cutPath, cfg);
  report('render', '剪切完成');

  const lines = await polishCaptions(llm, transcript.tokens, keptIndices(transcript.tokens.length, cuts));
  const captions = timeCaptions(lines, transcript.tokens, plan.keep);
  const assPath = join(workDir, 'captions.ass');
  writeFileSync(assPath, toAss(captions, media));
  report('captions', `${captions.length} 行字幕`);

  await burnSubtitles(cutPath, assPath, output, cfg);
  report('burn', '字幕已烧录');

  const projectPath = join(workDir, 'project.json');
  writeFileSync(projectPath, JSON.stringify({ version: 1, input, media, transcript, cuts, plan, captions, createdAt: new Date().toISOString() }, null, 2));
  report('done', output);
  return { output, projectPath, cuts, plan, captions };
}
```

- [ ] **Step 4: 实现 `src/cli.ts`**

```ts
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { KexiangClient } from './llm/kexiang.js';
import { runPipeline } from './pipeline/run.js';

const USAGE = '用法：pnpm mingzhi edit <口播视频> [-o 输出.mp4] [--work 工作目录]';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { output: { type: 'string', short: 'o' }, work: { type: 'string' } } });
  const [command, inputArg] = positionals;
  if (command !== 'edit' || !inputArg) throw new Error(USAGE);
  const input = resolve(inputArg);
  const name = basename(input, extname(input));
  const workDir = resolve(values.work ?? join('work', name));
  const output = resolve(values.output ?? join(workDir, `${name}_精剪.mp4`));
  const cfg = loadConfig();
  const llm = new KexiangClient(cfg.kexiangKey ?? '');
  const started = Date.now();
  const res = await runPipeline({ input, workDir, output, cfg, llm, onProgress: (e) => console.log(`[${e.step}] ${e.message}`) });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n完成：删除 ${res.cuts.length} 处 · 成片 ${res.plan.outputDurationSec.toFixed(1)} 秒 · 用时 ${secs} 秒\n${res.output}`);
}

main().catch((err: Error) => {
  console.error(`出错了：${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 5: 验证** — `pnpm typecheck && pnpm test` → Expected: 全部通过（有模型时 runPipeline 实跑）

- [ ] **Step 6: 提交**
```bash
git add src/captions/burn.ts src/pipeline src/cli.ts tests/pipeline.test.ts
git commit -m "feat: 精剪全流程管线与命令行入口"
```

---

### Task 10: 真实口播验收与 README

**Files:**
- Create: `README.md`、`docs/acceptance/p1.md`

- [ ] **Step 1: 用真实可想 key 跑样片**

Run:
```bash
cd /Users/crawford/workspace/mingzhi
MINGZHI_KX_KEY=<你的可想 key> pnpm mingzhi edit tests/fixtures/talk.mp4 --work work/fixture
```
Expected：控制台依次打印 9 个步骤；成片里「然后呢，嗯，」「去逛，」第一次、「一个，」第一次、「六百，不对，」被删；1.5 秒停顿被压到约 0.3 秒；字幕里出现「GitHub」「650 条」。

- [ ] **Step 2: 用一条真实未剪的口播跑**（向用户要一条 2–4 分钟原片；没有时用 `~/workspace/小马学长AI/第2期/成片_A_原背景.mp4` 验证不误删）

Run: `MINGZHI_KX_KEY=<key> pnpm mingzhi edit <原片.mp4> --work work/real`
检查并写入 `docs/acceptance/p1.md`：
- 原片时长 → 成片时长、删除处数、总用时
- 抽查 10 处剪切点：是否只删了废话、有没有爆音、有没有吞字
- 字幕：错字数、分行是否自然、数字写法
- 可想花费（看可想控制台）
- 已成片输入（成片_A）的剪切比例应 < 5%，否则说明误删，回到 Task 5 调提示词

- [ ] **Step 3: 写 README.md**（中英双语简版：项目简介、环境要求 Node 22 + ffmpeg、`pnpm install && pnpm fetch-models`、`MINGZHI_KX_KEY` 去 kexiangai.com 注册获取、`pnpm mingzhi edit`、MIT 许可证、Remotion 公司授权提示放到 P3 再加）

- [ ] **Step 4: 提交**
```bash
git add README.md docs/acceptance/p1.md
git commit -m "docs: P1 验收记录与 README"
```

---

## 自查记录
- Spec 覆盖：DECISIONS「出片管线」第 1 步（本地 ASR → Gemini 判断 → ffmpeg 剪）与烧录字幕 → Task 3/5/6/7/8/9；字幕样式预设、换背景、分镜、B-roll、自检、花费控制、工作台、启动器分别在 P2–P6，不属于本计划
- 类型一致性：`Token/SpeechSegment/Transcript`（T3）→ `Cut`（T5）→ `TimeRange/EditPlan/mapToOutput`（T6）→ `CaptionLine/TimedCaption`（T8）→ `runPipeline`（T9），名称与签名逐一核对一致
- 已知风险：SenseVoice 可能把很轻的「嗯」识别丢失 → Task 10 用真实原片验收；若漏检严重，备选为同目录下载 `sherpa-onnx-paraformer-zh-2023-09-14`（同样有时间戳）对比
