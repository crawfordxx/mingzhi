# P2 换背景与人像中间件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm mingzhi edit 口播.mp4 --bg study`（或 `--bg 图片路径`、`--bg-prompt "一句话"`）在 P1 精剪成片的基础上，本地抠像换背景（虚化 + 色温/亮度匹配），输出换背景并烧录字幕的成片，并在 `project.json` 记录背景与人物取景框，供 P3 做「下半屏人像」排版。

**Architecture:** 剪切后的 `cut.mp4` 由 ffmpeg 解成 rgb24 逐帧，经 onnxruntime-node 跑 RobustVideoMatting（mobilenetv3 fp32，CPU）得到前景与 alpha，用纯函数与预处理好的背景逐帧合成后交给 ffmpeg 编码（音轨直接拷贝）。合成前先抽 8 帧估计人物平均色，算出朝背景靠拢的通道增益。背景来自 10 张内置预设、用户文件或可想 GPT Image 生成；可想异步任务（生图/生视频）统一走一个串行队列客户端，P3 的 Seedance 复用它。

**Tech Stack:** Node ≥22、TypeScript、onnxruntime-node 1.20.1、ffmpeg 9（`~/.mingzhi/bin`）、vitest、zod

**Spec:** `docs/DECISIONS.md`（「抠像换背景」「换背景：10 张预设…+ 上传 + 一句话生成」「生图」「⚠️ 实测约束」各条）；路线图 `docs/superpowers/plans/2026-10-14-roadmap.md` 的 P2 行。

## Global Constraints

- 纯 JS，不依赖 Python；音频与画面处理都在本机
- 产品只接「可想 AI」（kexiangai.com）；仓库不含任何 key；key 只从环境变量 `MINGZHI_KX_KEY` 读取
- 可想套餐同一时间只能跑 1 个任务 → 所有生图/生视频请求串行排队；余额不足会直接 400
- 抠像：onnxruntime 跑 RobustVideoMatting；背景虚化 + 色温/亮度匹配
- 10 张预设：书房/极简工作室/咖啡馆/夜景落地窗/科技暗色/日式和室/绿植阳台/图书馆/黄昏天台/水泥灰墙（文件已在 `docs/design/assets/bg/`）
- 实测：RVM mobilenetv3 fp32 + onnxruntime-node 1.20.1 CPU，1080×1920、downsample 0.25：推理 48ms/帧、整体 12.8fps；CoreML EP 更慢（9.4fps），**只用 CPU**
- 可想异步任务接口（实测）：`POST https://kexiangai.com/api/v1/user_task/asyncCreateWithCost`，头 `x-api-key: <key>`（不带 `sk-` 前缀）、`Content-Type: application/json`，体 `{"user_input":{...}}`，返回 `{"id":…, "cost":…}`；查询 `GET https://kexiangai.com/api/v1/user_task/get/passAuth/<id>`，返回 `task_status`、`cost`、`service_output.imgUrl` / `service_output.videoUrl` / `service_output.failReason`
- 生图请求体（实测可用）：`{"modelName":"GPT-Image-2.5-Flare","modelType":"text2img","prompt":…,"size":"2:3","resolution":"1k","quality":"medium","output_format":"jpeg"}`，约 ¥0.2/张、约 20 秒
- 代码注释、报错、commit 用中文；commit 格式 `<type>: <描述>`，不加任何署名行
- 不可变数据风格；文件 < 400 行；函数 < 50 行
- 测试：`pnpm test`（vitest）；需要本地模型的测试用 `describe.skipIf(!…)` 跳过

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/llm/kexiang-task.ts`（新） | 可想异步任务客户端：提交、轮询、串行队列、下载结果 |
| `src/media/exec.ts`（改） | 增加 `runBuffer`：取二进制 stdout（背景 rgb24） |
| `src/background/presets.ts`（新） | 10 张预设的 id/中文名/文件；预设目录定位 |
| `src/background/resolve.ts`（新） | 解析 `--bg`/`--bg-prompt` 为 `BackgroundSpec`；把 spec 落成本地图片路径（生成走可想生图） |
| `src/background/prepare.ts`（新） | 背景图缩放裁切到视频尺寸并高斯虚化，输出 rgb24 Buffer |
| `src/matting/composite.ts`（新） | 纯函数：下采样比例、色温/亮度增益、逐帧合成、alpha 取景框与中位数 |
| `src/matting/rvm.ts`（新） | RVM 推理与整段视频抠像合成（解码→推理→合成→编码） |
| `src/pipeline/run.ts`、`src/pipeline/project.ts`、`src/cli.ts`（改） | 接入背景与抠像步骤、工程文件字段、命令行参数 |
| `assets/backgrounds/*.jpg`（新） | 从 `docs/design/assets/bg/` 复制的 10 张预设 |
| `scripts/fetch-models.mjs`（改） | 增加 RVM 模型下载与 sha256 校验 |

---

### Task 1: 可想异步任务客户端

**Files:**
- Create: `src/llm/kexiang-task.ts`
- Test: `tests/kexiang-task.test.ts`

**Interfaces:**
- Produces:
  - `export const KEXIANG_TASK_BASE = 'https://kexiangai.com/api/v1/user_task'`
  - `export interface TaskInput { modelName: string; modelType: string; [key: string]: unknown }`
  - `export interface TaskResult { taskId: string; url: string; cost?: number }`
  - `export interface TaskRunOptions { kind: 'image' | 'video'; timeoutMs?: number; onStatus?: (status: string) => void }`
  - `export interface TaskClient { run(input: TaskInput, opts: TaskRunOptions): Promise<TaskResult> }`
  - `export class KexiangTaskClient implements TaskClient { constructor(apiKey: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, pollMs?: number) }`
  - `export async function downloadTo(url: string, dest: string, fetchImpl?: typeof fetch): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/kexiang-task.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadTo, KexiangTaskClient, KEXIANG_TASK_BASE } from '../src/llm/kexiang-task.js';

type Reply = { status?: number; body: unknown };
/** 按顺序回放响应，并记录请求 */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = replies[calls.length - 1];
    if (!r) throw new Error('多余的请求');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const noSleep = async (): Promise<void> => {};

describe('KexiangTaskClient', () => {
  it('提交后轮询，拿到 imgUrl 即返回；头带 x-api-key（去掉 sk- 前缀），体包在 user_input 里', async () => {
    const { impl, calls } = fakeFetch([
      { body: { id: 77, cost: 0.2 } },
      { body: { task_status: 'running', service_output: {} } },
      { body: { task_status: 'success', cost: 0.2, service_output: { imgUrl: 'https://x/1.jpg' } } },
    ]);
    const client = new KexiangTaskClient('sk-abc', impl, noSleep, 1);
    const statuses: string[] = [];
    const res = await client.run({ modelName: 'M', modelType: 'text2img', prompt: 'p' }, { kind: 'image', onStatus: (s) => statuses.push(s) });
    expect(res).toEqual({ taskId: '77', url: 'https://x/1.jpg', cost: 0.2 });
    expect(calls[0].url).toBe(`${KEXIANG_TASK_BASE}/asyncCreateWithCost`);
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('abc');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ user_input: { modelName: 'M', modelType: 'text2img', prompt: 'p' } });
    expect(calls[1].url).toBe(`${KEXIANG_TASK_BASE}/get/passAuth/77`);
    expect(statuses).toEqual(['running']);
  });

  it('视频任务取 videoUrl', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'success', service_output: { videoUrl: 'https://x/v.mp4' } } }]);
    const res = await new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'V', modelType: 'text2video' }, { kind: 'video' });
    expect(res.url).toBe('https://x/v.mp4');
  });

  it('失败状态或 failReason 时报错并带原因', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'failed', service_output: { failReason: '内容审核未通过' } } }]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('内容审核未通过');
  });

  it('提交返回非 2xx（如余额不足 400）或没有 id 时报错', async () => {
    const a = fakeFetch([{ status: 400, body: { msg: '余额不足' } }]);
    await expect(new KexiangTaskClient('k', a.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('余额不足');
    const b = fakeFetch([{ body: { msg: '任务超过套餐限制' } }]);
    await expect(new KexiangTaskClient('k', b.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('任务超过套餐限制');
  });

  it('轮询总时长超过 timeoutMs 时报超时', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, ...Array.from({ length: 5 }, () => ({ body: { task_status: 'running' } }))]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 10).run({ modelName: 'M', modelType: 't' }, { kind: 'image', timeoutMs: 30 })).rejects.toThrow('超时');
  });

  it('多个任务串行执行：前一个结束后才提交下一个，前一个失败不影响后一个', async () => {
    const order: string[] = [];
    let n = 0;
    const impl = (async (url: string) => {
      n += 1;
      const isSubmit = url.endsWith('asyncCreateWithCost');
      order.push(isSubmit ? 'submit' : 'poll');
      if (isSubmit) return new Response(JSON.stringify({ id: n }));
      const fail = order.filter((o) => o === 'submit').length === 1;
      return new Response(JSON.stringify(fail ? { task_status: 'failed' } : { task_status: 'success', service_output: { imgUrl: 'u' } }));
    }) as unknown as typeof fetch;
    const client = new KexiangTaskClient('k', impl, noSleep, 1);
    const p1 = client.run({ modelName: 'M', modelType: 't' }, { kind: 'image' });
    const p2 = client.run({ modelName: 'M', modelType: 't' }, { kind: 'image' });
    await expect(p1).rejects.toThrow();
    await expect(p2).resolves.toMatchObject({ url: 'u' });
    expect(order).toEqual(['submit', 'poll', 'submit', 'poll']);
  });

  it('没有 key 时构造报错', () => {
    expect(() => new KexiangTaskClient('')).toThrow('MINGZHI_KX_KEY');
  });
});

describe('downloadTo', () => {
  it('写到目标路径，不留 .part 文件；非 2xx 报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-dl-'));
    const ok = (async () => new Response('hello')) as unknown as typeof fetch;
    await downloadTo('https://x/a.jpg', join(dir, 'a.jpg'), ok);
    expect(readFileSync(join(dir, 'a.jpg'), 'utf8')).toBe('hello');
    expect(existsSync(join(dir, 'a.jpg.part'))).toBe(false);
    const bad = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadTo('https://x/b.jpg', join(dir, 'b.jpg'), bad)).rejects.toThrow('404');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/kexiang-task.test.ts`
Expected: FAIL（找不到模块 `../src/llm/kexiang-task.js`）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/llm/kexiang-task.ts
import { createWriteStream, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const KEXIANG_TASK_BASE = 'https://kexiangai.com/api/v1/user_task';
const FAILED = new Set(['failed', 'fail', 'error', 'cancelled']);

export interface TaskInput { modelName: string; modelType: string; [key: string]: unknown }
export interface TaskResult { taskId: string; url: string; cost?: number }
export interface TaskRunOptions { kind: 'image' | 'video'; timeoutMs?: number; onStatus?: (status: string) => void }
export interface TaskClient { run(input: TaskInput, opts: TaskRunOptions): Promise<TaskResult> }

interface TaskQuery { task_status?: string; cost?: number; service_output?: { imgUrl?: string; videoUrl?: string; failReason?: string } }

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 可想异步任务（生图/生视频）：套餐同一时间只能跑 1 个任务，所以全部经实例内的队列串行执行 */
export class KexiangTaskClient implements TaskClient {
  private readonly key: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly sleep = defaultSleep, private readonly pollMs = 5000) {
    if (!apiKey) throw new Error('未配置可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
    this.key = apiKey.replace(/^sk-/, '');
  }

  run(input: TaskInput, opts: TaskRunOptions): Promise<TaskResult> {
    const next = this.queue.then(() => this.runOnce(input, opts));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runOnce(input: TaskInput, { kind, timeoutMs = 20 * 60_000, onStatus }: TaskRunOptions): Promise<TaskResult> {
    const submitted = await this.request<{ id?: number | string }>(`${KEXIANG_TASK_BASE}/asyncCreateWithCost`, { method: 'POST', body: JSON.stringify({ user_input: input }) });
    if (submitted.id === undefined) throw new Error(`可想任务提交失败：${JSON.stringify(submitted).slice(0, 200)}`);
    const taskId = String(submitted.id);
    for (let waited = 0; waited < timeoutMs; waited += this.pollMs) {
      await this.sleep(this.pollMs);
      const q = await this.request<TaskQuery>(`${KEXIANG_TASK_BASE}/get/passAuth/${taskId}`);
      const out = q.service_output ?? {};
      const status = String(q.task_status ?? '');
      if (out.failReason || FAILED.has(status)) throw new Error(`可想任务失败：${out.failReason ?? status}`);
      const url = kind === 'image' ? out.imgUrl : out.videoUrl;
      if (url) return { taskId, url, ...(q.cost !== undefined ? { cost: q.cost } : {}) };
      onStatus?.(status);
    }
    throw new Error(`可想任务 ${taskId} 等待超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(url, { ...init, headers: { 'x-api-key': this.key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`可想任务请求失败 ${res.status}：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`可想任务返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }
}

/** 先写 <dest>.part，完整下载后再改名，避免中断留下半截文件 */
export async function downloadTo(url: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}：${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  renameSync(part, dest);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/kexiang-task.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/llm/kexiang-task.ts tests/kexiang-task.test.ts
git commit -m "feat: 可想异步任务客户端（提交、轮询、串行队列、下载）"
```

---

### Task 2: 背景来源与预处理

**Files:**
- Create: `assets/backgrounds/`（复制 10 张图）、`src/background/presets.ts`、`src/background/resolve.ts`、`src/background/prepare.ts`
- Modify: `src/media/exec.ts`（增加 `runBuffer`）
- Test: `tests/background.test.ts`

**Interfaces:**
- Consumes: Task 1 `TaskClient`、`downloadTo`；`AppConfig`（`src/config.ts`，含 `ffmpeg`）
- Produces:
  - `export async function runBuffer(cmd: string, args: string[]): Promise<Buffer>`（`src/media/exec.ts`）
  - `export const PRESETS: readonly { id: string; name: string; file: string }[]`、`export function presetPath(id: string): string`（`src/background/presets.ts`）
  - `export type BackgroundSpec = { kind: 'preset'; id: string } | { kind: 'file'; path: string } | { kind: 'prompt'; prompt: string }`
  - `export interface ResolvedBackground { spec: BackgroundSpec; path: string }`
  - `export function parseBackgroundArgs(bg: string | undefined, bgPrompt: string | undefined, baseDir: string): BackgroundSpec | undefined`
  - `export async function resolveBackground(spec: BackgroundSpec, workDir: string, task?: TaskClient, download?: (url: string, dest: string) => Promise<void>): Promise<ResolvedBackground>`（`download` 默认 `downloadTo`，测试注入）
  - `export const BG_IMAGE_MODEL = 'GPT-Image-2.5-Flare'`（`src/background/resolve.ts`）
  - `export async function loadBackgroundRgb(path: string, width: number, height: number, blurSigma: number, cfg: AppConfig): Promise<Buffer>`（`src/background/prepare.ts`，返回 `width*height*3` 字节）

- [ ] **Step 1: 复制预设图**

```bash
mkdir -p assets/backgrounds && cp docs/design/assets/bg/*.jpg assets/backgrounds/ && ls assets/backgrounds | wc -l
```
Expected: `10`

- [ ] **Step 2: Write the failing test**

```ts
// tests/background.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, presetPath } from '../src/background/presets.js';
import { BG_IMAGE_MODEL, parseBackgroundArgs, resolveBackground } from '../src/background/resolve.js';
import { loadBackgroundRgb } from '../src/background/prepare.js';
import type { TaskClient, TaskInput } from '../src/llm/kexiang-task.js';
import { loadConfig } from '../src/config.js';

describe('presets', () => {
  it('10 张预设，文件都存在', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['study', 'studio', 'cafe', 'night-window', 'tech-dark', 'japanese', 'balcony', 'library', 'rooftop', 'concrete']);
    for (const p of PRESETS) expect(existsSync(presetPath(p.id))).toBe(true);
  });
  it('未知预设报错并列出可选 id', () => {
    expect(() => presetPath('beach')).toThrow('study');
  });
});

describe('parseBackgroundArgs', () => {
  it('预设 id、文件路径（相对 baseDir 解析）、一句话提示词', () => {
    expect(parseBackgroundArgs('study', undefined, '/u')).toEqual({ kind: 'preset', id: 'study' });
    expect(parseBackgroundArgs('bg/a.jpg', undefined, '/u')).toEqual({ kind: 'file', path: '/u/bg/a.jpg' });
    expect(parseBackgroundArgs(undefined, '海边日落', '/u')).toEqual({ kind: 'prompt', prompt: '海边日落' });
    expect(parseBackgroundArgs(undefined, undefined, '/u')).toBeUndefined();
  });
  it('同时给 --bg 和 --bg-prompt 报错；提示词为空白报错', () => {
    expect(() => parseBackgroundArgs('study', '海边', '/u')).toThrow('只能二选一');
    expect(() => parseBackgroundArgs(undefined, '  ', '/u')).toThrow('不能为空');
  });
});

describe('resolveBackground', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-bg-'));
  it('预设直接返回内置文件路径', async () => {
    expect(await resolveBackground({ kind: 'preset', id: 'cafe' }, dir)).toEqual({ spec: { kind: 'preset', id: 'cafe' }, path: presetPath('cafe') });
  });
  it('文件不存在时报错', async () => {
    await expect(resolveBackground({ kind: 'file', path: join(dir, 'nope.jpg') }, dir)).rejects.toThrow('背景图片不存在');
  });
  it('一句话生成：调用生图任务（竖版 2:3、1k、medium），下载到工作目录', async () => {
    const inputs: TaskInput[] = [];
    const urls: string[] = [];
    const task: TaskClient = { run: async (input) => { inputs.push(input); return { taskId: '1', url: 'https://x/bg.jpg' }; } };
    const res = await resolveBackground({ kind: 'prompt', prompt: '海边日落' }, dir, task, async (url, dest) => { urls.push(url); writeFileSync(dest, 'img'); });
    expect(urls).toEqual(['https://x/bg.jpg']);
    expect(res.path).toBe(join(dir, 'background.jpg'));
    expect(existsSync(res.path)).toBe(true);
    expect(inputs[0]).toMatchObject({ modelName: BG_IMAGE_MODEL, modelType: 'text2img', size: '2:3', resolution: '1k', quality: 'medium', output_format: 'jpeg' });
    expect(String(inputs[0].prompt)).toContain('海边日落');
    expect(String(inputs[0].prompt)).toContain('no people');
  });
  it('一句话生成但没有任务客户端时报错', async () => {
    await expect(resolveBackground({ kind: 'prompt', prompt: 'x' }, dir)).rejects.toThrow('MINGZHI_KX_KEY');
  });
});

describe('loadBackgroundRgb', () => {
  it('缩放裁切到视频尺寸并输出 rgb24（宽×高×3 字节），虚化不改变尺寸', async () => {
    const cfg = loadConfig({});
    const sharp = await loadBackgroundRgb(presetPath('study'), 90, 160, 0, cfg);
    const blurred = await loadBackgroundRgb(presetPath('study'), 90, 160, 8, cfg);
    expect(sharp.length).toBe(90 * 160 * 3);
    expect(blurred.length).toBe(90 * 160 * 3);
    expect(blurred.equals(sharp)).toBe(false);
  });
});
```

注意：`resolveBackground` 的第 4 个参数是可注入的下载函数（默认 `downloadTo`），测试用它避免真实网络。

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/background.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 4: Write minimal implementation**

`src/media/exec.ts` 末尾追加：

```ts
/** 执行外部命令并取二进制 stdout（如 ffmpeg 输出 rawvideo）；失败时附 stderr 末尾 800 字 */
export async function runBuffer(cmd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    const tail = (e.stderr?.toString('utf8') ?? '').slice(-800);
    throw new Error(`命令执行失败：${cmd} ${args.slice(0, 6).join(' ')}…\n${tail || e.message}`);
  }
}
```

```ts
// src/background/presets.ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 内置 10 张预设背景（1:1、1k，GPT Image 生成），id 用于命令行与工程文件 */
export const PRESETS = [
  { id: 'study', name: '书房', file: '01-study.jpg' },
  { id: 'studio', name: '极简工作室', file: '02-studio.jpg' },
  { id: 'cafe', name: '咖啡馆', file: '03-cafe.jpg' },
  { id: 'night-window', name: '夜景落地窗', file: '04-night-window.jpg' },
  { id: 'tech-dark', name: '科技暗色', file: '05-tech-dark.jpg' },
  { id: 'japanese', name: '日式和室', file: '06-japanese.jpg' },
  { id: 'balcony', name: '绿植阳台', file: '07-balcony.jpg' },
  { id: 'library', name: '图书馆', file: '08-library.jpg' },
  { id: 'rooftop', name: '黄昏天台', file: '09-rooftop.jpg' },
  { id: 'concrete', name: '水泥灰墙', file: '10-concrete.jpg' },
] as const;

const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'backgrounds');

export function isPresetId(id: string): boolean {
  return PRESETS.some((p) => p.id === id);
}

export function presetPath(id: string): string {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`没有这个预设背景：${id}。可选：${PRESETS.map((p) => p.id).join('、')}`);
  const path = join(PRESET_DIR, preset.file);
  if (!existsSync(path)) throw new Error(`预设背景文件缺失：${path}`);
  return path;
}
```

```ts
// src/background/resolve.ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloadTo, type TaskClient } from '../llm/kexiang-task.js';
import { isPresetId, presetPath } from './presets.js';

export const BG_IMAGE_MODEL = 'GPT-Image-2.5-Flare';
/** 一句话生成背景时追加的固定要求：空场景、无人无字、浅景深、写实 */
const BG_SUFFIX = ', eye-level view as a talking-head video backdrop, empty scene, no people, no text, no logos, shallow depth of field with soft background blur, photorealistic, 35mm photo, natural color grading';

export type BackgroundSpec = { kind: 'preset'; id: string } | { kind: 'file'; path: string } | { kind: 'prompt'; prompt: string };
export interface ResolvedBackground { spec: BackgroundSpec; path: string }
type Download = (url: string, dest: string) => Promise<void>;

/** 命令行参数 → 背景规格：--bg 是预设 id 或图片路径（相对 baseDir），--bg-prompt 是一句话描述；两者只能给一个 */
export function parseBackgroundArgs(bg: string | undefined, bgPrompt: string | undefined, baseDir: string): BackgroundSpec | undefined {
  if (bg !== undefined && bgPrompt !== undefined) throw new Error('--bg 与 --bg-prompt 只能二选一');
  if (bgPrompt !== undefined) {
    if (!bgPrompt.trim()) throw new Error('--bg-prompt 不能为空');
    return { kind: 'prompt', prompt: bgPrompt.trim() };
  }
  if (bg === undefined) return undefined;
  return isPresetId(bg) ? { kind: 'preset', id: bg } : { kind: 'file', path: resolve(baseDir, bg) };
}

/** 背景规格 → 本地图片路径；一句话生成的图下载到 workDir/background.jpg */
export async function resolveBackground(spec: BackgroundSpec, workDir: string, task?: TaskClient, download: Download = downloadTo): Promise<ResolvedBackground> {
  if (spec.kind === 'preset') return { spec, path: presetPath(spec.id) };
  if (spec.kind === 'file') {
    if (!existsSync(spec.path)) throw new Error(`背景图片不存在：${spec.path}`);
    return { spec, path: spec.path };
  }
  if (!task) throw new Error('一句话生成背景需要可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
  const result = await task.run(
    { modelName: BG_IMAGE_MODEL, modelType: 'text2img', prompt: `${spec.prompt}${BG_SUFFIX}`, size: '2:3', resolution: '1k', quality: 'medium', output_format: 'jpeg' },
    { kind: 'image' },
  );
  const path = join(workDir, 'background.jpg');
  await download(result.url, path);
  return { spec, path };
}
```

```ts
// src/background/prepare.ts
import type { AppConfig } from '../config.js';
import { runBuffer } from '../media/exec.js';

/** 背景图缩放铺满（保持比例、居中裁切）到视频尺寸，blurSigma>0 时做高斯虚化；返回 rgb24 原始像素 */
export async function loadBackgroundRgb(path: string, width: number, height: number, blurSigma: number, cfg: AppConfig): Promise<Buffer> {
  const filters = [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, ...(blurSigma > 0 ? [`gblur=sigma=${blurSigma}`] : [])];
  const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', path, '-vf', filters.join(','), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (buf.length !== width * height * 3) throw new Error(`背景图处理结果尺寸不对：${buf.length} 字节`);
  return buf;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/background.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add assets/backgrounds src/background src/media/exec.ts tests/background.test.ts
git commit -m "feat: 背景来源（10 张预设、本地图片、一句话生成）与缩放虚化"
```

---

### Task 3: 合成用纯函数

**Files:**
- Create: `src/matting/composite.ts`
- Test: `tests/composite.test.ts`

**Interfaces:**
- Produces:
  - `export type Rgb = readonly [number, number, number]`（0–1）
  - `export interface SubjectBox { top: number; bottom: number; left: number; right: number }`（0–1，相对画面）
  - `export function chooseDownsample(width: number, height: number): number`
  - `export function meanRgb(rgb: Uint8Array | Buffer): Rgb`（rgb24 交错，0–1）
  - `export function foregroundMean(fgr: Float32Array, pha: Float32Array, pixels: number): Rgb | null`（fgr 为平面 CHW，pha>0.5 的像素平均；没有前景返回 null）
  - `export function colorMatchGains(fg: Rgb, bg: Rgb, wbStrength?: number, lumStrength?: number): Rgb`
  - `export function compositeFrame(fgr: Float32Array, pha: Float32Array, bg: Buffer, gains: Rgb, out: Buffer): void`
  - `export function alphaBox(pha: Float32Array, width: number, height: number, threshold?: number): SubjectBox | null`
  - `export function medianBox(boxes: SubjectBox[]): SubjectBox | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/composite.test.ts
import { describe, expect, it } from 'vitest';
import { alphaBox, chooseDownsample, colorMatchGains, compositeFrame, foregroundMean, meanRgb, medianBox } from '../src/matting/composite.js';

describe('chooseDownsample', () => {
  it('让长边缩到约 512 像素，小视频不放大', () => {
    expect(chooseDownsample(1080, 1920)).toBeCloseTo(512 / 1920, 5);
    expect(chooseDownsample(360, 640)).toBeCloseTo(0.8, 5);
    expect(chooseDownsample(200, 300)).toBe(1);
  });
});

describe('meanRgb / foregroundMean', () => {
  it('rgb24 平均到 0–1', () => {
    expect(meanRgb(Buffer.from([255, 0, 0, 0, 0, 255]))).toEqual([0.5, 0, 0.5]);
  });
  it('只统计 alpha>0.5 的前景像素；没有前景返回 null', () => {
    // 2 个像素，平面 CHW：R=[1,0] G=[0,0] B=[0,1]
    const fgr = new Float32Array([1, 0, 0, 0, 0, 1]);
    expect(foregroundMean(fgr, new Float32Array([0.9, 0.1]), 2)).toEqual([1, 0, 0]);
    expect(foregroundMean(fgr, new Float32Array([0.1, 0.2]), 2)).toBeNull();
  });
});

describe('colorMatchGains', () => {
  it('前景与背景色调一致时不调整', () => {
    const g = colorMatchGains([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    g.forEach((v) => expect(v).toBeCloseTo(1, 5));
  });
  it('背景偏暖时红通道增益 >1、蓝通道 <1', () => {
    const [r, , b] = colorMatchGains([0.5, 0.5, 0.5], [0.6, 0.5, 0.35]);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
  });
  it('背景更亮时整体增益 >1；每个通道限制在 0.85–1.15', () => {
    const lum = colorMatchGains([0.3, 0.3, 0.3], [0.6, 0.6, 0.6]);
    lum.forEach((v) => expect(v).toBeGreaterThan(1));
    const extreme = colorMatchGains([0.9, 0.1, 0.1], [0.1, 0.1, 0.9], 1, 1);
    extreme.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0.85); expect(v).toBeLessThanOrEqual(1.15); });
  });
  it('强度为 0 时不调整', () => {
    colorMatchGains([0.3, 0.4, 0.5], [0.6, 0.5, 0.2], 0, 0).forEach((v) => expect(v).toBeCloseTo(1, 5));
  });
});

describe('compositeFrame', () => {
  it('按 alpha 混合前景（乘增益）与背景，结果四舍五入并截到 0–255', () => {
    // 2 个像素：第 1 个全前景，第 2 个全背景
    const fgr = new Float32Array([1, 0.5, 0, 0, 0.5, 0]); // R=[1,0.5] G=[0,0] B=[0.5,0]
    const pha = new Float32Array([1, 0]);
    const bg = Buffer.from([10, 20, 30, 40, 50, 60]);
    const out = Buffer.alloc(6);
    compositeFrame(fgr, pha, bg, [1.1, 1, 1], out);
    expect([...out]).toEqual([255, 0, 128, 40, 50, 60]);
  });
  it('半透明时线性混合', () => {
    const out = Buffer.alloc(3);
    compositeFrame(new Float32Array([1, 1, 1]), new Float32Array([0.5]), Buffer.from([0, 0, 0]), [1, 1, 1], out);
    expect([...out]).toEqual([128, 128, 128]);
  });
});

describe('alphaBox / medianBox', () => {
  it('alpha>0.5 的像素外接框（归一化）；全背景返回 null', () => {
    // 4×2：前景在 (1,0) 与 (2,1)
    const pha = new Float32Array([0, 1, 0, 0, 0, 0, 1, 0]);
    expect(alphaBox(pha, 4, 2)).toEqual({ top: 0, bottom: 1, left: 0.25, right: 0.75 });
    expect(alphaBox(new Float32Array(8), 4, 2)).toBeNull();
  });
  it('逐边取中位数；空数组返回 null', () => {
    const boxes = [
      { top: 0.1, bottom: 0.9, left: 0.2, right: 0.8 },
      { top: 0.3, bottom: 1, left: 0.1, right: 0.7 },
      { top: 0.2, bottom: 0.8, left: 0.3, right: 0.9 },
    ];
    expect(medianBox(boxes)).toEqual({ top: 0.2, bottom: 0.9, left: 0.2, right: 0.8 });
    expect(medianBox([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/composite.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/matting/composite.ts
export type Rgb = readonly [number, number, number];
/** 人物在画面中的范围（0–1，相对宽高），供 P3 取景「下半屏人像」 */
export interface SubjectBox { top: number; bottom: number; left: number; right: number }

/** RVM 建议推理分辨率的长边在 256–512：长边缩到 512，小视频不放大 */
const TARGET_LONG_SIDE = 512;
/** 每个通道增益的上下限，避免把人调成别的颜色 */
const MIN_GAIN = 0.85;
const MAX_GAIN = 1.15;

export function chooseDownsample(width: number, height: number): number {
  return Math.min(1, TARGET_LONG_SIDE / Math.max(width, height));
}

const luma = ([r, g, b]: Rgb): number => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function meanRgb(rgb: Uint8Array | Buffer): Rgb {
  const sum = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 1) sum[i % 3] += rgb[i];
  const n = rgb.length / 3;
  return [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255];
}

/** fgr 为 RVM 输出的平面 CHW（0–1）；只统计 alpha>0.5 的像素 */
export function foregroundMean(fgr: Float32Array, pha: Float32Array, pixels: number): Rgb | null {
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < pixels; i += 1) {
    if (pha[i] <= 0.5) continue;
    sum[0] += fgr[i];
    sum[1] += fgr[pixels + i];
    sum[2] += fgr[2 * pixels + i];
    n += 1;
  }
  return n === 0 ? null : [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** 人物朝背景靠拢的逐通道增益：白平衡按「色度比」的 wbStrength 次方、亮度按「亮度比」的 lumStrength 次方，各通道限制在 0.85–1.15 */
export function colorMatchGains(fg: Rgb, bg: Rgb, wbStrength = 0.3, lumStrength = 0.2): Rgb {
  const fgL = Math.max(luma(fg), 1e-4);
  const bgL = Math.max(luma(bg), 1e-4);
  const lumGain = (bgL / fgL) ** lumStrength;
  const gain = (c: 0 | 1 | 2): number => {
    const ratio = (bg[c] / bgL) / Math.max(fg[c] / fgL, 1e-4);
    return clamp(Math.max(ratio, 1e-4) ** wbStrength * lumGain, MIN_GAIN, MAX_GAIN);
  };
  return [gain(0), gain(1), gain(2)];
}

/** out = alpha·(fgr·增益) + (1−alpha)·背景；fgr 平面 CHW 0–1，bg/out 为 rgb24 交错 */
export function compositeFrame(fgr: Float32Array, pha: Float32Array, bg: Buffer, gains: Rgb, out: Buffer): void {
  const pixels = pha.length;
  for (let i = 0; i < pixels; i += 1) {
    const a = pha[i];
    for (let c = 0; c < 3; c += 1) {
      const fg = fgr[c * pixels + i] * gains[c] * 255;
      out[i * 3 + c] = clamp(Math.round(a * fg + (1 - a) * bg[i * 3 + c]), 0, 255);
    }
  }
}

/** alpha>threshold 的像素外接框（归一化到 0–1，right/bottom 取像素右/下边界）；没有前景返回 null */
export function alphaBox(pha: Float32Array, width: number, height: number, threshold = 0.5): SubjectBox | null {
  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pha[y * width + x] <= threshold) continue;
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      left = Math.min(left, x); right = Math.max(right, x);
    }
  }
  if (bottom < 0) return null;
  return { top: top / height, bottom: (bottom + 1) / height, left: left / width, right: (right + 1) / width };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 逐边取中位数，抗个别帧抠像抖动 */
export function medianBox(boxes: SubjectBox[]): SubjectBox | null {
  if (boxes.length === 0) return null;
  return { top: median(boxes.map((b) => b.top)), bottom: median(boxes.map((b) => b.bottom)), left: median(boxes.map((b) => b.left)), right: median(boxes.map((b) => b.right)) };
}
```

注意测试里 `alphaBox` 的期望：4×2、前景 (x=1,y=0) 与 (x=2,y=1) → top 0、bottom (1+1)/2=1、left 1/4=0.25、right (2+1)/4=0.75。`compositeFrame` 第一像素：R=1×1.1×255=280.5→截到 255，G=0，B=0.5×255=127.5→128。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/composite.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/matting/composite.ts tests/composite.test.ts
git commit -m "feat: 抠像合成纯函数（下采样、色温亮度匹配、逐帧合成、人物取景框）"
```

---

### Task 4: RVM 抠像执行器与模型下载

**Files:**
- Create: `src/matting/rvm.ts`
- Modify: `package.json`（加依赖 `"onnxruntime-node": "1.20.1"`）、`scripts/fetch-models.mjs`（加 RVM 下载与 sha256 校验）
- Test: `tests/rvm.test.ts`、`tests/helpers/models.ts`（加 `hasRvm`）

**Interfaces:**
- Consumes: Task 2 `loadBackgroundRgb`；Task 3 全部函数；`probe`（`src/media/probe.ts`，返回 `MediaInfo { durationSec, width, height, fps, hasAudio }`）；`AppConfig.modelsDir`
- Produces:
  - `export const RVM_FILE = 'rvm_mobilenetv3_fp32.onnx'`
  - `export function rvmReady(modelsDir: string): boolean`
  - `export interface MatteOptions { input: string; output: string; backgroundPath: string; cfg: AppConfig; blurSigma?: number; colorMatch?: boolean; onProgress?: (done: number, total: number) => void }`
  - `export interface MatteResult { frames: number; subject: SubjectBox | null; gains: Rgb; fps: number }`
  - `export async function matteVideo(opts: MatteOptions): Promise<MatteResult>`

- [ ] **Step 1: 安装依赖与下载模型**

```bash
pnpm add onnxruntime-node@1.20.1
```

`scripts/fetch-models.mjs` 在 `console.log(\`模型就绪…\`)` 之前加入（并在文件顶部 import 处加 `import { createHash } from 'node:crypto';` 与 `import { readFileSync } from 'node:fs';`——若已从 `node:fs` 导入则合并到同一行）：

```js
// RobustVideoMatting（抠像），GitHub release v1.0.0；下载后校验 sha256
const RVM = 'rvm_mobilenetv3_fp32.onnx';
const RVM_SHA256 = '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828';
if (!existsSync(join(dir, RVM))) {
  await download(`https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/${RVM}`, join(dir, RVM));
  const sha = createHash('sha256').update(readFileSync(join(dir, RVM))).digest('hex');
  if (sha !== RVM_SHA256) { rmSync(join(dir, RVM), { force: true }); throw new Error(`${RVM} 校验失败：${sha}`); }
}
```

Run: `pnpm fetch-models && ls -la ~/.mingzhi/models/rvm_mobilenetv3_fp32.onnx`
Expected: 文件约 15MB

`tests/helpers/models.ts` 追加：

```ts
import { rvmReady } from '../../src/matting/rvm.js';
export const hasRvm = (): boolean => rvmReady(loadConfig({}).modelsDir);
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/rvm.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { presetPath } from '../src/background/presets.js';
import { matteVideo, rvmReady } from '../src/matting/rvm.js';
import { hasRvm } from './helpers/models.js';

describe('rvmReady', () => {
  it('模型文件不存在时为 false', () => {
    expect(rvmReady(mkdtempSync(join(tmpdir(), 'mz-none-')))).toBe(false);
  });
});

describe.skipIf(!hasRvm())('matteVideo（需要 RVM 模型）', () => {
  it('输出与输入同尺寸、同时长、30fps、保留音轨，并报告进度与取景框', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-rvm-'));
    const input = join(dir, 'in.mp4');
    // 1.5 秒 180×320：灰底上一个移动的肤色圆（RVM 可能抠出也可能抠不出，断言不依赖抠像结果）
    await run(cfg.ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x808080:s=180x320:r=30:d=1.5,drawbox=x=50+t*20:y=80:w=80:h=160:color=0xd8a080:t=fill',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
    const output = join(dir, 'out.mp4');
    const progress: number[] = [];
    const res = await matteVideo({ input, output, backgroundPath: presetPath('cafe'), cfg, onProgress: (done) => progress.push(done) });
    const info = await probe(output, cfg);
    expect(info.width).toBe(180);
    expect(info.height).toBe(320);
    expect(info.fps).toBe(30);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.durationSec - 1.5)).toBeLessThan(0.1);
    expect(res.frames).toBe(45);
    expect(progress[progress.length - 1]).toBe(45);
    expect(res.gains).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/rvm.test.ts`
Expected: FAIL（找不到模块 `../src/matting/rvm.js`）

- [ ] **Step 4: Write minimal implementation**

```ts
// src/matting/rvm.ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ort from 'onnxruntime-node';
import type { AppConfig } from '../config.js';
import { loadBackgroundRgb } from '../background/prepare.js';
import { probe } from '../media/probe.js';
import { alphaBox, chooseDownsample, colorMatchGains, compositeFrame, foregroundMean, meanRgb, medianBox, type Rgb, type SubjectBox } from './composite.js';

export const RVM_FILE = 'rvm_mobilenetv3_fp32.onnx';
const OUT_FPS = 30;
/** 估计人物平均色时抽取的帧数 */
const SAMPLE_FRAMES = 8;
/** 每隔多少帧记录一次取景框与进度 */
const BOX_EVERY = 15;
const DEFAULT_BLUR = 6;

export interface MatteOptions { input: string; output: string; backgroundPath: string; cfg: AppConfig; blurSigma?: number; colorMatch?: boolean; onProgress?: (done: number, total: number) => void }
export interface MatteResult { frames: number; subject: SubjectBox | null; gains: Rgb; fps: number }

export function rvmReady(modelsDir: string): boolean {
  return existsSync(join(modelsDir, RVM_FILE));
}

type Recurrent = Record<'r1i' | 'r2i' | 'r3i' | 'r4i', ort.Tensor>;
const zeroState = (): Recurrent => {
  const z = (): ort.Tensor => new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]);
  return { r1i: z(), r2i: z(), r3i: z(), r4i: z() };
};

/** 一个 RVM 推理会话：保存循环状态，逐帧推理（rgb24 交错 → fgr 平面 CHW 与 pha） */
class RvmSession {
  private state = zeroState();
  private readonly src: Float32Array;
  private readonly dsr: ort.Tensor;
  private constructor(private readonly session: ort.InferenceSession, private readonly w: number, private readonly h: number) {
    this.src = new Float32Array(3 * w * h);
    this.dsr = new ort.Tensor('float32', new Float32Array([chooseDownsample(w, h)]), [1]);
  }
  static async create(modelsDir: string, w: number, h: number): Promise<RvmSession> {
    if (!rvmReady(modelsDir)) throw new Error(`缺少抠像模型 ${RVM_FILE}，请先运行 pnpm fetch-models`);
    const session = await ort.InferenceSession.create(join(modelsDir, RVM_FILE), { executionProviders: ['cpu'] });
    return new RvmSession(session, w, h);
  }
  async infer(rgb: Buffer): Promise<{ fgr: Float32Array; pha: Float32Array }> {
    const plane = this.w * this.h;
    for (let i = 0; i < plane; i += 1) {
      this.src[i] = rgb[i * 3] / 255;
      this.src[plane + i] = rgb[i * 3 + 1] / 255;
      this.src[2 * plane + i] = rgb[i * 3 + 2] / 255;
    }
    const o = await this.session.run({ src: new ort.Tensor('float32', this.src, [1, 3, this.h, this.w]), ...this.state, downsample_ratio: this.dsr });
    this.state = { r1i: o.r1o, r2i: o.r2o, r3i: o.r3o, r4i: o.r4o };
    return { fgr: o.fgr.data as Float32Array, pha: o.pha.data as Float32Array };
  }
  reset(): void {
    this.state = zeroState();
  }
}

/** 启动 ffmpeg 解码为 rgb24 原始帧流 */
function decoder(cfg: AppConfig, input: string, vf: string): ChildProcessWithoutNullStreams {
  return spawn(cfg.ffmpeg, ['-v', 'error', '-i', input, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
}

/** 进程结束；非 0 退出时带 stderr 报错 */
function exited(p: ChildProcessWithoutNullStreams, name: string): Promise<void> {
  let stderr = '';
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  return new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} 失败（退出码 ${code}）：${stderr.slice(-800)}`))));
  });
}

/** 从 rgb24 流里按整帧切出，逐帧回调（回调可 await，以此形成背压） */
async function forEachFrame(p: ChildProcessWithoutNullStreams, frameBytes: number, onFrame: (frame: Buffer) => Promise<void>): Promise<void> {
  let pending = Buffer.alloc(0);
  for await (const chunk of p.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= frameBytes) {
      await onFrame(Buffer.from(pending.subarray(0, frameBytes)));
      pending = pending.subarray(frameBytes);
    }
  }
}

/** 均匀抽 SAMPLE_FRAMES 帧逐帧独立推理，估计人物平均色；抠不出人时返回 null */
async function sampleForeground(rvm: RvmSession, opts: MatteOptions, w: number, h: number, durationSec: number): Promise<Rgb | null> {
  const p = decoder(opts.cfg, opts.input, `fps=${SAMPLE_FRAMES / Math.max(durationSec, 0.1)}`);
  const done = exited(p, '抽帧');
  const means: Rgb[] = [];
  await forEachFrame(p, w * h * 3, async (frame) => {
    rvm.reset();
    const { fgr, pha } = await rvm.infer(frame);
    const m = foregroundMean(fgr, pha, w * h);
    if (m) means.push(m);
  });
  await done;
  rvm.reset();
  if (means.length === 0) return null;
  return [0, 1, 2].map((c) => means.reduce((s, m) => s + m[c], 0) / means.length) as unknown as Rgb;
}

/** 整段抠像换背景：解码 → RVM → 合成 → x264 编码（30fps），音轨从输入直接拷贝 */
export async function matteVideo(opts: MatteOptions): Promise<MatteResult> {
  const media = await probe(opts.input, opts.cfg);
  const { width: w, height: h } = media;
  const rvm = await RvmSession.create(opts.cfg.modelsDir, w, h);
  const bg = await loadBackgroundRgb(opts.backgroundPath, w, h, opts.blurSigma ?? DEFAULT_BLUR, opts.cfg);
  const fgMean = opts.colorMatch === false ? null : await sampleForeground(rvm, opts, w, h, media.durationSec);
  const gains: Rgb = fgMean ? colorMatchGains(fgMean, meanRgb(bg)) : [1, 1, 1];
  const total = Math.round(media.durationSec * OUT_FPS);

  const dec = decoder(opts.cfg, opts.input, `fps=${OUT_FPS}`);
  const enc = spawn(opts.cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(OUT_FPS), '-i', '-',
    '-i', opts.input, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', opts.output]);
  const decDone = exited(dec, '解码');
  const encDone = exited(enc, '编码');
  const out = Buffer.alloc(w * h * 3);
  const boxes: SubjectBox[] = [];
  let frames = 0;
  await forEachFrame(dec, w * h * 3, async (frame) => {
    const { fgr, pha } = await rvm.infer(frame);
    compositeFrame(fgr, pha, bg, gains, out);
    if (!enc.stdin.write(Buffer.from(out))) await new Promise((r) => enc.stdin.once('drain', r));
    frames += 1;
    if (frames % BOX_EVERY === 0) {
      const box = alphaBox(pha, w, h);
      if (box) boxes.push(box);
      opts.onProgress?.(frames, total);
    }
  });
  await decDone;
  enc.stdin.end();
  await encDone;
  opts.onProgress?.(frames, total);
  return { frames, subject: medianBox(boxes), gains, fps: OUT_FPS };
}
```

注意：`onProgress` 最后一次调用传入实际帧数，测试断言 `progress` 最后一个值为 45（1.5 秒 × 30fps）。若 ffmpeg `fps=30` 对 1.5 秒输入产出 45±1 帧，以实测为准把测试里的 45 改成 `res.frames` 并单独断言 `Math.abs(res.frames - 45) <= 1`——在 Step 5 观察到再改，不要预先放宽。

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/rvm.test.ts && pnpm typecheck`
Expected: PASS（本机已下载模型时实际跑 RVM；未下载时 `matteVideo` 用例被跳过，`rvmReady` 用例通过）

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/fetch-models.mjs src/matting/rvm.ts tests/rvm.test.ts tests/helpers/models.ts
git commit -m "feat: RVM 本地抠像换背景（色温匹配、背景虚化、人物取景框）"
```

---

### Task 5: 接入出片流程与命令行

**Files:**
- Modify: `src/pipeline/project.ts`、`src/pipeline/run.ts`、`src/cli.ts`
- Test: `tests/pipeline.test.ts`（追加）、`tests/cli-paths.test.ts`（不改）

**Interfaces:**
- Consumes: Task 1 `KexiangTaskClient`、`TaskClient`；Task 2 `BackgroundSpec`、`parseBackgroundArgs`、`resolveBackground`、`PRESETS`；Task 4 `matteVideo`、`MatteResult`；Task 3 `SubjectBox`
- Produces:
  - `PipelineStep` 增加 `'background' | 'matte'`（顺序：`… render → background → matte → captions → burn → done`）
  - `PipelineArgs` 增加 `background?: BackgroundSpec; task?: TaskClient`
  - `ProjectFile` 增加 `background?: { spec: BackgroundSpec; path: string }; subject?: SubjectBox | null`；`ProjectArtifacts` 增加 `person?: string`
  - CLI：`pnpm mingzhi edit <视频> [-o 输出] [--work 目录] [--bg 预设id|图片路径] [--bg-prompt 一句话]`

- [ ] **Step 1: Write the failing test**

在 `tests/pipeline.test.ts` 顶部 import 增加 `import { hasRvm } from './helpers/models.js';`（与 `hasModels` 合并为同一行导入），文件末尾追加：

```ts
describe.skipIf(!hasModels() || !hasRvm())('runPipeline 换背景（需要 ASR 与 RVM 模型）', () => {
  it('剪切后抠像换背景再烧录字幕；project.json 记录背景、取景框与 person 中间文件；进度含 background、matte', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-p2-'));
    const output = join(workDir, 'out.mp4');
    const llm: LlmClient = { chatJson: async (o) => (o.system.includes('字幕') ? { lines: ['我平时经常在 GitHub 上面'] } : { cuts: [] }) };
    const steps: string[] = [];
    await runPipeline({ input: 'tests/fixtures/talk.mp4', workDir, output, cfg, llm, background: { kind: 'preset', id: 'study' }, onProgress: (e: ProgressEvent) => steps.push(e.step) });
    expect(steps).toEqual(['probe', 'audio', 'asr', 'cuts', 'plan', 'render', 'background', 'matte', 'captions', 'burn', 'done']);
    const project = JSON.parse(readFileSync(join(workDir, 'project.json'), 'utf8')) as ProjectFile;
    expect(project.background?.spec).toEqual({ kind: 'preset', id: 'study' });
    expect(project.artifacts.person).toBe(join(workDir, 'person.mp4'));
    expect(existsSync(join(workDir, 'person.mp4'))).toBe(true);
    expect('subject' in project).toBe(true);
    const info = await probe(output, cfg);
    expect(info.hasAudio).toBe(true);
  });
});
```

（假 LLM 的字幕返回只有一行，对齐后的 matchedRatio 可能低于 0.8 而整体兜底——这不影响本测试的断言。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/pipeline.test.ts`
Expected: FAIL（`background` 不是 PipelineArgs 的字段 / 步骤里没有 background、matte）

- [ ] **Step 3: Write minimal implementation**

`src/pipeline/project.ts`：

```ts
// 顶部 import 增加
import type { BackgroundSpec } from '../background/resolve.js';
import type { SubjectBox } from '../matting/composite.js';

// ProjectArtifacts 改为
export interface ProjectArtifacts { wav?: string; cut?: string; person?: string; ass?: string; output?: string }

// ProjectFile 在 captions 字段后增加
  /** 换背景：背景来源与落地的图片路径（P2） */
  background?: { spec: BackgroundSpec; path: string };
  /** 人物在画面中的范围（中位数，0–1），供 P3 取景；抠不出人时为 null */
  subject?: SubjectBox | null;
```

`src/pipeline/run.ts`：

```ts
// import 增加
import { resolveBackground, type BackgroundSpec } from '../background/resolve.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { matteVideo } from '../matting/rvm.js';

// 类型改为
export type PipelineStep = 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'background' | 'matte' | 'captions' | 'burn' | 'done';
export interface PipelineArgs { input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; background?: BackgroundSpec; task?: TaskClient; onProgress?: (e: ProgressEvent) => void }

/** 换背景：落地背景图 → 抠像合成到 person.mp4；返回之后要烧字幕的视频 */
async function replaceBackground(args: PipelineArgs, cut: string, complete: Complete): Promise<string> {
  if (!args.background) return cut;
  const bg = await resolveBackground(args.background, args.workDir, args.task);
  complete('background', `背景：${describeBackground(bg.spec)}`, { background: { spec: bg.spec, path: bg.path } });
  const person = join(args.workDir, 'person.mp4');
  const started = Date.now();
  const res = await matteVideo({ input: cut, output: person, backgroundPath: bg.path, cfg: args.cfg });
  const secs = Math.max((Date.now() - started) / 1000, 0.001);
  complete('matte', `抠像换背景完成 · ${res.frames} 帧 · ${(res.frames / secs).toFixed(1)} 帧/秒`, { subject: res.subject, artifacts: { person } });
  return person;
}

const describeBackground = (spec: BackgroundSpec): string =>
  spec.kind === 'preset' ? (PRESETS.find((p) => p.id === spec.id)?.name ?? spec.id) : spec.kind === 'file' ? spec.path : `生成「${spec.prompt}」`;
```

（`PRESETS` 从 `../background/presets.js` 导入。）

在 `produce` 里把 `await renderCut(...)` 之后、字幕之前改为：

```ts
  const cut = join(workDir, 'cut.mp4');
  await renderCut(input, a.plan.keep, cut, cfg);
  complete('render', '剪切完成', { artifacts: { cut } });
  const base = await replaceBackground(args, cut, complete);
```

并把最后的 `await burnSubtitles(cut, ass, output, cfg);` 改为 `await burnSubtitles(base, ass, output, cfg);`。

`src/cli.ts`：

```ts
import { parseBackgroundArgs } from './background/resolve.js';
import { KexiangTaskClient } from './llm/kexiang-task.js';

const USAGE = '用法：pnpm mingzhi edit <口播视频> [-o 输出.mp4] [--work 工作目录] [--bg 预设id|背景图片] [--bg-prompt 一句话描述背景]';

// parseArgs 的 options 增加：bg: { type: 'string' }, 'bg-prompt': { type: 'string' }
// main() 里 resolveCliPaths 之后：
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const background = parseBackgroundArgs(values.bg, values['bg-prompt'], baseDir);
  const task = background?.kind === 'prompt' ? new KexiangTaskClient(cfg.kexiangKey ?? '') : undefined;
// runPipeline 调用增加 background, task
```

（`resolveCliPaths` 现有调用里用到的 `process.env.INIT_CWD ?? process.cwd()` 改为复用 `baseDir` 变量。）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm typecheck && pnpm test`
Expected: 全部 PASS（本机有模型时新用例实际运行）

- [ ] **Step 5: 手动冒烟**

```bash
source <可想 key 的 env 文件> && pnpm mingzhi edit tests/fixtures/talk.mp4 --work work/p2-smoke --bg library
```
Expected: 进度依次出现 `[background] 背景：图书馆`、`[matte] 抠像换背景完成 · … 帧/秒`，`work/p2-smoke/talk_精剪.mp4` 存在。

- [ ] **Step 6: Commit**

```bash
git add src/pipeline src/cli.ts tests/pipeline.test.ts
git commit -m "feat: 出片流程接入换背景（--bg 预设或图片、--bg-prompt 一句话生成）"
```

---

## 验收（控制者执行，不派子 agent）

用 `work/raw1/raw1.mp4`（132 秒生口播）分别跑 `--bg study`、`--bg tech-dark`、`--bg-prompt "明亮的现代办公室"`：记录抠像速度、色温匹配前后对比截图、取景框数值、生成背景的实际花费，写入 `docs/acceptance/p2.md`。
