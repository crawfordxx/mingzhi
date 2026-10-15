# P3a 分镜与成片渲染核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P1 精剪 + P2 换背景之后，由 Gemini 根据字幕生成 JSON 分镜，用 Remotion 渲染出「上半屏信息卡 + 下半屏人像 + 分界线字幕 + 开头钩子卡 + 结尾 CTA」的 1080×1920 成片。

**Architecture:** Node 侧（`src/storyboard/`、`src/compose/`）负责分镜生成、校验归一化与调用 `@remotion/renderer`；浏览器侧（`render/`，React + Remotion）只做帧驱动的画面：人像层（按 P2 的人物取景框在下半屏取景，分屏/全屏切换时平滑过渡）、卡片层（12 个模板，按分镜进出场）、字幕层。两侧共用 `src/storyboard/schema.ts` 的 zod 模式与类型。渲染时把工作目录当作 Remotion 的 publicDir，人像视频与 B-roll 图片都用 `staticFile()` 取。

**Tech Stack:** remotion / @remotion/bundler / @remotion/renderer 4.0.531（钉死），react / react-dom 18.3.1，zod，vitest

**Spec:** `docs/DECISIONS.md`（成片标准、渲染、出片管线第 3、5 条、语言模型）、`docs/superpowers/plans/2026-10-14-roadmap.md` 的 P3 行。P3 拆成 P3a（本计划：分镜 + 模板 + 渲染）、P3b（B-roll 素材获取）、P3c（配乐音效、封面、字幕样式预设与字体）。

## Global Constraints

- 成片标准：以 `~/workspace/小马学长AI/第2期/成片_B_换背景.mp4` 为黄金样本（1080×1920 · 上半屏信息卡 + 下半屏换背景人像 · 烧录字幕 · 开头 3 张钩子卡 · 结尾三连 CTA）
- 输出 v1 只做 9:16：1080×1920、30fps、h264 + aac
- 版式（实测参考片）：分界线在 y=960；分屏时 0–960 是卡片区（米色底），960–1920 是人像；字幕压在分界线上（中心约 y=960）；全屏时人物铺满，字幕在 y≈1400
- 渲染：Remotion（React），成片动画全部帧驱动（`useCurrentFrame` / `spring` / `interpolate`），不用 CSS transition、不用 motion.dev
- 实测：Remotion 4.0.531 在本机 concurrency 8 渲染 1080×1920 约 53 帧/秒；首次运行自动下载 Chrome Headless Shell（约 94MB）
- 实测：`@remotion/bundler` 的 `webpackOverride` 加 `resolve.extensionAlias: { '.js': ['.ts', '.tsx', '.js'] }` 后，`render/` 可以用本仓库的 `.js` 后缀导入 `src/` 的 TS 文件
- 分镜/卡片文案模型：`google/gemini-3.5-flash`，**必须 `reasoning_effort: low`**
- 模板库首批 12 个；模板表达不了的镜头由 AI 生成自定义组件的能力放到 P4（需要视觉自检）
- 视觉语言（参考片实测）：卡片区底色 `#EFEBE5`；白卡片圆角 28、柔和阴影；标签色 成本 `#C8891A`、收益 `#2F9E58`、证据 `#2F6FE0`、来源 `#7B4FD6`；警示红 `#E04848`、金 `#C8891A`；钩子卡深色照片底 + 荧光黄绿 `#D4F23C` 高亮；终端窗深色 `#1E1E1E` + 红黄绿三点；面包屑「• 第 2 节第 7 条 · 证据 A」橙点 `#F06A2A`
- 字幕默认样式：PingFang SC（P3c 再换打包字体）、白字 64px、字重 800、黑描边 10px（`WebkitTextStroke` + `paintOrder: 'stroke fill'`）、每行 ≤14 字
- 参考帧（仅本机，不入库，含真人）：`/private/tmp/claude-501/-Users-crawford-workspace-mingzhi/33f03909-6312-4bc7-87c5-6cf211a66a30/scratchpad/ref/`（`top-*.png` 为各类卡片的上半屏 540×480 截图，`sheet.png` 为每 4 秒一帧总览）
- 代码注释、报错、commit 用中文；commit 格式 `<type>: <描述>`，不加任何署名行；文件 < 400 行；函数 < 50 行；不可变数据
- 不提交任何 key；不提交含真人的参考帧

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/storyboard/schema.ts`（新） | 12 个模板的 props 模式、`CardSpec`、`Shot`、`Storyboard`、`TalkProps` 与常量 |
| `src/storyboard/normalize.ts`（新） | 模型分镜 → 合法、连续、覆盖全片的分镜（纯函数） |
| `src/storyboard/catalog.ts`（新） | 模板目录（id、何时用、props 说明），供提示词 |
| `src/storyboard/generate.ts`（新） | 调 Gemini 生成分镜并归一化 |
| `src/compose/layout.ts`（新） | 人像取景纯函数（分屏/全屏的缩放与位移） |
| `src/compose/render.ts`（新） | bundle + selectComposition + renderMedia 封装 |
| `render/index.ts`、`render/Root.tsx`、`render/Talk.tsx`（新） | Remotion 入口与主合成 |
| `render/layers/PersonLayer.tsx`、`CaptionLayer.tsx`、`CardLayer.tsx`（新） | 三个图层 |
| `render/theme.ts`（新） | 颜色、字体、圆角、阴影常量 |
| `render/templates/*.tsx`、`render/templates/index.ts`（新） | 12 个模板与注册表 |
| `src/pipeline/*`、`src/cli.ts`（改） | 新增 storyboard、compose 步骤，替换 burn |
| `tsconfig.json`（改） | 加 `render`、`jsx: react-jsx`、DOM lib |

---

### Task 1: 分镜模式与归一化

**Files:**
- Create: `src/storyboard/schema.ts`、`src/storyboard/normalize.ts`
- Test: `tests/storyboard.test.ts`

**Interfaces:**
- Consumes: `TimedCaption`（`src/captions/lines.ts`：`{ start, end, text }`，成片时间轴秒）、`SubjectBox`（`src/matting/composite.ts`：`{ top, bottom, left, right }` 0–1）
- Produces（全部从 `src/storyboard/schema.ts` 导出）：
  - `export const CANVAS = { width: 1080, height: 1920, fps: 30, seam: 960 } as const`
  - `export const TEMPLATE_IDS = ['hook','title','bigNumber','chips','compareBars','evidenceList','terminal','toggles','strikeList','browser','photo','cta'] as const`
  - `export type TemplateId = (typeof TEMPLATE_IDS)[number]`
  - `export const CardSpecSchema`（zod 判别联合，按 `template` 字段）与 `export type CardSpec`
  - `export const ShotSchema`、`export type Shot = { start: number; end: number; layout: 'split' | 'full'; card?: CardSpec }`
  - `export interface Storyboard { shots: Shot[] }`
  - `export interface TalkProps { person: string; personWidth: number; personHeight: number; subject: SubjectBox | null; captions: TimedCaption[]; shots: Shot[]; durationSec: number }`
  - `export const MIN_SHOT_SEC = 1`、`export const HOOK_WINDOW_SEC = 15`
- 从 `src/storyboard/normalize.ts`：`export interface NormalizeResult { storyboard: Storyboard; dropped: number }`、`export function normalizeStoryboard(raw: unknown, durationSec: number, availableImages: string[]): NormalizeResult`

- [ ] **Step 1: Write the failing test**

```ts
// tests/storyboard.test.ts
import { describe, expect, it } from 'vitest';
import { CardSpecSchema, TEMPLATE_IDS } from '../src/storyboard/schema.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';

const title = (t: string) => ({ template: 'title', props: { title: t } });

describe('CardSpecSchema', () => {
  it('12 个模板 id', () => {
    expect(TEMPLATE_IDS).toHaveLength(12);
  });
  it('按 template 校验各自的 props；未知模板或缺字段不通过', () => {
    expect(CardSpecSchema.safeParse(title('你好')).success).toBe(true);
    expect(CardSpecSchema.safeParse({ template: 'hook', props: { index: 1, total: 3, headline: '吃抗氧化剂的人死亡率反而略高', highlight: ['略高'] } }).success).toBe(true);
    expect(CardSpecSchema.safeParse({ template: 'compareBars', props: { items: [{ name: '甜饮料', value: 0.8, tone: 'bad' }] } }).success).toBe(true);
    expect(CardSpecSchema.safeParse({ template: 'compareBars', props: { items: [{ name: '甜饮料', value: 1.8, tone: 'bad' }] } }).success).toBe(false);
    expect(CardSpecSchema.safeParse({ template: 'nope', props: {} }).success).toBe(false);
    expect(CardSpecSchema.safeParse({ template: 'title', props: {} }).success).toBe(false);
  });
});

describe('normalizeStoryboard', () => {
  it('排序、截到片长、补齐空隙为全屏、首尾对齐 0 与片长', () => {
    const raw = { shots: [
      { start: 5, end: 9, layout: 'split', card: title('B') },
      { start: 0.4, end: 4, layout: 'split', card: title('A') },
      { start: 12, end: 30, layout: 'split', card: title('C') },
    ] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 20, []);
    expect(dropped).toBe(0);
    expect(storyboard.shots.map((s) => [s.start, s.end, s.layout, s.card?.template ?? null])).toEqual([
      [0, 0.4, 'full', null],
      [0.4, 4, 'split', 'title'],
      [4, 5, 'full', null],
      [5, 9, 'split', 'title'],
      [9, 12, 'full', null],
      [12, 20, 'split', 'title'],
    ]);
  });
  it('重叠时后一个从前一个结束处开始；短于 1 秒的镜头并入前一个；卡片 props 不合法的镜头丢弃并计数', () => {
    const raw = { shots: [
      { start: 0, end: 6, layout: 'split', card: title('A') },
      { start: 5, end: 6.5, layout: 'split', card: title('B') },
      { start: 6.5, end: 10, layout: 'split', card: { template: 'title', props: {} } },
    ] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 10, []);
    expect(dropped).toBe(1);
    expect(storyboard.shots.map((s) => [s.start, s.end, s.card?.props])).toEqual([
      [0, 6.5, { title: 'A' }],
      [6.5, 10, undefined],
    ]);
  });
  it('photo 引用的图片不在可用列表时丢弃该镜头；browser 的图片不可用时去掉图片保留镜头', () => {
    const raw = { shots: [
      { start: 0, end: 3, layout: 'split', card: { template: 'photo', props: { image: 'broll/a.jpg' } } },
      { start: 3, end: 6, layout: 'split', card: { template: 'browser', props: { url: 'github.com/x', image: 'broll/b.png' } } },
      { start: 6, end: 9, layout: 'split', card: { template: 'photo', props: { image: 'broll/c.jpg' } } },
    ] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 9, ['broll/c.jpg']);
    expect(dropped).toBe(1);
    expect(storyboard.shots[1].card).toEqual({ template: 'browser', props: { url: 'github.com/x' } });
    expect(storyboard.shots[2].card).toEqual({ template: 'photo', props: { image: 'broll/c.jpg' } });
  });
  it('hook 只允许出现在前 15 秒且最多 3 张；cta 只允许在最后一个镜头并强制全屏', () => {
    const hook = (i: number) => ({ template: 'hook', props: { index: i, total: 3, headline: `钩子${i}` , highlight: [] } });
    const raw = { shots: [
      { start: 0, end: 4, layout: 'split', card: hook(1) },
      { start: 4, end: 8, layout: 'split', card: hook(2) },
      { start: 8, end: 12, layout: 'split', card: hook(3) },
      { start: 12, end: 14, layout: 'split', card: hook(4) },
      { start: 16, end: 20, layout: 'split', card: hook(5) },
      { start: 20, end: 24, layout: 'split', card: { template: 'cta', props: { actions: ['关注'] } } },
      { start: 24, end: 30, layout: 'split', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } } },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 30, []);
    const templates = storyboard.shots.map((s) => s.card?.template ?? null);
    expect(templates.filter((t) => t === 'hook')).toHaveLength(3);
    expect(templates.filter((t) => t === 'cta')).toHaveLength(1);
    expect(storyboard.shots[storyboard.shots.length - 1]).toMatchObject({ layout: 'full', card: { template: 'cta' } });
  });
  it('模型输出不是 {shots:[]} 时返回整片全屏一个镜头', () => {
    expect(normalizeStoryboard({ nope: 1 }, 12, []).storyboard.shots).toEqual([{ start: 0, end: 12, layout: 'full' }]);
    expect(normalizeStoryboard(null, 12, []).storyboard.shots).toEqual([{ start: 0, end: 12, layout: 'full' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/storyboard.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/storyboard/schema.ts
import { z } from 'zod';
import type { TimedCaption } from '../captions/lines.js';
import type { SubjectBox } from '../matting/composite.js';

/** 画布与版式常量：分界线 y=960 来自参考片实测 */
export const CANVAS = { width: 1080, height: 1920, fps: 30, seam: 960 } as const;
export const MIN_SHOT_SEC = 1;
export const HOOK_WINDOW_SEC = 15;

export const TEMPLATE_IDS = ['hook', 'title', 'bigNumber', 'chips', 'compareBars', 'evidenceList', 'terminal', 'toggles', 'strikeList', 'browser', 'photo', 'cta'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

const text = z.string().trim().min(1).max(60);
const short = z.string().trim().min(1).max(24);

const card = <T extends TemplateId, P extends z.ZodTypeAny>(template: T, props: P) => z.object({ template: z.literal(template), props });

export const CardSpecSchema = z.discriminatedUnion('template', [
  card('hook', z.object({ index: z.number().int().min(1).max(3), total: z.number().int().min(1).max(3), headline: text, highlight: z.array(short).max(3), kicker: text.optional(), stat: z.object({ value: short, label: short }).optional(), image: z.string().optional() })),
  card('title', z.object({ title: text, subtitle: text.optional(), crumb: short.optional() })),
  card('bigNumber', z.object({ value: z.string().trim().min(1).max(10), unit: short.optional(), label: text, chips: z.array(short).max(36).optional(), highlight: z.array(short).max(6).optional() })),
  card('chips', z.object({ groups: z.array(z.object({ label: short, items: z.array(z.object({ text: short, mark: z.enum(['yes', 'no', 'maybe']) })).min(1).max(5) })).min(1).max(2) })),
  card('compareBars', z.object({ crumb: short.optional(), items: z.array(z.object({ name: short, note: short.optional(), value: z.number().min(0).max(1), annotation: short.optional(), tone: z.enum(['bad', 'warn', 'good']) })).min(1).max(3), verdict: short.optional() })),
  card('evidenceList', z.object({ crumb: short.optional(), title: text, rows: z.array(z.object({ badge: z.enum(['成本', '收益', '证据', '来源']), text })).min(1).max(5), highlight: z.array(z.number().int().min(0).max(4)).max(5).optional(), tags: z.array(short).max(3).optional() })),
  card('terminal', z.object({ title: short.optional(), lines: z.array(text).min(1).max(6) })),
  card('toggles', z.object({ title: short.optional(), rows: z.array(z.object({ label: short, on: z.boolean() })).min(1).max(4), footnote: text.optional() })),
  card('strikeList', z.object({ title: short.optional(), items: z.array(short).min(1).max(5) })),
  card('browser', z.object({ url: z.string().trim().min(1).max(80), title: text.optional(), image: z.string().optional() })),
  card('photo', z.object({ image: z.string().min(1), label: short.optional(), sublabel: text.optional() })),
  card('cta', z.object({ actions: z.array(z.string().trim().min(1).max(6)).min(1).max(3) })),
]);
export type CardSpec = z.infer<typeof CardSpecSchema>;

export const ShotSchema = z.object({ start: z.number(), end: z.number(), layout: z.enum(['split', 'full']), card: CardSpecSchema.optional() });
export type Shot = { start: number; end: number; layout: 'split' | 'full'; card?: CardSpec };
export interface Storyboard { shots: Shot[] }

/** 传给 Remotion 主合成的全部数据；person 与图片都是相对 publicDir（工作目录）的文件名 */
export interface TalkProps { person: string; personWidth: number; personHeight: number; subject: SubjectBox | null; captions: TimedCaption[]; shots: Shot[]; durationSec: number }
```

```ts
// src/storyboard/normalize.ts
import { HOOK_WINDOW_SEC, MIN_SHOT_SEC, ShotSchema, type Shot, type Storyboard } from './schema.js';

export interface NormalizeResult { storyboard: Storyboard; dropped: number }
const MAX_HOOKS = 3;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** 图片可用性：photo 必须有可用图片，否则丢弃；browser 图片不可用时去掉图片 */
function checkImages(shot: Shot, images: Set<string>): Shot | null {
  const c = shot.card;
  if (c?.template === 'photo') return images.has(c.props.image) ? shot : null;
  if (c?.template === 'browser' && c.props.image !== undefined && !images.has(c.props.image)) {
    const { image: _drop, ...props } = c.props;
    return { ...shot, card: { template: 'browser', props } };
  }
  return shot;
}

/** 规则：hook 只在前 15 秒、最多 3 张；cta 只保留最后一个且必须在最后一个镜头 */
function applyPlacementRules(shots: Shot[]): Shot[] {
  let hooks = 0;
  const lastCta = shots.map((s) => s.card?.template).lastIndexOf('cta');
  return shots.map((s, i) => {
    const t = s.card?.template;
    if (t === 'hook') {
      hooks += 1;
      if (s.start >= HOOK_WINDOW_SEC || hooks > MAX_HOOKS) return { start: s.start, end: s.end, layout: 'full' };
    }
    if (t === 'cta' && (i !== lastCta || i !== shots.length - 1)) return { start: s.start, end: s.end, layout: 'full' };
    if (t === 'cta') return { ...s, layout: 'full' };
    return s;
  });
}

/** 排序、截到 [0, 片长]、消除重叠、补齐空隙（全屏人像）、短镜头并入前一个 */
function fillTimeline(shots: Shot[], durationSec: number): Shot[] {
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  const out: Shot[] = [];
  let cursor = 0;
  for (const s of sorted) {
    const start = Math.max(round(Math.min(s.start, durationSec)), cursor);
    const end = round(Math.min(s.end, durationSec));
    if (end <= start) continue;
    if (start > cursor) out.push({ start: cursor, end: start, layout: 'full' });
    out.push({ ...s, start, end });
    cursor = end;
  }
  if (cursor < durationSec) out.push({ start: cursor, end: round(durationSec), layout: 'full' });
  return out.reduce<Shot[]>((acc, s) => {
    const last = acc[acc.length - 1];
    if (last && s.end - s.start < MIN_SHOT_SEC) return [...acc.slice(0, -1), { ...last, end: s.end }];
    return [...acc, s];
  }, []);
}

/** 模型分镜 → 合法、连续、覆盖 [0, 片长] 的分镜；不合法或图片不可用的镜头丢弃并计数 */
export function normalizeStoryboard(raw: unknown, durationSec: number, availableImages: string[]): { storyboard: Storyboard; dropped: number } {
  const items = (raw as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(items)) return { storyboard: { shots: [{ start: 0, end: round(durationSec), layout: 'full' }] }, dropped: 0 };
  const images = new Set(availableImages);
  const parsed = items.map((i) => ShotSchema.safeParse(i)).flatMap((p) => (p.success ? [p.data as Shot] : []));
  const checked = parsed.flatMap((s) => { const c = checkImages(s, images); return c ? [c] : []; });
  const timeline = fillTimeline(checked, durationSec);
  return { storyboard: { shots: applyPlacementRules(timeline) }, dropped: items.length - checked.length };
}
```

注意第二个测试：`{0,6,A}`、`{5,6.5,B}` → B 被截成 `{6,6.5}`（0.5 秒 < 1 秒）并入 A 得 `{0,6.5,A}`；第三个 props 不合法被丢弃（dropped=1），其区间由补齐逻辑填成全屏 `{6.5,10}`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/storyboard.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storyboard tests/storyboard.test.ts
git commit -m "feat: 分镜模式（12 个模板 props）与归一化"
```

---

### Task 2: Remotion 骨架、人像取景与字幕层、渲染封装

**Files:**
- Create: `src/compose/layout.ts`、`src/compose/render.ts`、`render/index.ts`、`render/Root.tsx`、`render/Talk.tsx`、`render/theme.ts`、`render/layers/PersonLayer.tsx`、`render/layers/CaptionLayer.tsx`、`render/layers/CardLayer.tsx`（本任务只放占位：有 card 时渲染一个白色圆角卡片，显示 `template` 名；Task 3/4 替换为真实模板）
- Modify: `package.json`（依赖）、`tsconfig.json`
- Test: `tests/layout.test.ts`、`tests/compose.test.ts`

**Interfaces:**
- Consumes: Task 1 `CANVAS`、`Shot`、`TalkProps`；`SubjectBox`；`TimedCaption`
- Produces:
  - `src/compose/layout.ts`：`export interface PersonTransform { scale: number; x: number; y: number }`、`export function personTransform(layout: 'split' | 'full', subject: SubjectBox | null, videoW: number, videoH: number): PersonTransform`（把视频按 scale 缩放后左上角放在 (x, y)）、`export function blendTransform(a: PersonTransform, b: PersonTransform, t: number): PersonTransform`、`export function captionAt(captions: TimedCaption[], sec: number): TimedCaption | null`、`export function shotAt(shots: Shot[], sec: number): { shot: Shot; index: number } | null`
  - `src/compose/render.ts`：`export interface RenderOptions { workDir: string; props: TalkProps; output: string; concurrency?: number; onProgress?: (ratio: number) => void }`、`export async function renderTalk(opts: RenderOptions): Promise<void>`、`export async function renderCardStill(opts: { workDir: string; card: CardSpec; output: string }): Promise<void>`（渲染单张卡片在 0.8 秒处的静帧，用于模板测试与 P4 自检）
  - Remotion 合成 id：`Talk`（主片，时长由 `calculateMetadata` 按 `durationSec` 算）与 `CardStill`（1080×960 单卡）

- [ ] **Step 1: 依赖与配置**

```bash
pnpm add remotion@4.0.531 @remotion/bundler@4.0.531 @remotion/renderer@4.0.531 react@18.3.1 react-dom@18.3.1
pnpm add -D @types/react@18.3.12
```

`tsconfig.json` 改为：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "render"]
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/layout.test.ts
import { describe, expect, it } from 'vitest';
import { blendTransform, captionAt, personTransform, shotAt } from '../src/compose/layout.js';

describe('personTransform', () => {
  it('全屏：按宽铺满并垂直居中（9:16 视频正好铺满）', () => {
    expect(personTransform('full', null, 360, 640)).toEqual({ scale: 3, x: 0, y: 0 });
  });
  it('分屏：按宽铺满，头顶放在分界线下 60px，且画面不露出分界线以上、不露出底部', () => {
    const t = personTransform('split', { top: 0.2, bottom: 1, left: 0.2, right: 0.8 }, 1080, 1920);
    expect(t.scale).toBe(1);
    expect(t.x).toBe(0);
    expect(t.y).toBe(960 + 60 - 0.2 * 1920);
  });
  it('分屏：头顶很低时 y 不超过分界线（上方不露底色）；头顶很高时视频底部不高于画布底', () => {
    expect(personTransform('split', { top: 0, bottom: 1, left: 0, right: 1 }, 1080, 1920).y).toBe(960);
    // 1080×1350 的横宽视频：缩放后高 1350，y 最小为 1920-1350=570，但不能超过 960
    const wide = personTransform('split', { top: 0.9, bottom: 1, left: 0, right: 1 }, 1080, 1350);
    expect(wide.y).toBe(570);
  });
  it('没有取景框时按头顶在 12% 处估计', () => {
    expect(personTransform('split', null, 1080, 1920).y).toBe(960 + 60 - 0.12 * 1920);
  });
});

describe('blendTransform / captionAt / shotAt', () => {
  it('线性插值', () => {
    expect(blendTransform({ scale: 1, x: 0, y: 0 }, { scale: 3, x: 10, y: 100 }, 0.5)).toEqual({ scale: 2, x: 5, y: 50 });
  });
  it('按时间找当前字幕与镜头；不在任何区间返回 null', () => {
    const caps = [{ start: 0, end: 1, text: 'a' }, { start: 1.5, end: 2, text: 'b' }];
    expect(captionAt(caps, 0.5)?.text).toBe('a');
    expect(captionAt(caps, 1.2)).toBeNull();
    const shots = [{ start: 0, end: 2, layout: 'full' as const }, { start: 2, end: 4, layout: 'split' as const }];
    expect(shotAt(shots, 2)).toEqual({ shot: shots[1], index: 1 });
    expect(shotAt(shots, 9)).toBeNull();
  });
});
```

```ts
// tests/compose.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { renderCardStill, renderTalk } from '../src/compose/render.js';

describe('renderTalk（真实 Remotion 渲染，首次运行会下载 Chrome Headless Shell）', () => {
  it('2 秒：分屏卡片 + 全屏，输出 1080×1920 30fps 带音轨', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-compose-'));
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(workDir, 'person.mp4')]);
    const output = join(workDir, 'final.mp4');
    const ratios: number[] = [];
    await renderTalk({ workDir, output, onProgress: (r) => ratios.push(r), props: {
      person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 2,
      captions: [{ start: 0, end: 1, text: '第一行字幕' }, { start: 1, end: 2, text: '第二行字幕' }],
      shots: [{ start: 0, end: 1, layout: 'split', card: { template: 'title', props: { title: '标题卡' } } }, { start: 1, end: 2, layout: 'full' }],
    } });
    const info = await probe(output, cfg);
    expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([1080, 1920, 30, true]);
    expect(Math.abs(info.durationSec - 2)).toBeLessThan(0.1);
    expect(ratios[ratios.length - 1]).toBe(1);
  }, 300_000);

  it('单卡静帧 1080×960 PNG', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-still-'));
    const output = join(workDir, 'card.png');
    await renderCardStill({ workDir, output, card: { template: 'title', props: { title: '标题卡' } } });
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(1000);
  }, 300_000);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/layout.test.ts tests/compose.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 4: Write minimal implementation**

```ts
// src/compose/layout.ts
import type { TimedCaption } from '../captions/lines.js';
import type { SubjectBox } from '../matting/composite.js';
import { CANVAS, type Shot } from '../storyboard/schema.js';

export interface PersonTransform { scale: number; x: number; y: number }
/** 分屏时头顶距分界线的距离（px） */
const HEAD_GAP = 60;
/** 抠不出人时按头顶在画面 12% 处估计 */
const DEFAULT_TOP = 0.12;

/** 视频按宽铺满画布；分屏时把头顶放在分界线下 HEAD_GAP，且上不露分界线以上、下不露画布底 */
export function personTransform(layout: 'split' | 'full', subject: SubjectBox | null, videoW: number, videoH: number): PersonTransform {
  const scale = CANVAS.width / videoW;
  const h = videoH * scale;
  if (layout === 'full') return { scale, x: 0, y: Math.round((CANVAS.height - h) / 2) };
  const top = subject?.top ?? DEFAULT_TOP;
  const wanted = CANVAS.seam + HEAD_GAP - top * h;
  const y = Math.min(CANVAS.seam, Math.max(CANVAS.height - h, wanted));
  return { scale, x: 0, y };
}

export function blendTransform(a: PersonTransform, b: PersonTransform, t: number): PersonTransform {
  const mix = (p: number, q: number): number => p + (q - p) * t;
  return { scale: mix(a.scale, b.scale), x: mix(a.x, b.x), y: mix(a.y, b.y) };
}

export function captionAt(captions: TimedCaption[], sec: number): TimedCaption | null {
  return captions.find((c) => sec >= c.start && sec < c.end) ?? null;
}

export function shotAt(shots: Shot[], sec: number): { shot: Shot; index: number } | null {
  const index = shots.findIndex((s) => sec >= s.start && sec < s.end);
  return index < 0 ? null : { shot: shots[index], index };
}
```

（注意 `personTransform('full', null, 360, 640)`：scale=3、h=1920、y=0，与测试一致。）

```ts
// src/compose/render.ts
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { CardSpec, TalkProps } from '../storyboard/schema.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'render', 'index.ts');
const DEFAULT_CONCURRENCY = 8;

/** 打包 render/ 入口；publicDir 指向工作目录，模板里用 staticFile() 取人像与 B-roll。webpack 把 .js 导入解析到 .ts/.tsx，与仓库的 NodeNext 写法一致 */
function bundleFor(workDir: string): Promise<string> {
  return bundle({
    entryPoint: ENTRY,
    publicDir: workDir,
    webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } } }),
  });
}

export interface RenderOptions { workDir: string; props: TalkProps; output: string; concurrency?: number; onProgress?: (ratio: number) => void }

export async function renderTalk(opts: RenderOptions): Promise<void> {
  const serveUrl = await bundleFor(opts.workDir);
  const inputProps = opts.props as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: 'Talk', inputProps });
  await renderMedia({
    composition, serveUrl, inputProps, codec: 'h264', crf: 18, outputLocation: opts.output,
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });
  opts.onProgress?.(1);
}

/** 单张卡片在 0.8 秒（进场动画结束后）的静帧，1080×960 */
export async function renderCardStill(opts: { workDir: string; card: CardSpec; output: string }): Promise<void> {
  const serveUrl = await bundleFor(opts.workDir);
  const inputProps = { card: opts.card } as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
  await renderStill({ composition, serveUrl, inputProps, output: opts.output, frame: 24 });
}
```

```ts
// render/index.ts
import { registerRoot } from 'remotion';
import { Root } from './Root.js';

registerRoot(Root);
```

```tsx
// render/Root.tsx
import React from 'react';
import { Composition } from 'remotion';
import { CANVAS, type CardSpec, type TalkProps } from '../src/storyboard/schema.js';
import { Talk } from './Talk.js';
import { CardStill } from './layers/CardLayer.js';

const EMPTY: TalkProps = { person: '', personWidth: 1080, personHeight: 1920, subject: null, captions: [], shots: [], durationSec: 1 };

export const Root: React.FC = () => (
  <>
    <Composition id="Talk" component={Talk} width={CANVAS.width} height={CANVAS.height} fps={CANVAS.fps} durationInFrames={CANVAS.fps}
      defaultProps={EMPTY} calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, Math.round(props.durationSec * CANVAS.fps)) })} />
    <Composition id="CardStill" component={CardStill} width={CANVAS.width} height={CANVAS.seam} fps={CANVAS.fps} durationInFrames={CANVAS.fps * 2}
      defaultProps={{ card: { template: 'title', props: { title: '示例' } } as CardSpec }} />
  </>
);
```

```ts
// render/theme.ts
/** 视觉常量（来自参考片实测，见计划 Global Constraints） */
export const THEME = {
  stage: '#EFEBE5',
  card: '#FFFFFF',
  ink: '#1C1B19',
  sub: '#6B675F',
  faint: '#A39E94',
  radius: 28,
  shadow: '0 18px 48px rgba(40, 30, 20, 0.12)',
  badge: { 成本: '#C8891A', 收益: '#2F9E58', 证据: '#2F6FE0', 来源: '#7B4FD6' } as Record<string, string>,
  red: '#E04848',
  gold: '#C8891A',
  crumbDot: '#F06A2A',
  hookLime: '#D4F23C',
  hookBg: '#0E0F0C',
  terminal: '#1E1E1E',
  font: '"PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
  mono: '"SF Mono", Menlo, "JetBrains Mono", monospace',
} as const;
```

```tsx
// render/Talk.tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CANVAS, type TalkProps } from '../src/storyboard/schema.js';
import { THEME } from './theme.js';
import { PersonLayer } from './layers/PersonLayer.js';
import { CardLayer } from './layers/CardLayer.js';
import { CaptionLayer } from './layers/CaptionLayer.js';

/** 主合成：底色 → 人像 → 卡片 → 字幕；所有动画由帧号驱动 */
export const Talk: React.FC<TalkProps> = (props) => {
  const frame = useCurrentFrame();
  const sec = frame / CANVAS.fps;
  return (
    <AbsoluteFill style={{ background: THEME.stage }}>
      <PersonLayer {...props} sec={sec} />
      <CardLayer shots={props.shots} sec={sec} />
      <CaptionLayer captions={props.captions} shots={props.shots} sec={sec} />
    </AbsoluteFill>
  );
};
```

```tsx
// render/layers/PersonLayer.tsx
import React from 'react';
import { OffthreadVideo, staticFile } from 'remotion';
import { blendTransform, personTransform, shotAt } from '../../src/compose/layout.js';
import type { Shot, TalkProps } from '../../src/storyboard/schema.js';

/** 分屏/全屏切换的过渡时长（秒） */
export const LAYOUT_TRANSITION_SEC = 0.4;
const ease = (t: number): number => 1 - (1 - t) ** 3;

/** 当前时刻人像的位置：镜头开始的 LAYOUT_TRANSITION_SEC 内从上一个镜头的版式过渡过来 */
function transformAt(shots: Shot[], sec: number, p: TalkProps) {
  const hit = shotAt(shots, sec);
  const layout = hit?.shot.layout ?? 'full';
  const target = personTransform(layout, p.subject, p.personWidth, p.personHeight);
  if (!hit || hit.index === 0) return target;
  const prev = shots[hit.index - 1];
  const t = (sec - hit.shot.start) / LAYOUT_TRANSITION_SEC;
  if (prev.layout === layout || t >= 1) return target;
  return blendTransform(personTransform(prev.layout, p.subject, p.personWidth, p.personHeight), target, ease(Math.max(0, t)));
}

export const PersonLayer: React.FC<TalkProps & { sec: number }> = (p) => {
  const t = transformAt(p.shots, p.sec, p);
  return (
    <div style={{ position: 'absolute', left: t.x, top: t.y, width: p.personWidth * t.scale, height: p.personHeight * t.scale, overflow: 'hidden' }}>
      <OffthreadVideo src={staticFile(p.person)} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};
```

```tsx
// render/layers/CaptionLayer.tsx
import React from 'react';
import { captionAt, shotAt } from '../../src/compose/layout.js';
import type { Shot } from '../../src/storyboard/schema.js';
import type { TimedCaption } from '../../src/captions/lines.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';

/** 分屏时字幕中心压在分界线上，全屏时在 y≈1400 */
const FULL_CAPTION_Y = 1400;

export const CaptionLayer: React.FC<{ captions: TimedCaption[]; shots: Shot[]; sec: number }> = ({ captions, shots, sec }) => {
  const cap = captionAt(captions, sec);
  if (!cap) return null;
  const layout = shotAt(shots, sec)?.shot.layout ?? 'full';
  const centerY = layout === 'split' ? CANVAS.seam : FULL_CAPTION_Y;
  return (
    <div style={{ position: 'absolute', left: 60, right: 60, top: centerY, transform: 'translateY(-50%)', textAlign: 'center',
      fontFamily: THEME.font, fontSize: 64, fontWeight: 800, lineHeight: 1.25, color: '#FFFFFF',
      WebkitTextStroke: '10px #000000', paintOrder: 'stroke fill' }}>
      {cap.text}
    </div>
  );
};
```

```tsx
// render/layers/CardLayer.tsx（本任务的占位实现；Task 3 换成模板注册表）
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { shotAt } from '../../src/compose/layout.js';
import type { CardSpec, Shot } from '../../src/storyboard/schema.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';

const Placeholder: React.FC<{ card: CardSpec }> = ({ card }) => (
  <div style={{ position: 'absolute', left: 90, right: 90, top: 300, padding: 48, background: THEME.card, borderRadius: THEME.radius, boxShadow: THEME.shadow, fontFamily: THEME.font, fontSize: 56, color: THEME.ink }}>
    {card.template}
  </div>
);

/** 分屏镜头在上半屏（0–960）画卡片区底色与卡片 */
export const CardLayer: React.FC<{ shots: Shot[]; sec: number }> = ({ shots, sec }) => {
  const hit = shotAt(shots, sec);
  if (!hit || hit.shot.layout !== 'split') return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam, background: THEME.stage, overflow: 'hidden' }}>
      {hit.shot.card ? <Placeholder card={hit.shot.card} /> : null}
    </div>
  );
};

/** 单卡静帧合成（1080×960） */
export const CardStill: React.FC<{ card: CardSpec }> = ({ card }) => (
  <AbsoluteFill style={{ background: THEME.stage }}>
    <Placeholder card={card} />
  </AbsoluteFill>
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/layout.test.ts tests/compose.test.ts && pnpm typecheck`
Expected: PASS（`compose.test.ts` 首次会下载 Chrome Headless Shell）

- [ ] **Step 6: 目视检查**

```bash
ffmpeg -v error -y -ss 0.5 -i <compose 测试工作目录>/final.mp4 -frames:v 1 /tmp/split.png
```
确认：上半屏米色底 + 占位卡片，下半屏测试画面，字幕压在 y=960。把截图路径写进报告。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json src/compose render tests/layout.test.ts tests/compose.test.ts
git commit -m "feat: Remotion 成片骨架（人像取景、分屏全屏过渡、字幕层、渲染封装）"
```

---

### Task 3: 卡片模板 A 组（hook、title、bigNumber、chips、compareBars、evidenceList）与卡片进出场

**Files:**
- Create: `render/templates/Hook.tsx`、`Title.tsx`、`BigNumber.tsx`、`Chips.tsx`、`CompareBars.tsx`、`EvidenceList.tsx`、`render/templates/index.ts`、`render/templates/parts.tsx`（共用小部件：Crumb 面包屑、Badge、CardFrame）
- Modify: `render/layers/CardLayer.tsx`（占位换成注册表 + 进出场动画）
- Test: `tests/templates.test.ts`

**Interfaces:**
- Consumes: Task 1 `CardSpec` 各模板 props；Task 2 `THEME`、`renderCardStill`、`CardStill` 合成
- Produces:
  - `render/templates/index.ts`：`export const TEMPLATES: Partial<Record<TemplateId, React.FC<{ props: any; local: number }>>>`（本任务登记 6 个；Task 4 补齐 12 个），`local` 为镜头内的秒数（从 0 开始），模板用它驱动入场后的内部动画
  - `export function renderCard(card: CardSpec, local: number): React.ReactNode`
  - CardLayer：卡片进场 0–0.5 秒（`spring`，从下方 80px + 0.94 缩放 + 透明度 0 进入），出场为镜头最后 0.25 秒淡出上移 30px；相邻两个分屏镜头之间不做全区底色闪烁

**视觉要求（每个模板，对照参考帧 `top-*.png`）：**
| 模板 | 参考帧 | 要点 |
|---|---|---|
| hook | `top-hook1/2/3.png` | 卡片区全黑 `#0E0F0C`（有 `image` 时铺图并压暗 55%）；左上荧光黄绿胶囊写 `kicker`，右上描边胶囊「index / total」；大标题 76px 粗体白字，`highlight` 中的子串染 `#D4F23C`；有 `stat` 时下方一行 `value · label` 小胶囊；标题逐行上滑进入 |
| title | — | 白卡片居中，`crumb` 面包屑（橙点 + 小字）、标题 72px、副标题 40px 灰 |
| bigNumber | `top-bignumber-chips.png` | 左上巨大数字 150px 粗体 + 右侧 `unit · label`；下方 6 列标签网格（白底圆角小格，`highlight` 的格子绿色描边绿字）；数字 0.6 秒内从 0 滚动到目标值（目标是纯数字时；否则直接显示） |
| chips | `top-chips-yesno.png` | 每组一行：左侧组名，右侧胶囊；`yes` 绿底 ✓、`no` 红底 ✗、`maybe` 灰底 ?；胶囊依次弹入（间隔 0.12 秒） |
| compareBars | `top-compare-bars.png` | 每项一张白卡：左侧小瓶图标（圆角矩形，`bad` 红/`warn` 灰），名称粗体 + `note` 灰小字，右上 `annotation` 用 tone 色；下方进度条从 0 长到 `value`（0.8 秒，依次）；有 `verdict` 时底部黑色胶囊按钮 |
| evidenceList | `top-evidence.png` | 白卡：小字面包屑 + 标题 52px；每行左侧彩色标签（按 badge 取 `THEME.badge`），右侧文字；`highlight` 行浅色底高亮；行依次滑入；`tags` 为底部彩色小胶囊 |

所有文字用 `THEME.font`；卡片左右边距 60px；内容超长时字号按行宽自动缩小（不允许溢出卡片）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/templates.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCardStill } from '../src/compose/render.js';
import { CardSpecSchema, type CardSpec } from '../src/storyboard/schema.js';

export const SAMPLES: CardSpec[] = [
  { template: 'hook', props: { index: 1, total: 3, kicker: '这 3 句话都出自 GitHub 近 3.5 万星的《高性价比人生指南》', headline: '吃抗氧化补剂的人死亡率反而略高', highlight: ['略高'], stat: { value: '78 项试验', label: '近 30 万人' } } },
  { template: 'title', props: { crumb: '第 1 节', title: 'FDE 是什么', subtitle: '站在客户现场把 AI 用起来的人' } },
  { template: 'bigNumber', props: { value: '650', unit: '条建议', label: '34 章', chips: ['不要早死', '不要慢慢死', '不浪费精力', '不浪费时间', '不要浪费钱', '反面清单', '没钱怎么活', '别搭进去', '法律红线', '恋爱结婚', '程序员红线', '创业生意'], highlight: ['不要早死', '不要慢慢死'] } },
  { template: 'chips', props: { groups: [{ label: '帮别人', items: [{ text: '提效', mark: 'yes' }, { text: '算投入产出比', mark: 'yes' }] }, { label: '轮到自己', items: [{ text: '身体', mark: 'maybe' }, { text: '存款', mark: 'maybe' }] }] } },
  { template: 'compareBars', props: { crumb: '第 2 节第 7 条 · 证据 A', items: [{ name: '甜饮料（含糖）', note: '每天 2 瓶以上', value: 0.82, annotation: '死亡概率高约两成', tone: 'bad' }, { name: '代糖饮料（无糖）', note: '每天 2 杯以上', value: 0.88, annotation: '反而高约四分之一', tone: 'warn' }], verdict: '换成无糖 → 也没用' } },
  { template: 'evidenceList', props: { crumb: '示例 · 第 1 节', title: '把家里的食盐换成低钠盐', rows: [{ badge: '成本', text: '一袋比普通盐贵几元，口味几乎不变' }, { badge: '收益', text: '高危人群五年内死亡概率低约 12%' }, { badge: '证据', text: 'A 级 · 随机试验，20995 人，跟踪 4.74 年' }, { badge: '来源', text: 'Neal B 等 (2021) · NEJM' }], highlight: [3], tags: ['期刊论文', '官方文件'] } },
];

describe('卡片模板 A 组', () => {
  it('样例数据都符合模式', () => {
    for (const s of SAMPLES) expect(CardSpecSchema.safeParse(s).success).toBe(true);
  });
  it.each(SAMPLES.map((s) => [s.template, s] as const))('%s 能渲染出静帧', async (_id, card) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-tpl-'));
    const output = join(dir, `${card.template}.png`);
    await renderCardStill({ workDir: dir, output, card });
    expect(statSync(output).size).toBeGreaterThan(5000);
  }, 300_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/templates.test.ts`
Expected: 静帧用例生成的是 Task 2 的占位卡（文件可能 >5000 字节而通过）。为了让 RED 有效，先在 `render/templates/index.ts` 只导出空的 `TEMPLATES = {}` 与 `renderCard`（对未登记模板 `throw new Error('未登记的模板：' + id)`），并把 CardLayer/CardStill 改为调用 `renderCard` ——此时静帧用例 FAIL（渲染抛错）。

- [ ] **Step 3: 实现 6 个模板、parts、注册表与进出场**

按上面的视觉要求逐个实现。`CardLayer` 的进出场：

```tsx
// render/layers/CardLayer.tsx 中卡片包装（替换 Placeholder 调用处）
const ENTER_SEC = 0.5;
const EXIT_SEC = 0.25;
const CardMotion: React.FC<{ shot: Shot; sec: number }> = ({ shot, sec }) => {
  const { fps } = useVideoConfig();
  const local = sec - shot.start;
  const s = spring({ frame: Math.round(local * fps), fps, config: { damping: 16, mass: 0.7 } });
  const exit = interpolate(shot.end - sec, [0, EXIT_SEC], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const style: React.CSSProperties = {
    position: 'absolute', inset: 0,
    opacity: Math.min(s, 1 - exit),
    transform: `translateY(${interpolate(s, [0, 1], [80, 0]) - exit * 30}px) scale(${interpolate(s, [0, 1], [0.94, 1])})`,
  };
  return <div style={style}>{renderCard(shot.card!, local)}</div>;
};
```

（`ENTER_SEC` 仅作说明：spring 约 0.5 秒收敛。hook 模板自带全黑卡片区底色，覆盖米色底。）

- [ ] **Step 4: Run test to verify it passes，并目视检查**

Run: `pnpm vitest run tests/templates.test.ts && pnpm typecheck`
Expected: PASS。把 6 张静帧另存到 `work/templates-a/`（work/ 已被 gitignore），在报告里列出路径，逐张与参考帧对比说明差异。

- [ ] **Step 5: Commit**

```bash
git add render tests/templates.test.ts
git commit -m "feat: 卡片模板 A 组（钩子、标题、大数字、标签、对比条、证据列表）与进出场动画"
```

---

### Task 4: 卡片模板 B 组（terminal、toggles、strikeList、browser、photo、cta）

**Files:**
- Create: `render/templates/Terminal.tsx`、`Toggles.tsx`、`StrikeList.tsx`、`Browser.tsx`、`Photo.tsx`、`Cta.tsx`
- Modify: `render/templates/index.ts`（登记全部 12 个）、`tests/templates.test.ts`（追加 B 组样例与静帧用例，并断言 `Object.keys(TEMPLATES)` 覆盖 `TEMPLATE_IDS`——该断言放在 Node 侧不可行时，改为对每个 `TEMPLATE_IDS` 渲染一张静帧不抛错）

**Interfaces:**
- Consumes: Task 3 `TEMPLATES`、`renderCard`、`parts.tsx`；`THEME`
- Produces: 12 个模板全部登记

**视觉要求：**
| 模板 | 参考帧 | 要点 |
|---|---|---|
| terminal | `top-terminal.png` | 深色窗 `#1E1E1E` 圆角 22，左上红黄绿三点，标题 `title`（默认 `Claude Code`）橙色等宽字；`lines` 逐字打出（每秒 28 字，行间停顿 0.2 秒），光标闪烁；第一行前加 `> ` |
| toggles | `top-toggle.png`、`top-toggles-settings.png` | 白卡设置面板：小字标题；每行左侧 label，右侧 iOS 风格开关；`on: true` 的开关在镜头 0.6 秒后从关拨到开（绿色），带光标箭头点击；`footnote` 红色小字 |
| strikeList | `top-strike-list.png` | 竖排浅色胶囊列表，每项依次出现后被红线从左到右划掉（0.3 秒/项） |
| browser | `top-browser-loading.png`、`top-github-trending.png` | 浏览器窗：顶部地址栏胶囊显示 `url`，下方蓝色加载进度条；有 `image` 时进度条 0.6 秒走完后显示图片（`staticFile(image)`，object-fit cover 顶部对齐，缓慢上滚 3%）；无 `image` 时显示转圈与「正在加载…」+ `title` |
| photo | `top-photo-label.png`（上半屏铺满图片） | `staticFile(image)` 铺满卡片区，Ken Burns 缓慢推近 6%；`label`/`sublabel` 放左下白色半透明圆角标签卡 |
| cta | `top-cta.png` | 全屏镜头叠加：上方一排三个胶囊（关注红 `#F2334B`、点赞橙 `#FF7A2F`、收藏金 `#F5A623`），初始为白底灰字，光标依次点击后变成彩底白字带 ✓（每个 0.5 秒） |

注意：`cta` 镜头的 layout 是 `full`（Task 1 已强制），所以 CardLayer 需要对 `cta` 在全屏时也渲染（只渲染胶囊，不画卡片区底色）。修改 CardLayer：`layout === 'full'` 且 `card.template === 'cta'` 时渲染在画布顶部 y=180 处。

- [ ] **Step 1: 追加失败的测试**（B 组 6 个样例；`photo`/`browser` 的图片用测试里 ffmpeg 生成的 `broll/test.jpg` 放进 workDir）

```ts
// tests/templates.test.ts 追加
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { TEMPLATE_IDS } from '../src/storyboard/schema.js';
import { mkdirSync } from 'node:fs';

const SAMPLES_B: CardSpec[] = [
  { template: 'terminal', props: { lines: ['读一遍《高性价比人生指南》，结合我的工作和生活习惯，挑出我该改进的事', '结合你的情况，建议优先改这几件：', '1. 少喝含糖饮料，换成无糖的也不算解决'] } },
  { template: 'toggles', props: { title: '信用卡设置', rows: [{ label: '最低还款', on: false }, { label: '消费分期', on: true }], footnote: '最低还款折合下来，一年要付 18% 上下的利息' } },
  { template: 'strikeList', props: { items: ['自动续费的会员', '冲动下单', '用不上的订阅'] } },
  { template: 'browser', props: { url: 'github.com/eternity4719/HowToLiveBetter', image: 'broll/test.jpg' } },
  { template: 'photo', props: { image: 'broll/test.jpg', label: '应急金：3 到 6 个月生活费', sublabel: '放在随时取得到的地方' } },
  { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } },
];

describe('卡片模板 B 组', () => {
  it('A、B 两组样例覆盖全部 12 个模板', () => {
    expect(new Set([...SAMPLES, ...SAMPLES_B].map((s) => s.template))).toEqual(new Set(TEMPLATE_IDS));
  });
  it.each(SAMPLES_B.map((s) => [s.template, s] as const))('%s 能渲染出静帧', async (_id, card) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-tpl-'));
    mkdirSync(join(dir, 'broll'));
    await run(loadConfig({}).ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1080', '-frames:v', '1', join(dir, 'broll', 'test.jpg')]);
    const output = join(dir, `${card.template}.png`);
    await renderCardStill({ workDir: dir, output, card });
    expect(statSync(output).size).toBeGreaterThan(5000);
  }, 300_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/templates.test.ts`
Expected: B 组静帧 FAIL（`未登记的模板`）

- [ ] **Step 3: 实现 6 个模板与 cta 全屏渲染**

- [ ] **Step 4: Run test to verify it passes，并目视检查**（静帧另存 `work/templates-b/`，逐张对比参考帧写进报告）

Run: `pnpm vitest run tests/templates.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add render tests/templates.test.ts
git commit -m "feat: 卡片模板 B 组（终端、开关、划掉清单、浏览器、图片、三连 CTA）"
```

---

### Task 5: 用 Gemini 生成分镜

**Files:**
- Create: `src/storyboard/catalog.ts`、`src/storyboard/generate.ts`
- Test: `tests/storyboard-generate.test.ts`

**Interfaces:**
- Consumes: Task 1 `normalizeStoryboard`、`TEMPLATE_IDS`、`HOOK_WINDOW_SEC`；`LlmClient`（`src/llm/kexiang.ts`：`chatJson({ model, system, user, reasoningEffort })`）；`TimedCaption`
- Produces:
  - `export const STORYBOARD_MODEL = 'google/gemini-3.5-flash'`
  - `export const CATALOG: readonly { id: TemplateId; use: string; props: string }[]`（12 项；`props` 是给模型看的字段说明，含每个字段的长度上限）
  - `export async function generateStoryboard(client: LlmClient, captions: TimedCaption[], durationSec: number, availableImages: string[]): Promise<NormalizeResult & { attempts: number }>`

**提示词要求（写进 `SYSTEM_PROMPT`）：**
- 角色：短视频口播的分镜导演；输入是成片时间轴上的字幕（`[开始-结束] 文字`，秒，保留 2 位小数）与总时长、可用图片列表
- 输出 JSON：`{"shots":[{"start":秒,"end":秒,"layout":"split|full","card":{"template":"…","props":{…}}}]}`；`full` 镜头不带 card（cta 除外）
- 规则：开头 2–3 张 `hook`（index 从 1 起，total 为张数），覆盖前几句、每张对应一句最抓人的话，`highlight` 只能是 `headline` 的子串；中段每 1–3 句字幕一个分屏卡片，镜头边界对齐字幕边界；单个镜头 2–8 秒；约 20% 时长用 `full` 让人物全屏（情绪、转折、口播感强的句子）；最后一个镜头 `cta`（layout `full`）覆盖最后一句；卡片文字是提炼后的信息，不照抄字幕；数字、专名与字幕一致，不编造字幕里没有的数据；`photo`/`browser.image` 只能用可用图片列表里的文件名，列表为空时不要用 `photo`
- 每个模板的用途与字段说明逐条列出（来自 `CATALOG`）

**重试：** 归一化后 `dropped` 超过原始镜头数的 30% 或可用镜头（带 card 的）少于 2 个时，带上「上一次有 N 个镜头不合格：<前 3 个 zod 错误摘要>」重试 1 次，取两次中 dropped 较少的结果；`attempts` 记录调用次数。

- [ ] **Step 1: Write the failing test**

```ts
// tests/storyboard-generate.test.ts
import { describe, expect, it } from 'vitest';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import { CATALOG, generateStoryboard, STORYBOARD_MODEL } from '../src/storyboard/generate.js';
import { TEMPLATE_IDS } from '../src/storyboard/schema.js';

const caps = [
  { start: 0, end: 2.5, text: 'FDE 这个岗位' },
  { start: 2.5, end: 5, text: '现在看来基本定性了' },
  { start: 5, end: 9, text: '而且生命周期可能会很长' },
];
const scripted = (...replies: unknown[]) => {
  const calls: ChatOptions[] = [];
  const client: LlmClient = { chatJson: async (o) => { calls.push(o); return replies[calls.length - 1]; } };
  return { client, calls };
};
const good = { shots: [
  { start: 0, end: 5, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: 'FDE 岗位基本定性了', highlight: ['定性'] } } },
  { start: 5, end: 9, layout: 'split', card: { template: 'title', props: { title: '生命周期很长' } } },
] };

describe('CATALOG', () => {
  it('覆盖全部 12 个模板', () => {
    expect(CATALOG.map((c) => c.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });
});

describe('generateStoryboard', () => {
  it('用 gemini-3.5-flash（low），用户消息含带时间的字幕、总时长与可用图片；返回归一化后的分镜', async () => {
    const { client, calls } = scripted(good);
    const res = await generateStoryboard(client, caps, 9, ['broll/a.jpg']);
    expect(calls[0]).toMatchObject({ model: STORYBOARD_MODEL, reasoningEffort: 'low' });
    expect(calls[0].user).toContain('[0.00-2.50] FDE 这个岗位');
    expect(calls[0].user).toContain('9.00');
    expect(calls[0].user).toContain('broll/a.jpg');
    for (const id of TEMPLATE_IDS) expect(calls[0].system).toContain(id);
    expect(res.attempts).toBe(1);
    expect(res.storyboard.shots.map((s) => s.card?.template)).toEqual(['hook', 'title']);
  });
  it('不合格镜头过多时带原因重试 1 次，取 dropped 较少的结果', async () => {
    const bad = { shots: [{ start: 0, end: 5, layout: 'split', card: { template: 'title', props: {} } }, { start: 5, end: 9, layout: 'split', card: { template: 'nope', props: {} } }] };
    const { client, calls } = scripted(bad, good);
    const res = await generateStoryboard(client, caps, 9, []);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('不合格');
    expect(res.attempts).toBe(2);
    expect(res.dropped).toBe(0);
  });
  it('模型请求失败时抛出（由流程决定是否降级）', async () => {
    const client: LlmClient = { chatJson: async () => { throw new Error('超时'); } };
    await expect(generateStoryboard(client, caps, 9, [])).rejects.toThrow('超时');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run tests/storyboard-generate.test.ts`，FAIL（找不到模块）

- [ ] **Step 3: 实现 `catalog.ts` 与 `generate.ts`**（按上面的提示词要求与重试规则；字幕格式 `[${start.toFixed(2)}-${end.toFixed(2)}] ${text}` 每行一条；总时长写 `总时长：${durationSec.toFixed(2)} 秒`；可用图片写 `可用图片：` + 逗号分隔，空时写 `可用图片：无`。zod 错误摘要用 `ShotSchema.safeParse` 的 `error.issues[0].message` 与 path。）

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run tests/storyboard-generate.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/storyboard tests/storyboard-generate.test.ts
git commit -m "feat: Gemini 生成分镜（模板目录提示词、不合格重试）"
```

---

### Task 6: 接入出片流程

**Files:**
- Modify: `src/pipeline/run.ts`、`src/pipeline/project.ts`、`src/cli.ts`
- Test: `tests/pipeline.test.ts`（更新步骤断言、追加分镜与成片用例）

**Interfaces:**
- Consumes: Task 5 `generateStoryboard`；Task 2 `renderTalk`；Task 1 `Storyboard`、`TalkProps`；P2 的 `replaceBackground` 返回的视频路径（无背景时为 `cut.mp4`）与 `project.subject`
- Produces:
  - `PipelineStep` 去掉 `'burn'`，在 `'captions'` 之后增加 `'storyboard' | 'compose'`：`… render → [background → matte] → captions → storyboard → compose → done`
  - `ProjectFile` 增加 `storyboard?: Storyboard`、`storyboardDropped?: number`；`ProjectArtifacts` 增加 `final?: string`（与 `output` 相同路径）
  - 字幕不再烧录（ASS 文件仍写出，供 P5 外部使用；`artifacts.ass` 保留）
  - 分镜生成失败（请求出错）时不中断：降级为整片全屏一个镜头，进度消息写明原因
  - 渲染前把人像视频文件名（相对工作目录）放进 `TalkProps.person`；人像视频必须在工作目录内（`person.mp4` 或 `cut.mp4` 本来就在）

- [ ] **Step 1: 更新/追加测试**

在 `tests/pipeline.test.ts`：现有断言步骤顺序的用例改为新顺序（无背景：`['probe','audio','asr','cuts','plan','render','captions','storyboard','compose','done']`；有背景：在 render 后插入 `'background','matte'`）。假 LLM 增加分镜分支，**必须放在「字幕」判断之前**（分镜提示词里也含「字幕」二字）：`o.system.includes('分镜')` 时返回 `{ shots: [{ start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: '测试' } } }] }`。追加断言：`project.storyboard.shots[0].card.template === 'title'`；输出视频 `1080×1920`、30fps、有音轨。再加一个用例：分镜请求抛错时流程仍完成，`project.storyboard.shots` 为整片一个 `full` 镜头，`compose` 步骤的进度消息包含「分镜生成失败」。

- [ ] **Step 2: Run tests to verify they fail** — `pnpm vitest run tests/pipeline.test.ts`

- [ ] **Step 3: 实现**

`produce()` 中，字幕步骤之后：

```ts
  const storyboard = await planStoryboard(llm, captions, a.plan.outputDurationSec, complete);
  const person = relative(workDir, base);
  if (person.startsWith('..')) throw new Error(`人像视频必须在工作目录内：${base}`);
  const media = await probe(base, cfg);
  const project = complete('storyboard', …); // 见下
  await renderTalk({ workDir, output, props: { person, personWidth: media.width, personHeight: media.height, subject: project.subject ?? null, captions, shots: storyboard.shots, durationSec: a.plan.outputDurationSec } });
  complete('compose', '成片渲染完成', { artifacts: { output, final: output } });
```

`planStoryboard`：调用 `generateStoryboard(llm, captions, duration, [])`（P3a 没有 B-roll，图片列表为空），成功时 `complete('storyboard', \`${n} 个镜头 · ${cards} 张卡片${dropped ? \` · 丢弃 ${dropped} 个不合格镜头\` : ''}\`, { storyboard, storyboardDropped: dropped })`；失败时 `complete('storyboard', \`分镜生成失败，改为全程人像：${原因}\`, { storyboard: 全屏单镜头 })`。函数 < 50 行。

`src/cli.ts` 的完成提示改为输出成片路径与镜头数。

- [ ] **Step 4: Run tests** — `pnpm typecheck && pnpm test`，全部 PASS

- [ ] **Step 5: 手动冒烟**（控制者执行）：`pnpm mingzhi edit work/raw1/raw1.mp4 --work work/p3a --bg study`，看成片。

- [ ] **Step 6: Commit**

```bash
git add src/pipeline src/cli.ts tests/pipeline.test.ts
git commit -m "feat: 出片流程接入分镜与 Remotion 成片渲染"
```

---

## 验收（控制者执行）

用 `work/raw1/raw1.mp4` 出片，与参考片 `成片_B` 并排截取 6 个时间点对比；记录分镜生成耗时、渲染耗时、丢弃镜头数；把发现写入 `docs/acceptance/p3a.md`。
