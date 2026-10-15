# P3c 配乐音效、字幕样式与封面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 成片带上自动挑选、随人声压低的背景音乐和卡片音效，响度统一到 -14 LUFS；字幕有 6 套样式（字体打包本地）；同时出 4:3 与 3:4 两张封面。

**Architecture:** 素材（19 首 CC0 配乐、6 款 OFL 字体）由 `scripts/fetch-assets.mjs` 下载到 `~/.mingzhi/assets`，清单（含 sha256）入库；8 个 CC0 音效直接入库。分镜模型顺带给出配乐情绪；Node 侧用纯函数算出背景音乐的音量包络（说话时压低、停顿时抬起）与音效触发点，连同所需素材复制进工作目录，交给 Remotion 用 `<Audio>` 合成；渲染后 ffmpeg 两遍 loudnorm 统一响度；封面用 Remotion `renderStill` 出图。

**Tech Stack:** Remotion 4.0.531（`<Audio>`、`<Sequence>`、`@remotion/fonts@4.0.531`）、ffmpeg loudnorm、zod、vitest

**Spec:** `docs/DECISIONS.md`（本地能力「背景音乐：内置 ~20 首免版权曲库（按情绪分类），Gemini 选曲，本地人声压低（ducking）」「音效：内置 CC0 音效包（转场 whoosh、点击、数字跳动）」；出片管线第 5 条「烧录字幕（6–8 套样式预设，字体打包本地：思源黑体/思源宋体/得意黑/霞鹜文楷/站酷快乐体/站酷庆科黄油体 等）」、第 6 条「封面 4:3 + 3:4」、第 7 条「-14 LUFS」）。依赖 P3a、P3b 计划完成。

## Global Constraints

- 配乐来源（2026-10-15 实测）：FreePD 已关站；改用 HoliznaCC0 在 OpenGameArt 的 CC0 合集（页面标注 CC0 1.0，作者声明 public domain）：
  - `https://opengameart.org/sites/default/files/chill_beats.zip` sha256 `53ce04d6c124843235ccfbea94be3f8c6afb3cfd3c6924badc124a4ec0d49f37`
  - `https://opengameart.org/sites/default/files/happy_lo-fi_lofi_collection.zip` sha256 `7d36a9172a030d5b2e9ec7df622095e468877cdd35d92904004bb8c13266f80b`
  - `https://opengameart.org/sites/default/files/happy_electronic.zip` sha256 `b0c799be8b60620d01b8862d37103e58f6d30d33285141e9b645622c1d758449`
  - 20 首经 Gemini 听辨打分（作为口播背景乐适合度 7–9/10），剔除含人声采样的《City In The Rearview》，保留 19 首（见 Task 1 清单）
- 音效：Kenney Interface Sounds（CC0，`https://raw.githubusercontent.com/Calinou/kenney-interface-sounds/master/addons/kenney_interface_sounds/<名字>.wav`），入库 8 个：`click_002 toggle_002 tick_002 maximize_006 minimize_003 scroll_002 confirmation_002 glass_001` 与 `LICENSE.txt`
- 字体（OFL，下载地址实测可用）：
  - 思源黑体 `https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf`（17.8MB，可变字重）
  - 思源宋体 `https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf`（25.1MB）
  - 站酷快乐体 `https://raw.githubusercontent.com/google/fonts/main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf`（1.5MB）
  - 站酷庆科黄油体 `https://raw.githubusercontent.com/google/fonts/main/ofl/zcoolqingkehuangyou/ZCOOLQingKeHuangYou-Regular.ttf`（8.3MB）
  - 霞鹜文楷 `https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Medium.ttf`（25.4MB）
  - 得意黑 `https://github.com/atelier-anchor/smiley-sans/releases/download/v2.0.1/smiley-sans-v2.0.1.zip`（5.8MB，取其中 `SmileySans-Oblique.ttf`）
  - sha256 由 Task 1 实现者下载后计算写入清单（清单是校验依据，之后的下载都要校验）
- 响度：成片 -14 LUFS（integrated），true peak ≤ -1.5 dBTP，LRA 11；用 ffmpeg `loudnorm` 两遍法；视频流直接拷贝
- 人声压低：人声期间背景乐 -22 dB（相对原曲），停顿超过 0.8 秒时在 0.3 秒内抬到 -14 dB，开头 0.5 秒淡入、结尾 1.5 秒淡出
- 成片动画与音频全部帧驱动（Remotion）；音效默认音量 0.35
- 素材目录 `<dataDir>/assets`（`dataDir` 默认 `~/.mingzhi`，`MINGZHI_DATA_DIR` 可覆盖）；渲染时把用到的素材复制进工作目录（Remotion 的 publicDir）
- Node 内置 fetch 默认不走系统代理（实测）；下载脚本注释提示 `NODE_USE_ENV_PROXY=1`
- 代码注释、报错、commit 用中文；commit `<type>: <描述>`，无署名行；文件 < 400 行；函数 < 50 行；不可变数据

---

### Task 1: 素材清单、下载脚本与入库音效

**Files:**
- Create: `assets/music.json`、`assets/fonts.json`、`assets/sfx/*.wav`（8 个）、`assets/sfx/LICENSE.txt`、`scripts/fetch-assets.mjs`、`src/assets/catalog.ts`
- Modify: `package.json`（脚本 `"fetch-assets": "node scripts/fetch-assets.mjs"`）
- Test: `tests/assets.test.ts`

**Interfaces:**
- Produces（`src/assets/catalog.ts`）：
  - `export type Mood = 'chill' | 'tech' | 'upbeat'`
  - `export interface Track { id: string; title: string; zip: string; entry: string; mood: Mood; energy: number; durationSec: number }`
  - `export interface FontAsset { id: string; family: string; url: string; file: string; sha256: string; zipEntry?: string }`
  - `export const SFX = { enter: 'maximize_006.wav', exit: 'minimize_003.wav', click: 'click_002.wav', toggle: 'toggle_002.wav', tick: 'tick_002.wav', load: 'scroll_002.wav', confirm: 'confirmation_002.wav', sparkle: 'glass_001.wav' } as const`、`export type SfxId = keyof typeof SFX`
  - `export function loadTracks(): Track[]`、`export function loadFonts(): FontAsset[]`（读入库 JSON，用 zod 校验）
  - `export function assetsDir(cfg: AppConfig): string`（`join(cfg.dataDir, 'assets')`）
  - `export function trackPath(cfg: AppConfig, t: Track): string`（`assets/music/<id>.mp3`）、`export function fontPath(cfg: AppConfig, f: FontAsset): string`（`assets/fonts/<file>`）、`export function sfxPath(id: SfxId): string`（仓库内 `assets/sfx/…`）
  - `export function musicReady(cfg: AppConfig): boolean`、`export function fontsReady(cfg: AppConfig): boolean`

**音乐清单 `assets/music.json`**（`zip` 用简称：`chill`=chill_beats.zip，`happy`=happy_lo-fi_lofi_collection.zip，`electronic`=happy_electronic.zip；`entry` 是压缩包内路径；`durationSec` 已实测）：

| id | title | zip | entry | mood | energy | durationSec |
|---|---|---|---|---|---|---|
| families | Families | chill | `Chill Beats/03 HoliznaCC0 - Families.mp3` | tech | 2 | 144 |
| opinions | Opinions | chill | `Chill Beats/05 HoliznaCC0 - Opinions.mp3` | chill | 2 | 168 |
| old-age | Old Age | chill | `Chill Beats/06 HoliznaCC0 - Old Age.mp3` | tech | 2 | 214 |
| dream-pop | Dream Pop | chill | `Chill Beats/08 HoliznaCC0 - Dream Pop.mp3` | tech | 2 | 242 |
| autumn | Autumn | chill | `Chill Beats/28 HoliznaCC0 - Autumn.mp3` | tech | 2 | 170 |
| poor-but-happy | Poor, But Happy | happy | `Happy Lo-Fi (Lofi Collection)/01 HoliznaCC0 - Poor, But Happy.mp3` | chill | 2 | 128 |
| blue-skies | Blue Skies | happy | `Happy Lo-Fi (Lofi Collection)/03 HoliznaCC0 - Blue Skies.mp3.mp3` | chill | 2 | 176 |
| letting-go | Letting Go Of The Past | happy | `Happy Lo-Fi (Lofi Collection)/16 HoliznaCC0 - Letting Go Of The Past.mp3` | tech | 2 | 180 |
| puppy-love | Puppy Love | happy | `Happy Lo-Fi (Lofi Collection)/19 HoliznaCC0 - Puppy Love.mp3` | upbeat | 3 | 150 |
| clouds | Clouds | happy | `Happy Lo-Fi (Lofi Collection)/21 HoliznaCC0 - Clouds.mp3` | tech | 2 | 230 |
| a-little-off | Happy, but a little off | happy | `Happy Lo-Fi (Lofi Collection)/22 HoliznaCC0 - Happy, but a little off.mp3` | chill | 2 | 117 |
| new-shoes | New Shoes | happy | `Happy Lo-Fi (Lofi Collection)/26 HoliznaCC0 - New Shoes.mp3` | tech | 2 | 156 |
| back-in-the-80s | Back In The 80s | electronic | `Happy Electronic/03 HoliznaCC0 - Back In The 80s.mp3` | upbeat | 3 | 240 |
| earth | Earth | electronic | `Happy Electronic/03 HoliznaCC0 - Earth.mp3` | upbeat | 3 | 200 |
| small-town-on-pluto | A Small Town On Pluto | electronic | `Happy Electronic/04 HoliznaCC0 - A Small Town On Pluto.mp3` | upbeat | 3 | 232 |
| happy-dance | Happy Dance | electronic | `Happy Electronic/06 HoliznaCC0 - Happy Dance.mp3` | upbeat | 3 | 156 |
| earth-people | transcendental earth people | electronic | `Happy Electronic/08 HoliznaCC0 - transcendental earth people.mp3` | upbeat | 3 | 153 |
| bouncing | Bouncing | electronic | `Happy Electronic/10 HoliznaCC0 - Bouncing.mp3` | upbeat | 3 | 88 |
| love-love-love | Love Love Love | electronic | `Happy Electronic/11 HoliznaCC0 - Love Love Love.mp3` | upbeat | 3 | 175 |

JSON 结构：`{ "license": "CC0 1.0（HoliznaCC0，OpenGameArt）", "zips": { "chill": { "url": …, "sha256": … }, … }, "tracks": [ … ] }`。

**`scripts/fetch-assets.mjs`**：下载三个音乐压缩包到 `<assets>/tmp/`（`.part` 再改名，sha256 校验，不符删除报错）→ 用系统 `unzip -p` 取出清单里的 entry，ffmpeg 转码为 `music/<id>.mp3`（`-ac 2 -ar 44100 -b:a 128k`）→ 删除压缩包；字体逐个下载到 `fonts/`（得意黑从 zip 取 `zipEntry`），sha256 校验；已存在且大小大于 0 的跳过。首次运行若清单里某个字体的 `sha256` 为空字符串，打印计算出的值并以非 0 退出，提示把值写回清单（Task 1 实现者用这一步得到值并写进 `assets/fonts.json`，最终清单不允许空 sha256）。

- [ ] **Step 1**：用 curl 下载 8 个音效与 LICENSE.txt 到 `assets/sfx/`；写好两份清单
- [ ] **Step 2: 测试**（`tests/assets.test.ts`）：两份清单通过 zod 校验；19 首、三种情绪都至少 4 首；`SFX` 里每个文件在 `assets/sfx/` 存在；字体 6 款、sha256 均为 64 位十六进制；`musicReady`/`fontsReady` 对空数据目录返回 false
- [ ] **Step 3: Run** → FAIL；**Step 4**：实现 `catalog.ts` 与下载脚本；运行 `pnpm fetch-assets`（若 Node fetch 因代理失败，用 `NODE_USE_ENV_PROXY=1 pnpm fetch-assets`），确认 `~/.mingzhi/assets/music` 有 19 个 mp3、`fonts` 有 6 个 ttf
- [ ] **Step 5: Run** `pnpm vitest run tests/assets.test.ts && pnpm typecheck` → PASS
- [ ] **Step 6: Commit** `git commit -m "feat: 配乐、字体素材清单与下载脚本，入库 CC0 音效"`

---

### Task 2: 音量包络、音效触发点与选曲（纯函数）

**Files:**
- Create: `src/audio/plan.ts`
- Test: `tests/audio-plan.test.ts`

**Interfaces:**
- Consumes: `Shot`（P3a）、`TimedCaption`、`Track`、`Mood`、`SfxId`
- Produces:
  - `export interface VolumeKey { sec: number; db: number }`
  - `export const DUCK_DB = -22`、`export const OPEN_DB = -14`、`export const OPEN_GAP_SEC = 0.8`、`export const RAMP_SEC = 0.3`、`export const FADE_IN_SEC = 0.5`、`export const FADE_OUT_SEC = 1.5`
  - `export function bgmEnvelope(captions: TimedCaption[], durationSec: number): VolumeKey[]`（按字幕区间视为人声：说话段保持 DUCK_DB；两段字幕间空隙 ≥ OPEN_GAP_SEC 时，空隙开始后 RAMP_SEC 内升到 OPEN_DB，空隙结束前 RAMP_SEC 降回；首尾淡入淡出到 -60 dB；关键帧按时间严格递增、相邻同值合并）
  - `export function dbAt(keys: VolumeKey[], sec: number): number`（线性插值；越界取端点）
  - `export interface SfxCue { sec: number; sfx: SfxId; volume: number }`
  - `export function sfxCues(shots: Shot[]): SfxCue[]`（规则：每个带卡片的分屏镜头开始处 `enter`；`toggles` 镜头开始后 0.6 秒每个 `on: true` 的行一个 `toggle`；`cta` 镜头开始后 0.5、1.0、1.5 秒各一个 `click`（按 actions 数量）；`bigNumber` 镜头开始后 0.1–0.7 秒每 0.1 秒一个 `tick`（音量 0.15）；`browser` 镜头开始处 `load`；`chips` 每个 `yes` 项一个 `confirm`（与入场间隔 0.12 秒一致）；同一时刻（±0.05 秒）只保留一个；默认音量 0.35）
  - `export function pickTrack(tracks: Track[], mood: Mood, seed: string): Track`（同情绪里按 seed 的哈希稳定选择；该情绪没有曲目时退到全部曲目）

- [ ] **Step 1: 测试**（每条规则至少一例；`bgmEnvelope` 用三段字幕：0–2、2.2–4（空隙 0.2 秒不抬起）、5–8（空隙 1 秒抬起）断言关键帧；`dbAt` 插值；`pickTrack` 同 seed 结果稳定、不同情绪选到对应情绪）
- [ ] **Step 2: Run** → FAIL；**Step 3** 实现；**Step 4** PASS + typecheck
- [ ] **Step 5: Commit** `git commit -m "feat: 背景乐人声压低包络、卡片音效触发点与选曲"`

---

### Task 3: Remotion 音频层与素材落地

**Files:**
- Create: `render/layers/AudioLayer.tsx`、`src/compose/stage-assets.ts`
- Modify: `src/storyboard/schema.ts`（`TalkProps` 增加 `bgm?: { file: string; keys: VolumeKey[]; durationSec: number }`、`sfx: SfxCue[]`、`captionStyle: CaptionStyleId`——`captionStyle` 由 Task 5 定义，本任务先加 `bgm` 与 `sfx`）、`render/Talk.tsx`
- Test: `tests/compose.test.ts`（追加：带背景乐与音效的 2 秒渲染，输出音轨存在且时长正确；用 ffmpeg `volumedetect` 断言最大音量不为 -91 dB 即非静音）

**Interfaces:**
- Produces:
  - `export async function stageAudio(workDir: string, cfg: AppConfig, track: Track | null, cues: SfxCue[]): Promise<{ bgm?: string; sfxFiles: string[] }>`（把曲目复制到 `workDir/audio/bgm.mp3`，用到的音效复制到 `workDir/audio/sfx/`；返回相对 workDir 的路径）
  - `AudioLayer`：`<Audio src={staticFile(bgm)} loop volume={(f) => 10 ** (dbAt(keys, f / fps) / 20)} />`（曲目短于成片时 `loop`）；每个音效 `<Sequence from={Math.round(cue.sec * fps)}><Audio src={staticFile('audio/sfx/' + file)} volume={cue.volume} /></Sequence>`
- [ ] Steps：测试先行 → 实现 → `pnpm vitest run tests/compose.test.ts && pnpm typecheck` → Commit `git commit -m "feat: 成片背景乐（随人声压低）与卡片音效"`

---

### Task 4: 响度统一到 -14 LUFS

**Files:**
- Create: `src/audio/loudness.ts`
- Test: `tests/loudness.test.ts`

**Interfaces:**
- Produces:
  - `export const TARGET = { I: -14, TP: -1.5, LRA: 11 } as const`
  - `export function parseLoudnormJson(stderr: string): { input_i: number; input_tp: number; input_lra: number; input_thresh: number; target_offset: number }`（取 stderr 最后一个 `{…}` 块）
  - `export async function normalizeLoudness(input: string, output: string, cfg: AppConfig): Promise<{ before: number; after: number }>`（第一遍 `-af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null -`；第二遍带 `measured_*` 与 `offset` 参数、`linear=true`，`-c:v copy -c:a aac -b:a 192k -ar 48000`；`after` 用第三次测量得到）
- [ ] **Step 1: 测试**：用 lavfi 生成 4 秒 -30 dBFS 正弦 + 黑屏视频，`normalizeLoudness` 后 `after` 在 -14±1；`parseLoudnormJson` 解析样例 stderr
- [ ] Steps 2–4；**Step 5: Commit** `git commit -m "feat: 成片响度两遍 loudnorm 统一到 -14 LUFS"`

---

### Task 5: 6 套字幕样式与本地字体

**Files:**
- Create: `src/captions/styles.ts`、`render/fonts.ts`
- Modify: `render/layers/CaptionLayer.tsx`、`render/Root.tsx`（新增 `CaptionStill` 合成：1080×600，渲染一行示例字幕，供测试与 P5 预览）、`src/compose/stage-assets.ts`（复制所选样式的字体到 `workDir/fonts/`）、`src/compose/render.ts`（`renderCaptionStill`）、`package.json`（`@remotion/fonts@4.0.531`）
- Test: `tests/caption-styles.test.ts`

**Interfaces:**
- Produces（`src/captions/styles.ts`）：
  - `export const CAPTION_STYLES = { blade, wenkai, smiley, minimal, kuaile, song } as const`，`export type CaptionStyleId = keyof typeof CAPTION_STYLES`，`export const DEFAULT_CAPTION_STYLE: CaptionStyleId = 'blade'`
  - 每套：`{ name: string; font: string /* FontAsset.id */; family: string; size: number; weight: number; color: string; stroke?: { width: number; color: string }; box?: { color: string; radius: number; padX: number; padY: number }; highlight?: string }`
  - 6 套：`blade` 刀锋（思源黑体 900，白字黑描边 10，默认，等同 P3a 现状）、`wenkai` 文楷（霞鹜文楷，暖白 `#FFF6E8` 字 + 深棕描边 8）、`smiley` 得意（得意黑，白字黑描边 10，关键数字染 `#D4F23C`）、`minimal` 简约（思源黑体 600，白字，半透明黑底圆角框 `rgba(0,0,0,0.55)`）、`kuaile` 快乐（站酷快乐体，黄字 `#FFE14D` 黑描边 10）、`song` 宋韵（思源宋体 800，白字黑描边 8）
- `render/fonts.ts`：`loadCaptionFont(family, file)` 用 `@remotion/fonts` 的 `loadFont({ family, url: staticFile('fonts/' + file) })`，在 `CaptionLayer` 外层以 `delayRender/continueRender` 等字体加载完成
- `TalkProps` 增加 `captionStyle: CaptionStyleId` 与 `captionFontFile: string`
- [ ] **Step 1: 测试**：6 套样式的 `font` 都在 `loadFonts()` 里；每套渲染一张 `CaptionStill`（需要字体已下载：`describe.skipIf(!fontsReady(cfg))`）且文件 >5KB；两套不同样式渲染结果字节不同
- [ ] Steps 2–4；**Step 5: Commit** `git commit -m "feat: 6 套字幕样式与本地字体加载"`

---

### Task 6: 封面 4:3 与 3:4

**Files:**
- Create: `render/Cover.tsx`、`src/compose/cover.ts`
- Modify: `render/Root.tsx`（`Cover43` 1440×1080、`Cover34` 1080×1440 两个合成）
- Test: `tests/cover.test.ts`

**Interfaces:**
- Produces:
  - `export interface CoverProps { title: string; highlight: string[]; kicker?: string; personImage: string /* 相对 workDir */; captionStyle: CaptionStyleId; captionFontFile: string }`
  - `export function coverTitle(storyboard: Storyboard, captions: TimedCaption[]): { title: string; highlight: string[]; kicker?: string }`（取第一张 hook 卡的 headline/highlight/kicker；没有 hook 时取第一句字幕，最长 16 字）
  - `export async function extractPersonFrame(video: string, sec: number, output: string, cfg: AppConfig): Promise<void>`（ffmpeg 取帧 PNG）
  - `export async function renderCovers(workDir: string, props: CoverProps): Promise<{ cover43: string; cover34: string }>`（输出 `workDir/cover-4x3.png`、`cover-3x4.png`）
- 版式：人物照片铺满（4:3 放右侧 55%，3:4 放下半），大标题用所选字幕样式字体 120–150px，`highlight` 染荧光黄绿 `#D4F23C`，kicker 小胶囊；参考 `top-hook1.png` 的配色
- [ ] **Step 1: 测试**：`coverTitle` 两种来源；`renderCovers` 输出两张 PNG，尺寸分别 1440×1080、1080×1440（ffprobe 校验）
- [ ] Steps 2–4；**Step 5: Commit** `git commit -m "feat: 4:3 与 3:4 封面"`

---

### Task 7: 接入出片流程

**Files:**
- Modify: `src/storyboard/generate.ts`（输出增加 `"bgm":"chill|tech|upbeat"`，归一化时缺省 `chill`）、`src/storyboard/schema.ts`（`Storyboard` 增加 `bgm: Mood`）、`src/pipeline/run.ts`、`src/pipeline/project.ts`、`src/cli.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- `PipelineStep` 在 `'compose'` 之后增加 `'loudness' | 'cover'`
- `PipelineArgs` 增加 `audio?: { bgm: 'auto' | 'none' | string /* track id */ }`、`captionStyle?: CaptionStyleId`、`cover?: boolean`；CLI：`--bgm auto|none|<曲目id>`（默认 auto）、`--caption-style <id>`（默认 blade）、`--no-cover`
- `ProjectFile` 增加 `audio?: { track: string | null; mood: Mood; sfxCount: number }`、`loudness?: { before: number; after: number }`、`artifacts.cover43?`、`artifacts.cover34?`
- 素材未下载时：配乐/字体缺失不报错，降级为无配乐、PingFang SC，并在进度消息里提示「运行 pnpm fetch-assets 可启用配乐与字体」
- 渲染输出先写 `final.raw.mp4`，loudness 后得到最终 `output`，删除 raw
- [ ] Steps：测试先行（步骤顺序、降级提示、project 字段）→ 实现 → `pnpm typecheck && pnpm test` → Commit `git commit -m "feat: 出片流程接入配乐音效、响度统一、字幕样式与封面"`

---

## 验收（控制者执行）

真实素材出片：听感（人声压低是否自然）、`ffmpeg -af ebur128` 实测 -14±1 LUFS、6 套字幕样式截图、两张封面；写入 `docs/acceptance/p3c.md`。
