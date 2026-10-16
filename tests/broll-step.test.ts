import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TimedCaption } from '../src/captions/lines.js';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import { runBroll, type BrollContext } from '../src/pipeline/broll-step.js';
import type { BrollDeps } from '../src/broll/fulfill.js';
import type { ProgressEvent } from '../src/pipeline/run.js';
import type { ProjectFile, ProjectPatch } from '../src/pipeline/project.js';
import type { Shot, Storyboard } from '../src/storyboard/schema.js';
import { beatJson, brollAnswers, cand, fakeBrollDeps as fakeDeps, makeBrollFixtures, POOL, wiki } from './helpers/broll-fakes.js';

const cfg = loadConfig({});
const DURATION = 40;
let fx: string;
beforeAll(async () => { fx = await makeBrollFixtures(); });

const beat = beatJson;
const BEATS = [beat(5, 8, 'broll-full', 'footage'), beat(11, 14, 'split'), beat(20.5, 23.5, 'broll-full'), beat(30.5, 33, 'pip', 'screenshot', { queryZh: ['敏之 AI 社区'] })];

/** 假模型：按用途返回节拍、打分（序号越小分越高）、主体位置 */
const fakeLlm = (over: { beats?: unknown; score?: (o: ChatOptions) => unknown } = {}) => brollAnswers(over.beats ?? { beats: BEATS }, { score: over.score });

const STORYBOARD = (): Storyboard => ({ shots: [
  { start: 0, end: 4, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '钩子标题', highlight: [], visual: { source: 'video', prompt: 'HOOK slow push-in on a contract' } } } },
  { start: 4, end: 10, layout: 'full' },
  { start: 10, end: 16, layout: 'split', card: { template: 'title', props: { title: '需求写进合同' } } },
  { start: 16, end: 28, layout: 'full' },
  { start: 28, end: 36, layout: 'full' },
  { start: 36, end: 40, layout: 'full', card: { template: 'cta', props: { actions: ['关注'], placed: true } } },
] });
const CAPTIONS: TimedCaption[] = [{ start: 0, end: 10, text: '驻场开发要进业务现场' }, { start: 10, end: 40, text: '需求清单写在合同里，社区里讨论' }];

interface Run { out: Storyboard; events: ProgressEvent[]; patches: ProjectPatch[]; dir: string }
async function go(ctx: Partial<BrollContext> & { brollDeps: BrollDeps; llm: LlmClient }, storyboard = STORYBOARD(), dir = mkdtempSync(join(tmpdir(), 'mz-bstep-'))): Promise<Run> {
  const events: ProgressEvent[] = [];
  const patches: ProjectPatch[] = [];
  const complete = (step: 'broll', message: string, patch: ProjectPatch = {}): ProjectFile => { events.push({ step, message }); patches.push(patch); return {} as ProjectFile; };
  const out = await runBroll({ workDir: dir, cfg, broll: { enabled: true, maxVideos: 1, budgetYuan: 10 }, captions: CAPTIONS, onProgress: (e) => events.push(e), ...ctx }, storyboard, DURATION, complete);
  return { out, events, patches, dir };
}
const brollShots = (sb: Storyboard): Shot[] => sb.shots.filter((s) => s.broll);

describe('B-roll 编排端到端（假来源 + 假模型）', () => {
  it('规划 → 检索 → 审片 → 加工 → 按呈现方式放进镜头 → credits.json；全片不复用同一素材；进度带 beats、候选数、来源与花费', async () => {
    const searched: string[] = [];
    const { deps, calls } = fakeDeps([wiki(POOL, searched)]);
    const llm = fakeLlm();
    const r = await go({ brollDeps: deps, llm });
    const shots = brollShots(r.out);
    // 截图只截首屏标题区，画中画节拍改成上半屏，并带来源角标
    expect(shots.map((s) => s.layout)).toEqual(['broll', 'split', 'broll', 'split']);
    expect(shots[3].broll?.label).toEqual({ kind: 'source', text: '来源：minzhi.example.org' });
    expect(shots[0].broll?.label).toBeUndefined();
    expect(r.out.shots.find((s) => s.layout === 'split' && s.broll)?.card?.template).toBe('title'); // 卡片镜头做底
    expect(shots.every((s) => /^broll\/b[0-9a-f]{12}\.(jpg|mp4)$/.test(s.broll?.file ?? ''))).toBe(true);
    expect(new Set(shots.map((s) => s.broll?.file)).size).toBe(4);
    // 截图：联网核实后截图，不截没核实的网址
    expect(calls.search).toEqual(['敏之 AI 社区']);
    expect(calls.screenshot).toEqual(['https://minzhi.example.org/community']);
    expect(searched).toEqual(['query 5', 'query 11', 'query 20.5']);
    // 每张都存在且带授权记录；credits.json 汇总
    for (const s of shots) expect(existsSync(join(r.dir, s.broll?.file ?? ''))).toBe(true);
    const credits = JSON.parse(readFileSync(join(r.dir, 'credits.json'), 'utf8')) as { file: string; source: string; license: string; author?: string; modified: string[] }[];
    expect(credits.filter((c) => c.source === 'wikimedia')).toHaveLength(3);
    expect(credits.find((c) => c.source === 'wikimedia')).toMatchObject({ license: 'CC BY 4.0', author: expect.stringContaining('作者') });
    expect(credits.find((c) => c.source === 'screenshot')).toBeDefined();
    expect(credits.find((c) => c.source === 'generated')).toBeDefined(); // 钩子图
    // 预算：B-roll 上限下不做图生视频
    expect(calls.video).toEqual([]);
    // 进度：规划、每个节拍、汇总都有 broll 明细
    const details = r.events.flatMap((e) => (e.detail?.kind === 'broll' ? [e.detail.data as { phase: string; beats?: number; candidates?: number; source?: string; spentYuan: number }] : []));
    expect(details[0]).toMatchObject({ phase: 'plan', beats: 4 });
    expect(details.filter((d) => d.phase === 'beat' && d.candidates !== undefined).map((d) => d.candidates)).toEqual([6, 6, 6, 1]);
    expect(details.filter((d) => d.source).map((d) => d.source)).toEqual(['wikimedia', 'wikimedia', 'wikimedia', 'screenshot']);
    expect(details.at(-1)).toMatchObject({ phase: 'done', placed: 4, beats: 4 });
    const patch = r.patches.at(-1)?.broll;
    expect(patch?.beats?.map((b) => b.status)).toEqual(['placed', 'placed', 'placed', 'placed']);
    expect(r.events.at(-1)?.message).toMatch(/^素材 5 个（实拍 0 \/ 图片 3 \/ 截图 1 \/ 生成 1） · 节拍 4\/4 放进镜头 · 全屏插入 2 次 · 花费 ¥0\.20 · 失败 0 个/);
  });

  it('只有 1080p 横屏素材时，全屏 beat 不硬放大，改成上半屏分屏', async () => {
    const { deps } = fakeDeps([wiki(() => [cand('land', { width: 1920, height: 1080 })])]);
    const r = await go({ brollDeps: deps, llm: fakeLlm({ beats: { beats: [beat(5, 8, 'broll-full')] } }) });
    expect(brollShots(r.out).map((s) => s.layout)).toEqual(['split']);
  });

  it('来源网络失败、审片都不达标：兜底生图；生图也失败就跳过该节拍，不中断出片', async () => {
    const failing = wiki(() => new Error('Wikimedia 网络请求失败：ECONNRESET'));
    const ok = fakeDeps([failing]);
    const r = await go({ brollDeps: ok.deps, llm: fakeLlm({ beats: { beats: [beat(5, 8, 'broll-full')] } }) });
    expect(ok.calls.image.filter((p) => !p.includes('HOOK'))).toHaveLength(1);
    expect(brollShots(r.out)[0]?.layout).toBe('broll');
    expect(JSON.parse(readFileSync(join(r.dir, 'credits.json'), 'utf8')).filter((c: { aiGenerated: boolean }) => c.aiGenerated)).toHaveLength(2);

    const low = (o: ChatOptions) => ({ scores: Array.from({ length: Number(/共 (\d+) 格/.exec(o.user)?.[1]) }, (_, i) => ({ index: i + 1, relevance: 3, aesthetic: 5, brand: 5, clean: 5, tech: 5 })) });
    const broken = fakeDeps([wiki(POOL)], { image: async (p, out) => { if (p.includes('HOOK')) { copyFileSync(join(fx, 'hook.jpg'), out); return { cost: 0.2 }; } throw new Error('生图服务 502'); } });
    const r2 = await go({ brollDeps: broken.deps, llm: fakeLlm({ beats: { beats: [beat(5, 8, 'broll-full')] }, score: low }) });
    expect(brollShots(r2.out)).toEqual([]);
    expect(r2.out.shots[1]).toMatchObject({ layout: 'full' });
    expect(r2.patches.at(-1)?.broll?.beats?.[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('生图失败') });
  });

  it('预算不够：不审片、不生图（节拍跳过，镜头保持原样）', async () => {
    const meter = new CostMeter({}, 0.3);
    meter.addTask('x', 0.25, '前序步骤');
    const { deps, calls } = fakeDeps([wiki(POOL)]);
    const llm = fakeLlm();
    const r = await go({ brollDeps: deps, llm, meter });
    expect(calls.image).toEqual([]);
    expect(llm.labels).not.toContain('B-roll 审片打分');
    expect(brollShots(r.out)).toEqual([]);
  });

  it('B-roll 上限（每 2 分钟 ¥4）够用时，钩子图做图生视频（受 maxVideos 约束）', async () => {
    const { deps, calls } = fakeDeps([wiki(POOL)]);
    const r = await go({ brollDeps: deps, llm: fakeLlm({ beats: { beats: [] } }) }, STORYBOARD());
    expect(calls.video).toEqual([]); // 40 秒片上限 ¥1.33，放不下 ¥2.4 的视频
    const long = await runBroll({ workDir: mkdtempSync(join(tmpdir(), 'mz-bstep-long-')), cfg, broll: { enabled: true, maxVideos: 1, budgetYuan: 10 }, brollDeps: deps, llm: fakeLlm({ beats: { beats: [] } }), captions: CAPTIONS },
      STORYBOARD(), 120, () => ({}) as ProjectFile);
    expect(calls.video).toEqual(['HOOK slow push-in on a contract']);
    expect(long.shots[0].card).toMatchObject({ template: 'hook', props: { video: expect.stringMatching(/\.mp4$/), image: expect.stringMatching(/\.jpg$/) } });
  });

  it('规划失败：卡片素材照取，节拍整体跳过，不中断', async () => {
    const { deps } = fakeDeps([wiki(POOL)]);
    const r = await go({ brollDeps: deps, llm: fakeLlm({ beats: { nope: 1 } }) });
    expect(brollShots(r.out)).toEqual([]);
    expect(r.out.shots[0].card).toMatchObject({ props: { image: expect.stringMatching(/^broll\//) } });
    expect(r.events.some((e) => e.message.includes('节拍规划失败'))).toBe(true);
  });

  it('余额不足原样抛出（不降级成「素材获取失败」）', async () => {
    const { deps } = fakeDeps([wiki(POOL)]);
    const llm = fakeLlm({ score: () => { throw new InsufficientBalanceError(); } });
    await expect(go({ brollDeps: deps, llm })).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});

describe('节拍落点', () => {
  it('落在还没有图的钩子上：素材铺在钩子上半屏做底，钩子不再生图；记录落点', async () => {
    const { deps, calls } = fakeDeps([wiki(POOL)]);
    const r = await go({ brollDeps: deps, llm: fakeLlm({ beats: { beats: [beat(0.5, 3.5, 'broll-full'), beat(5, 8, 'broll-full', 'footage')] } }) });
    expect(r.out.shots[0]).toMatchObject({ layout: 'split', card: { template: 'hook' }, broll: { file: expect.stringMatching(/^broll\//) } });
    expect(calls.image.filter((p) => p.includes('HOOK'))).toEqual([]);
    expect(r.patches.at(-1)?.broll?.beats?.map((b) => [b.status, b.placement])).toEqual([['placed', 'card'], ['placed', 'free']]);
  });
});

describe('修改版本：换一张 B-roll', () => {
  it('生图素材连续换两次：三张不同的图（同一节拍第 n 次生成换变体与缓存键），用原节拍的完整字段', async () => {
    const low = (o: ChatOptions) => ({ scores: Array.from({ length: Number(/共 (\d+) 格/.exec(o.user)?.[1]) }, (_, i) => ({ index: i + 1, relevance: 2, aesthetic: 5, brand: 5, clean: 5, tech: 5 })) });
    const { deps, calls } = fakeDeps([wiki(POOL)]);
    const mustShow = { mustShow: ['合同纸张'] };
    const llm = () => fakeLlm({ beats: { beats: [beat(5, 8, 'broll-full', 'photo', mustShow)] }, score: low });
    const first = await go({ brollDeps: deps, llm: llm() });
    const records = first.patches.at(-1)?.broll?.beats ?? [];
    const k = first.out.shots.findIndex((s) => s.broll);
    const files = [first.out.shots[k].broll?.file];
    let sb = first.out;
    let recs = records;
    for (let n = 0; n < 2; n += 1) {
      const at = [(sb.shots[k].start + sb.shots[k].end) / 2];
      const redo = await go({ brollDeps: deps, llm: llm(), edit: { redoAt: at, marks: {}, records: recs } }, sb, first.dir);
      sb = redo.out;
      recs = redo.patches.at(-1)?.broll?.beats ?? recs;
      files.push(sb.shots[k].broll?.file);
    }
    expect(new Set(files).size).toBe(3);
    const gens = calls.image.filter((p) => !p.includes('HOOK'));
    expect(gens).toHaveLength(3);
    expect(gens.every((p) => p.includes('合同纸张'))).toBe(true); // 重做时用原节拍的 mustShow
    expect(gens[1]).toContain('Variation 1');
    expect(gens[2]).toContain('Variation 2');
  });

  it('只重做指向的镜头（换成没用过的素材），其余镜头不动；标了 remove 的去掉素材；不重新规划', async () => {
    const { deps } = fakeDeps([wiki(POOL)]);
    const first = await go({ brollDeps: deps, llm: fakeLlm() });
    const records = first.patches.at(-1)?.broll?.beats ?? [];
    const target = first.out.shots.findIndex((s) => s.layout === 'broll');
    const old = first.out.shots[target];
    const llm = fakeLlm();
    const at = [(old.start + old.end) / 2];
    const redo = await go({ brollDeps: deps, llm, edit: { redoAt: at, marks: {}, records } }, first.out, first.dir);
    expect(llm.labels).not.toContain('视觉节拍');
    const changed = redo.out.shots.flatMap((s, i) => (JSON.stringify(s) !== JSON.stringify(first.out.shots[i]) ? [i] : []));
    expect(changed).toEqual([target]);
    expect(redo.out.shots[target].broll?.file).not.toBe(old.broll?.file);
    expect(brollShots(first.out).map((s) => s.broll?.file)).not.toContain(redo.out.shots[target].broll?.file);

    const marks = { [old.broll?.file ?? '']: 'remove' as const, [brollShots(first.out)[1].broll?.file ?? '']: 'remove' as const };
    const removed = await go({ brollDeps: deps, llm: fakeLlm(), edit: { redoAt: at, marks, records } }, first.out, first.dir);
    expect(removed.out.shots.filter((s) => s.broll)).toHaveLength(3); // 只处理 op 指向的那个镜头的标记
    expect(removed.out.shots.some((s) => s.broll?.file === old.broll?.file)).toBe(false);
  });
});

describe('意外异常的降级', () => {
  it('收尾出错（写 credits 失败）：只放弃本次新增，已有的素材（父版本已付费）保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-bstep-keep-'));
    mkdirSync(join(dir, 'broll'), { recursive: true });
    copyFileSync(join(fx, 'p0.jpg'), join(dir, 'broll', 'old.jpg'));
    const kept: Storyboard = { shots: [{ start: 0, end: 4, layout: 'full' }, { start: 4, end: 7, layout: 'broll', broll: { file: 'broll/old.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } }, { start: 7, end: 40, layout: 'full' }] };
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x');
    const { deps } = fakeDeps([wiki(POOL)]);
    const r = await go({ brollDeps: deps, llm: fakeLlm({ beats: { beats: [] } }), creditsDir: join(asFile, 'sub') }, kept, dir);
    expect(r.events.at(-1)?.message).toContain('已保留已有素材');
    expect(r.out.shots.find((s) => s.broll)?.broll?.file).toBe('broll/old.jpg');
  });
});

describe('credits.json 写到指定目录', () => {
  it('creditsDir 给出时写到那里（工作台是版本目录）', async () => {
    const { deps } = fakeDeps([wiki(POOL)]);
    const out = mkdtempSync(join(tmpdir(), 'mz-bstep-v-'));
    mkdirSync(out, { recursive: true });
    await go({ brollDeps: deps, llm: fakeLlm({ beats: { beats: [beat(5, 8, 'broll-full')] } }), creditsDir: out });
    expect(JSON.parse(readFileSync(join(out, 'credits.json'), 'utf8')).length).toBeGreaterThan(0);
  });
});
