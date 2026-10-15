# P5 对话式工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本机服务 + 浏览器工作台（G1 视觉）：上传口播 → 设置卡（背景、字幕样式、预估花费）→「开始出片」→ 剪辑直播 → 多轮对话修改（可 @时间引用、AI 回复带可点选项）→ 每轮出新版本且只重渲受影响的镜头 → 版本切换、回退、双版本同步对比、导出。

**Architecture:**
- **项目存储**：`<dataDir>/projects/<id>/`，`base/` 放与版本无关的分析产物（原片、识别、剪口误、cut.mp4、person.mp4），`v1/ v2/ …` 每个版本一个目录（分镜、字幕、样式、B-roll、分段渲染缓存、成片）；`space.json` 记录项目元信息与版本列表。
- **分段渲染**：成片按镜头切成若干段，每段只渲染画面（无声）并按「镜头内容哈希」缓存；整条音轨（人声 + 配乐 + 音效）单独渲染一次；ffmpeg 无损拼接画面、合上音轨、再统一响度。改一张卡片只重渲这一段。
- **任务执行**：同一时间只跑一个任务（可想限制 + 本机算力），事件总线把进度推给 SSE，并逐条落盘 `events.jsonl` 以便「剪辑直播」重播。
- **修改引擎**：对话消息（含 `@mm:ss` 引用）+ 当前版本摘要 → 模型输出 `EditPlan`（操作列表 + 回复 + 可选项），程序应用操作生成新版本，按操作类型决定要重跑的阶段。
- **前端**：Vite + React 18 + motion（工作台 UI 动效），按 `docs/design/G1-ego-light.html` 还原；构建产物由本机服务静态托管。

**Tech Stack:** Node 22 `node:http`（不引框架）、SSE、Vite 5 + React 18.3.1 + motion 11、zod、Remotion（`renderMedia` 的 `frameRange` 与 `muted`/音频单独渲染）、ffmpeg concat demuxer、vitest、Playwright（端到端冒烟）

**Spec:** `docs/DECISIONS.md`（工作台交互（对话式）全部条目；key 存储；可想 AI 余额显示；默认不收集数据）、`docs/design/direction-approved.md`、`docs/design/SPEC-v4-ego.md`、`docs/design/G1-ego-light.html`（视觉与交互的唯一参照）。依赖 P1–P4。

## Global Constraints

- 布局：最左 Spaces 项目栏 / 左对话流 / 右大预览（9:16）；不是剪辑软件：没有时间线、轨道、检查器、步进键；底部只有细进度条 + 本版改动蓝点
- 首次：一张设置卡（上传口播 + 选背景 + 选字幕样式 + 预估花费）→「开始出片」
- 等待期：剪辑直播（转录逐行出现、气口被划掉、分镜逐张出现、自检分数跳出），可重播
- 修改：多轮对话；点/暂停预览插入「@mm:ss 卡片名」引用；AI 回复可带可点选的内联选项
- 版本：每轮出新版本（v1→v2→v3），只重渲受影响段；可回退；可双版本对比同步播放
- 输入格式：支持 1–N 段口播（AI 按语义重排）；输出 v1 只做 9:16
- key 存储：系统钥匙串优先（macOS `security` 命令；Windows 用 DPAPI 的 PowerShell `ConvertFrom-SecureString`），退回 `<dataDir>/key`（600 权限）；首次填入即校验（调一次 `GET /api/v1/models`）；注册链接 `https://kexiangai.com`（不带邀请码）
- 默认不收集任何数据；服务只监听 127.0.0.1
- G1 视觉 token（照抄 SPEC-v4-ego.md）：背景 `#fff/#f7f7f7/#f5f5f5/#eee/#e0e0e0`，文字 `#000000e6/#000000b3/#0000008f/#0000003d`，品牌蓝阶 `#d6dff5 #adc0eb #85a0e0 #5c81d6 #3361cc #294ea3`，阴影与圆角按 SPEC；标题内斜体衬线点缀用 IBM Plex Serif Italic ExtraLight（仅数字/拉丁/括号小注），中文点缀用 Noto Serif SC；主 CTA 黑胶囊、次 CTA `#eee` 胶囊；`@时间` 浅蓝胶囊；招牌油画 `docs/design/assets/art/*.png`（上线前压缩为 webp ≤ 400KB）
- 品质标准：Awwwards / Webby / FWA 获奖水准；交付前用浏览器截图自检 5 维（版式/层级/动效/一致性/细节）每维 ≥ 8.5，不达标反复改到达标
- 设计参考（前端任务必须逐个查阅并在报告里写明借鉴了什么）：motion.dev React 示例与 scroll-animations、prompt-motion.com、unsection.com（模块）、bentogrids.com（便当网格）、60fps.design（微交互）、jiro.build（设计提示词）、navbar.gallery、footer.design、cta.gallery、styles.refero.design；动效用 motion（React），需要 3D 时用 three.js；做图用 GPT Image 2，人物与场景用 Midjourney，视频用 Seedance
- 代码注释、报错、界面文案、commit 用中文；commit `<type>: <描述>`，无署名行；文件 < 400 行；函数 < 50 行；不可变数据

---

### Task 1: 项目存储、版本与 key 管理

**Files:** Create `src/workspace/store.ts`、`src/workspace/keychain.ts`；Test `tests/workspace-store.test.ts`、`tests/keychain.test.ts`

**Interfaces:**
- `export interface Space { id: string; title: string; createdAt: string; inputs: string[]; versions: VersionMeta[]; settings: SpaceSettings }`
- `export interface SpaceSettings { background?: BackgroundSpec; captionStyle: CaptionStyleId; budgetYuan: number; broll: boolean; maxVideos: number }`
- `export interface VersionMeta { n: number; createdAt: string; parent?: number; summary: string; changedShots: number[]; costYuan: number; qaScore?: number; status: 'running' | 'done' | 'failed' }`
- `export class SpaceStore { constructor(root: string); create(title: string, inputs: string[], settings: SpaceSettings): Space; list(): Space[]; get(id: string): Space; baseDir(id: string): string; versionDir(id: string, n: number): string; addVersion(id: string, meta: Omit<VersionMeta, 'n' | 'createdAt'>): VersionMeta; updateVersion(id: string, n: number, patch: Partial<VersionMeta>): VersionMeta; rename(id: string, title: string): Space }`（写 `space.json` 先写临时文件再 rename，原子替换）
- `keychain.ts`：`export interface KeyStore { get(): Promise<string | null>; set(key: string): Promise<void>; clear(): Promise<void> }`、`export function createKeyStore(dataDir: string, platform?: NodeJS.Platform, exec?: Exec): KeyStore`（macOS：`security add-generic-password -U -s mingzhi -a kexiang -w <key>` / `find-generic-password -s mingzhi -a kexiang -w`；失败或其他平台退回 600 文件）、`export async function validateKey(key: string, fetchImpl?: typeof fetch): Promise<boolean>`
- 测试：临时目录里建项目、加版本、并发更新不丢字段（顺序调用即可）、原子写；keychain 用假 exec 断言命令参数，退回文件权限为 0o600

### Task 2: 分段渲染与缓存

**Files:** Create `src/compose/segments.ts`；Modify `src/compose/render.ts`（新增 `renderVideoSegment`、`renderAudioTrack`）；Test `tests/segments.test.ts`

**Interfaces:**
- `export function shotHash(shot: Shot, props: Omit<TalkProps, 'shots'>, index: number): string`（镜头内容 + 时间范围 + 影响该段画面的全局属性（人像文件、取景框、字幕样式、该段内的字幕）做 sha1）
- `export async function renderSegmented(opts: { workDir: string; cacheDir: string; props: TalkProps; output: string; onProgress?: (done: number, total: number, reused: number) => void }): Promise<{ rendered: number[]; reused: number[] }>`
  - 每个镜头用 `renderMedia({ frameRange: [startFrame, endFrame - 1], muted: true, codec: 'h264' })` 渲染到 `cacheDir/<hash>.mp4`，已存在则复用
  - 音轨：`renderMedia({ codec: 'aac' })` 整条渲染到 `workDir/audio.m4a`（音轨与画面分开，避免拼接处爆音）
  - `ffmpeg -f concat -safe 0 -i list.txt -i audio.m4a -map 0:v -map 1:a -c copy` 合成
  - 镜头边界帧号：`Math.round(sec * 30)`；相邻镜头首尾帧号必须连续（测试断言总帧数 = 成片时长 × 30）
- 测试：3 个镜头渲染后改第 2 个镜头的卡片标题再渲染，`rendered` 只含 1、`reused` 含 0 与 2；拼接结果时长与帧数正确、有音轨

### Task 3: 任务队列与事件流

**Files:** Create `src/workspace/jobs.ts`、`src/workspace/events.ts`；Modify `src/pipeline/run.ts`（`onProgress` 事件补充结构化字段：`detail?: { kind: 'transcript' | 'cut' | 'shot' | 'qa' | 'cost' | 'progress'; data: unknown }`，在识别、剪口误、分镜、自检、记账处发出）；Test `tests/jobs.test.ts`

**Interfaces:**
- `export type WorkEvent = { t: number; spaceId: string; version: number; step: PipelineStep | 'queued' | 'failed'; message: string; detail?: { kind: string; data: unknown } }`
- `export class EventBus { publish(e: WorkEvent): void; subscribe(spaceId: string, fn: (e: WorkEvent) => void): () => void; history(spaceId: string, version: number): WorkEvent[] }`（同时追加写 `versionDir/events.jsonl`）
- `export class JobQueue { constructor(run: (job: Job) => Promise<void>); enqueue(job: Job): number /* 排队位置 */; current(): Job | null; cancel(spaceId: string): boolean }`（串行；失败不阻塞后续；取消通过 `AbortSignal` 传给流程，流程在步骤之间检查）
- 测试：两个任务串行、事件顺序、取消后事件为 `failed` 且消息「已取消」、重播读取 events.jsonl

### Task 4: 修改引擎

**Files:** Create `src/edit/plan.ts`、`src/edit/apply.ts`、`src/edit/refs.ts`；Test `tests/edit.test.ts`

**Interfaces:**
- `refs.ts`：`export function parseTimeRefs(text: string): { sec: number; label?: string }[]`（识别 `@01:05`、`@1:05 对比条卡`）、`export function shotForTime(shots: Shot[], sec: number): number`
- `plan.ts`：`export const EDIT_MODEL = 'google/gemini-3.5-flash'`；`EditOpSchema` 判别联合：`setBackground{spec}`、`setCaptionStyle{id}`、`setCoverStyle{id}`（只重做封面）、`setBgm{mood|trackId|'none'}`、`replaceCard{shotIndex, card}`、`setLayout{shotIndex, layout}`、`regenerateVisual{shotIndex, visual}`、`editCaption{index, text}`、`pace{direction:'tighter'|'looser'}`（调剪辑方案的 pad/mergeGap）、`removeSpan{fromSec,toSec}`、`restoreSpan{fromSec,toSec}`；`EditPlan = { reply: string; ops: EditOp[]; options?: { label: string; ops: EditOp[] }[] }`；`export async function planEdit(client, message, context: EditContext): Promise<EditPlan>`（上下文含：分镜摘要（镜头号、时间、模板、标题）、字幕、当前设置、引用解析结果、可用预设与样式列表）
- `apply.ts`：`export function stagesFor(ops: EditOp[]): Set<'cut' | 'matte' | 'captions' | 'storyboard' | 'broll' | 'compose'>`（例如 setBackground → matte+compose；replaceCard → compose；regenerateVisual → broll+compose；pace/removeSpan → cut+matte+captions+storyboard+broll+compose）；`export function applyOps(state: VersionState, ops: EditOp[]): VersionState`（纯函数，不可变）
- `apply.ts` 定义并导出 `VersionState`（字段见 Task 5），`applyOps` 对它操作
- 测试：每种操作的 stagesFor；applyOps 不修改入参；假模型返回非法操作时丢弃并在回复里说明；@时间解析

### Task 5: 版本运行器（只重跑受影响的步骤）

**Files:** Create `src/workspace/runner.ts`；Modify `src/pipeline/run.ts`（把分析、制作、成片等阶段导出为可单独调用的函数，`runPipeline` 行为不变）、`src/matting/*`（抠像时额外输出遮罩视频）、`src/pipeline/run.ts` 的 compose 改用 Task 2 的 `renderSegmented`（`cacheDir` 由调用方给；缺省为 `workDir/segments`）；Test `tests/runner.test.ts`

**Interfaces:**
- Consumes：Task 1 `SpaceStore`（`baseDir`、`versionDir`、`addVersion`、`updateVersion`）；Task 2 `renderSegmented`；Task 3 `WorkEvent` 与 `AbortSignal`；Task 4 `EditOp`、`stagesFor`、`applyOps`、`VersionState`
- `export interface VersionState { settings: SpaceSettings; plan: EditPlan /* 剪辑方案 */; captions: TimedCaption[]; storyboard: Storyboard; coverStyle: CoverStyleId; bgm: AudioOptions }`（Task 4 定义并导出，本任务使用）
- `export async function runFirstVersion(ctx: RunnerCtx, spaceId: string): Promise<VersionMeta>`：跑完整流程；与版本无关的产物（探测、识别、剪口误、cut.mp4、抠像遮罩 `matte.mp4`）写 `base/`，其余写 `v1/`；结束写 `v1/state.json`（`VersionState`）
- `export async function runNextVersion(ctx: RunnerCtx, spaceId: string, parent: number, ops: EditOp[], summary: string): Promise<VersionMeta>`：读父版本 `state.json` → `applyOps` → 按 `stagesFor` 只跑需要的阶段，其余从父版本复用（复制或引用文件）；分段渲染缓存放 `base/segments/`，所有版本共用，未改动的镜头直接复用；`changedShots` = 本次实际重渲的镜头序号
- 换背景：抠像时把 alpha 遮罩存成灰度视频 `base/matte.mp4`；之后换背景只做合成（ffmpeg），不重新推理
- 封面：只有 `setCoverStyle` 或首个版本才生成；其余版本复用父版本封面
- 测试（用假 LLM / 假渲染注入）：v1 → `setCaptionStyle` 只跑 compose 且复用全部抠像产物；`replaceCard` 只重渲 1 段；`setBackground` 不调用抠像推理；`removeSpan` 重跑剪切到成片；父版本目录不被修改

### Task 6: 本机 HTTP 服务

**Files:** Create `src/server/index.ts`、`src/server/routes.ts`、`src/server/media.ts`、`src/server/upload.ts`；Modify `package.json`（脚本 `"serve": "tsx src/server/index.ts"`）；Test `tests/server.test.ts`

**Routes（全部 JSON，除媒体与 SSE）：**
- `GET /api/status`（版本、key 是否已配置、素材/模型是否就绪）
- `GET/POST/DELETE /api/key`（POST 校验后保存）
- `GET /api/spaces`、`POST /api/spaces`（创建空项目）、`GET /api/spaces/:id`、`PATCH /api/spaces/:id`
- `POST /api/spaces/:id/inputs`（流式上传，`x-filename` 头；支持多段）
- `GET /api/spaces/:id/estimate`、`POST /api/spaces/:id/start`（开始 v1）、`POST /api/spaces/:id/messages`（对话修改 → 返回 EditPlan；`POST /api/spaces/:id/apply` 执行某个选项或全部 ops → 新版本）
- 执行：`start` 调 Task 5 `runFirstVersion`，`apply` 调 `runNextVersion`，都经 Task 3 `JobQueue` 排队
- `POST /api/spaces/:id/versions/:n/revert`（以该版本为基础复制出新版本）
- `GET /api/spaces/:id/events?version=n`（SSE；先补发历史再推实时）
- `GET /media/:id/:n/final.mp4` 等（Range；只允许项目目录内的白名单文件名）
- `POST /api/spaces/:id/versions/:n/export`（复制成片与封面到 `~/Downloads/明知AI剪辑/<标题>-v<n>.mp4`）
- 静态托管 `web/dist`
- 只监听 `127.0.0.1`；端口默认 4321，被占用时顺延
- 测试：起服务（随机端口）走一遍创建 → 上传（小样片）→ estimate → status；媒体 Range 返回 206；路径穿越（`../`）返回 404；SSE 收到补发事件

### Task 7: 前端外壳与设置卡（G1）

**Files:** Create `web/`（`index.html`、`vite.config.ts`、`src/main.tsx`、`src/App.tsx`、`src/theme.css`（token）、`src/components/{SpacesRail,ChatFlow,PreviewStage,Composer,SetupCard,AnnouncementBar}.tsx`、`src/api.ts`）；Modify 根 `package.json`（`build:web`、`dev:web`）、`tsconfig.json`（web 单独 tsconfig）

- 还原 `docs/design/G1-ego-light.html` 的布局、token、阴影、圆角、字体与斜体衬线点缀；油画用压缩后的 webp
- 设置卡：拖入/选择口播（多段）、10 个背景缩略图（预设 + 上传 + 一句话生成输入框）、6 个字幕样式预览（用 `CaptionStill` 渲染的 PNG，服务启动时生成缓存）、10 个封面风格预览（每种风格内置一张示例缩略图，随仓库提供，不含真人）、预算滑块、预估花费（调 estimate）、「开始出片」黑胶囊
- 首次无 key：设置卡上方先出 key 卡（输入框 + 「去可想 AI 注册」链接 + 校验状态）
- 验收：Playwright 截图 1440×900 与 G1 原稿并排对比，5 维自评每维 ≥ 8.5，记录在报告里

### Task 8: 剪辑直播、版本与对话修改

**Files:** Create `web/src/components/{LiveTerminal,VersionCard,VersionSwitcher,CompareView,InlineOptions,TimeRefChip,ProgressRail}.tsx`、`web/src/live.ts`（SSE 客户端与重播）

- 剪辑直播：深色终端窗逐行输出；对话流里出现转录行（被剪的词划掉）、分镜卡缩略逐张出现、自检分数跳出；完成后可点「重播」按 events.jsonl 的时间间隔（压缩到 ≤ 20 秒）重放
- 预览：9:16 白色浮窗播放当前版本；暂停时 Composer 左下出现「插入 @mm:ss <卡片名>」；底部细进度条 + 本版改动蓝点（`changedShots` 的起点）
- 版本：顶部 v1/v2/v3 切换；对比开关打开后左右两个 9:16 同步播放（共享一个时钟，拖动任一个进度另一个跟随）；版本卡显示耗时、花费、自检分；「回退到此版本」
- AI 回复：文本 + 内联选项胶囊（点了即调用 apply）
- 导出：顶部黑胶囊，完成后 toast 显示文件位置
- 端到端：Playwright 走「上传样片 → 开始 → 等完成 → 发一条修改 → 出 v2 → 对比」，用假 LLM 模式（服务支持 `MINGZHI_FAKE_LLM=1` 环境变量，仅测试用，返回固定分镜/计划，不调用网络）

### Task 9: 1–N 段口播按语义重排

**Files:** Modify `src/pipeline/run.ts`（多输入：逐段识别 → 模型给出段落顺序 → 按顺序拼接 cut 结果）；Create `src/pipeline/multi.ts`；Test `tests/multi.test.ts`

- `export async function orderSegments(client, transcripts: string[]): Promise<number[]>`（模型输出顺序，校验为 0..n-1 的排列，否则保持原顺序）
- 拼接：每段先各自剪口误与剪切，再 concat 成一个 cut.mp4（时间轴与字幕按段偏移）

---

## 验收（控制者执行）
真实浏览器全流程（上传你的口播 → v1 → 「背景换成夜景落地窗」→ v2 只重渲人像相关段 → 对比 → 导出）；截图与 G1 原稿对比；写 `docs/acceptance/p5.md`。
