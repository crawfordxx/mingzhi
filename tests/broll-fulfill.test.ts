import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fulfillVisuals, upgradeToVideo, visualKey, type BrollAsset, type BrollDeps } from '../src/broll/fulfill.js';
import { makeDeps } from '../src/broll/deps.js';
import { loadConfig } from '../src/config.js';
import { COVER_YUAN } from '../src/cost/estimate.js';
import { CostMeter } from '../src/cost/meter.js';
import { FALLBACK_PRICES } from '../src/cost/prices.js';
import type { Shot, Storyboard, Visual } from '../src/storyboard/schema.js';

const DURATION = 60;
const workDir = (): string => mkdtempSync(join(tmpdir(), 'mz-ff-'));
const touch = (out: string): void => writeFileSync(out, 'x');

interface Calls { screenshot: string[]; search: string[]; image: string[]; video: string[]; pexels: string[] }
type Overrides = Partial<BrollDeps> & { imageCost?: number; videoCost?: number };

/** 假依赖：默认全部成功并写出文件；overrides 可替换某个依赖；pexels 默认不提供 */
function fakeDeps(overrides: Overrides = {}): { deps: BrollDeps; calls: Calls } {
  const calls: Calls = { screenshot: [], search: [], image: [], video: [], pexels: [] };
  const { imageCost = 0.2, videoCost = 2.4, ...rest } = overrides;
  const deps: BrollDeps = {
    screenshot: async (url, out) => { calls.screenshot.push(url); touch(out); },
    search: async (q) => { calls.search.push(q); return ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']; },
    image: async (prompt, out) => { calls.image.push(prompt); touch(out); return { cost: imageCost, url: `https://img.example/${calls.image.length}.jpg` }; },
    video: async (prompt, _imageUrl, out) => { calls.video.push(prompt); touch(out); return { cost: videoCost }; },
    ...rest,
  };
  return { deps, calls };
}
const withPexels = (calls: Calls, ok = true): Pick<BrollDeps, 'pexels'> => ({ pexels: async (q, out) => { calls.pexels.push(q); if (ok) touch(out); return ok; } });

const photo = (start: number, visual: Exclude<Visual, { source: 'video' }>): Shot => ({ start, end: start + 5, layout: 'split', card: { template: 'photo', props: { visual } } });
const browser = (start: number, visual: Extract<Visual, { source: 'screenshot' }>): Shot => ({ start, end: start + 5, layout: 'split', card: { template: 'browser', props: { url: 'example.com', visual } } });
const hook = (start: number, visual: Extract<Visual, { prompt: string }>): Shot => ({ start, end: start + 4, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '标题', highlight: [], visual } } });
const board = (...shots: Shot[]): Storyboard => ({ shots });
const opts = (dir: string, extra: Partial<Parameters<typeof fulfillVisuals>[2]> = {}) => ({ workDir: dir, durationSec: DURATION, maxVideos: 2, budgetYuan: 10, ...extra });
const gen = (prompt: string): Extract<Visual, { source: 'generate' }> => ({ source: 'generate', prompt });
const vid = (prompt: string): Extract<Visual, { source: 'video' }> => ({ source: 'video', prompt });
const shotCard = (sb: Storyboard, i: number) => sb.shots[i]?.card;

describe('visualKey', () => {
  it('相同需求同键，12 位十六进制', () => {
    expect(visualKey(gen('a jar of coins'))).toBe(visualKey(gen('a jar of coins')));
    expect(visualKey(gen('a jar of coins'))).toMatch(/^[0-9a-f]{12}$/);
    expect(visualKey({ source: 'generate', prompt: 'a jar of coins' })).toBe(visualKey({ prompt: 'a jar of coins', source: 'generate' } as Visual));
    expect(visualKey(gen('a jar of coins'))).not.toBe(visualKey(gen('another prompt here')));
  });
});

describe('fulfillVisuals 缓存', () => {
  it('缓存命中不调用依赖、不计费，文件名写回', async () => {
    const dir = workDir();
    const visual = gen('a jar of coins on a table');
    const key = visualKey(visual);
    mkdirSync(join(dir, 'broll'));
    touch(join(dir, 'broll', `${key}.jpg`));
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(board(photo(0, visual)), deps, opts(dir));
    expect(calls.image).toEqual([]);
    expect(r.costYuan).toBe(0);
    expect(r.failures).toEqual([]);
    expect(shotCard(r.storyboard, 0)).toMatchObject({ template: 'photo', props: { image: `broll/${key}.jpg` } });
  });
});

describe('fulfillVisuals 缓存校验', () => {
  it('缓存命中的素材标记 cached: true，jpg 标为 generate', async () => {
    const dir = workDir();
    const visual = gen('a jar of coins on a table');
    mkdirSync(join(dir, 'broll'));
    touch(join(dir, 'broll', `${visualKey(visual)}.jpg`));
    const r = await fulfillVisuals(board(photo(0, visual)), fakeDeps().deps, opts(dir));
    expect(r.assets[0]).toMatchObject({ cached: true, source: 'generate' });
  });

  it('大小为 0 的缓存文件视为缺失：删除后重新获取', async () => {
    const dir = workDir();
    const visual = gen('a jar of coins on a table');
    mkdirSync(join(dir, 'broll'));
    writeFileSync(join(dir, 'broll', `${visualKey(visual)}.jpg`), '');
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(board(photo(0, visual)), deps, opts(dir));
    expect(calls.image).toHaveLength(1);
    expect(r.assets[0]?.cached).toBeUndefined();
  });

  it('缓存的 mp4 也受 maxVideos 约束：上限 0 时不用，改为生图；上限 1 时第二个缓存视频同样不用', async () => {
    const dir = workDir();
    const [v1, v2] = [vid('slow push-in on a glass of cola'), vid('slow pan across a messy desk')];
    mkdirSync(join(dir, 'broll'));
    for (const v of [v1, v2]) touch(join(dir, 'broll', `${visualKey(v)}.mp4`));
    const none = fakeDeps();
    const r0 = await fulfillVisuals(board(hook(0, v1)), none.deps, opts(dir, { maxVideos: 0 }));
    expect(none.calls.image).toHaveLength(1);
    expect(r0.assets.map((a) => a.source)).toEqual(['generate']);
    const one = fakeDeps();
    const r1 = await fulfillVisuals(board(hook(0, v1), hook(5, v2)), one.deps, opts(dir, { maxVideos: 1 }));
    expect(r1.assets.map((a) => [a.source, a.cached])).toEqual([['video', true], ['generate', undefined]]);
    expect(one.calls.image).toHaveLength(1);
  });

  it('onStart 只在真正去取素材前回调（缓存命中不回调）；视频需求只生图，不在这里发起视频', async () => {
    const dir = workDir();
    const cached = gen('a jar of coins on a table');
    mkdirSync(join(dir, 'broll'));
    touch(join(dir, 'broll', `${visualKey(cached)}.jpg`));
    const fresh = vid('slow push-in on a glass of cola');
    const started: number[] = [];
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(board(photo(0, cached), hook(5, fresh)), deps, opts(dir, { onStart: (n) => started.push(n.shotIndex) }));
    expect(started).toEqual([1]);
    expect(calls.video).toEqual([]);
    expect(r.videoWanted).toEqual([{ shotIndex: 1, key: visualKey(fresh), prompt: fresh.prompt, imageUrl: 'https://img.example/1.jpg' }]);
  });

  it('图生视频写到临时文件再改名、onStatus 透传、以生成图为首帧，成功后写回 hook.props.video（图片保留）', async () => {
    const dir = workDir();
    const outs: string[] = [];
    const statuses: string[] = [];
    const firstFrames: string[] = [];
    const { deps } = fakeDeps({ video: async (_p, imageUrl, out, onStatus) => { firstFrames.push(imageUrl); onStatus?.('running'); outs.push(out); touch(out); return { cost: 2.4 }; } });
    const visual = vid('slow push-in on a glass of cola');
    const r = await fulfillVisuals(board(hook(0, visual)), deps, opts(dir));
    const up = await upgradeToVideo(r.storyboard, r.videoWanted, deps, { workDir: dir, maxVideos: 1, onStatus: (st) => statuses.push(st) });
    const final = join(dir, `broll/${visualKey(visual)}.mp4`);
    expect(outs[0]).toMatch(/\.part\.mp4$/);
    expect(existsSync(final)).toBe(true);
    expect(existsSync(outs[0] as string)).toBe(false);
    expect(statuses).toEqual(['running']);
    expect(firstFrames).toEqual(['https://img.example/1.jpg']);
    expect(shotCard(up.storyboard, 0)).toMatchObject({ template: 'hook', props: { video: `broll/${visualKey(visual)}.mp4`, image: r.assets[0]?.file, visual } });
    expect(up.assets.map((a) => a.source)).toEqual(['video']);
  });
});

describe('fulfillVisuals 截图', () => {
  it('有 url 先联网核实（搜索结果里有同一域名）再截图，相对路径写回 browser.image，visual 保留', async () => {
    const dir = workDir();
    const visual: Visual = { source: 'screenshot', url: 'https://example.com/page' };
    const { deps, calls } = fakeDeps({ search: async (q) => { calls.search.push(q); return ['https://www.example.com/about']; } });
    const r = await fulfillVisuals(board(browser(0, visual)), deps, opts(dir));
    expect(calls.search).toEqual(['example.com']);
    expect(calls.screenshot).toEqual(['https://example.com/page']);
    const file = `broll/${visualKey(visual)}.png`;
    expect(existsSync(join(dir, file))).toBe(true);
    expect(shotCard(r.storyboard, 0)).toMatchObject({ template: 'browser', props: { image: file, visual } });
    expect(r.assets[0]).toMatchObject({ source: 'screenshot', url: 'https://example.com/page', file });
  });

  it('只有 query 时先搜索，第一个网址失败则用第二个', async () => {
    const dir = workDir();
    const { deps, calls } = fakeDeps({ screenshot: async (url, out) => { calls.screenshot.push(url); if (url.includes('a.example')) throw new Error('空白页'); touch(out); } });
    const r = await fulfillVisuals(board(browser(0, { source: 'screenshot', query: 'openai pricing' })), deps, opts(dir));
    expect(calls.search).toEqual(['openai pricing']);
    expect(calls.screenshot).toEqual(['https://a.example/1', 'https://b.example/2']);
    expect(r.assets[0]?.url).toBe('https://b.example/2');
  });

  it('photo 截图全失败退到生图（提示词由 query 改写）', async () => {
    const dir = workDir();
    const { deps, calls } = fakeDeps({ screenshot: async () => { throw new Error('boom'); } });
    const r = await fulfillVisuals(board(photo(0, { source: 'screenshot', query: 'gold price chart' })), deps, opts(dir));
    expect(calls.image).toEqual(['Editorial photo illustrating: gold price chart']);
    expect(r.assets[0]?.source).toBe('generate');
    expect(r.failures).toEqual([]);
    expect(shotCard(r.storyboard, 0)).toMatchObject({ template: 'photo', props: { image: r.assets[0]?.file } });
  });

  it('browser 截图全失败则放弃，卡片无图保留', async () => {
    const dir = workDir();
    const { deps, calls } = fakeDeps({ screenshot: async () => { throw new Error('boom'); } });
    const r = await fulfillVisuals(board(browser(0, { source: 'screenshot', query: 'openai pricing' })), deps, opts(dir));
    expect(calls.image).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ shotIndex: 0 });
    expect(shotCard(r.storyboard, 0)).toMatchObject({ template: 'browser' });
    expect(shotCard(r.storyboard, 0)).not.toHaveProperty('props.image');
  });

  it('搜索抛错记为失败而不抛出', async () => {
    const { deps } = fakeDeps({ search: async () => { throw new Error('网络'); } });
    const r = await fulfillVisuals(board(browser(0, { source: 'screenshot', query: 'abc def' })), deps, opts(workDir()));
    expect(r.failures[0]?.reason).toContain('搜索失败');
  });
});

describe('fulfillVisuals 生图与图库', () => {
  it('生图失败退 Pexels（搜索词取提示词前 6 个单词）', async () => {
    const dir = workDir();
    const { deps, calls } = fakeDeps({ image: async () => { throw new Error('生成失败'); } });
    const r = await fulfillVisuals(board(photo(0, gen('one two three four five six seven eight'))), { ...deps, ...withPexels(calls) }, opts(dir));
    expect(calls.pexels).toEqual(['one two three four five six']);
    expect(r.assets[0]).toMatchObject({ source: 'pexels' });
    expect(r.costYuan).toBe(0);
  });

  it('截图退到生图再退 Pexels 时，搜索词用原始 query 而非改写后的提示词', async () => {
    const { deps, calls } = fakeDeps({ screenshot: async () => { throw new Error('boom'); }, image: async () => { throw new Error('生成失败'); } });
    await fulfillVisuals(board(photo(0, { source: 'screenshot', query: 'gold price chart' })), { ...deps, ...withPexels(calls) }, opts(workDir()));
    expect(calls.pexels).toEqual(['gold price chart']);
  });

  it('生图成功时不调 Pexels', async () => {
    const { deps, calls } = fakeDeps();
    await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), { ...deps, ...withPexels(calls) }, opts(workDir()));
    expect(calls.pexels).toEqual([]);
  });

  it('生图和 Pexels 都失败则放弃', async () => {
    const { deps, calls } = fakeDeps({ image: async () => { throw new Error('生成失败'); } });
    const r = await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), { ...deps, ...withPexels(calls, false) }, opts(workDir()));
    expect(r.assets).toEqual([]);
    expect(r.failures).toHaveLength(1);
  });

  it('Pexels 抛错（401/429）当作失败而不抛出', async () => {
    const { deps } = fakeDeps({ image: async () => { throw new Error('生成失败'); } });
    const r = await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), { ...deps, pexels: async () => { throw new Error('Pexels 搜索失败 429'); } }, opts(workDir()));
    expect(r.failures[0]?.reason).toContain('429');
  });

  it('没有 pexels 依赖时放弃，photo 被丢弃变全屏', async () => {
    const { deps } = fakeDeps({ image: async () => { throw new Error('生成失败'); } });
    const sb = board(photo(10, gen('a jar of coins on a table')));
    const r = await fulfillVisuals(sb, deps, opts(workDir()));
    expect(r.failures).toHaveLength(1);
    expect(r.storyboard.shots.every((s) => s.layout === 'full' && s.card === undefined)).toBe(true);
  });
});

describe('fulfillVisuals photo 的 visual', () => {
  it('取到素材的 photo 经最终归一化后不再带 visual（P5 重新生成自带 visual）', async () => {
    const r = await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), fakeDeps().deps, opts(workDir()));
    expect(shotCard(r.storyboard, 0)).toMatchObject({ template: 'photo', props: { image: r.assets[0]?.file } });
    expect(shotCard(r.storyboard, 0)).not.toHaveProperty('props.visual');
  });
});

describe('fulfillVisuals 视频与预算', () => {
  it('upgradeToVideo：最多 maxVideos 条；失败只记原因，钩子保留图片', async () => {
    const dir = workDir();
    const { deps, calls } = fakeDeps({ video: async (p) => { calls.video.push(p); throw new Error('超时'); } });
    const sb = board(hook(0, vid('first video prompt here')), hook(4, vid('second video prompt here')));
    const r = await fulfillVisuals(sb, deps, opts(dir));
    expect(calls.image).toEqual(['first video prompt here', 'second video prompt here']);
    const up = await upgradeToVideo(r.storyboard, r.videoWanted, deps, { workDir: dir, maxVideos: 1 });
    expect(calls.video).toEqual(['first video prompt here']);
    expect(up.failures[0]).toContain('图生视频失败');
    expect(shotCard(up.storyboard, 0)).toMatchObject({ props: { image: r.assets[0]?.file } });
    expect(shotCard(up.storyboard, 0)).not.toHaveProperty('props.video');
  });

  it('upgradeToVideo：预算不够（afford 为假）不发起视频', async () => {
    const dir = workDir();
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(board(hook(0, vid('first video prompt here'))), deps, opts(dir));
    const up = await upgradeToVideo(r.storyboard, r.videoWanted, deps, { workDir: dir, maxVideos: 1, afford: (est) => est < 1 });
    expect(calls.video).toEqual([]);
    expect(up.failures).toEqual([]);
    expect(up.skipped).toEqual(['钩子图生视频超出预算，保留图片']);
  });

  it('afford 代替 meter / budgetYuan 的检查（B-roll 上限）', async () => {
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), deps, opts(workDir(), { afford: () => false }));
    expect(calls.image).toEqual([]);
    expect(r.failures).toEqual([{ shotIndex: 0, reason: '超出预算' }]);
  });

  it('预算 0.3 元：第 1 张图之后再生图超预算，记 failure「超出预算」且不再调用', async () => {
    const { deps, calls } = fakeDeps();
    const sb = board(hook(0, vid('first video prompt here')), hook(4, vid('second video prompt here')));
    const r = await fulfillVisuals(sb, deps, opts(workDir(), { budgetYuan: 0.3 }));
    expect(calls.image).toHaveLength(1);
    expect(r.failures).toEqual([{ shotIndex: 1, reason: '超出预算' }]);
    expect(r.costYuan).toBeCloseTo(0.2);
  });

  it('接口没返回 cost 时按预估计费', async () => {
    const { deps } = fakeDeps({ image: async (_p, out) => { touch(out); return {}; } });
    const r = await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), deps, opts(workDir()));
    expect(r.costYuan).toBeCloseTo(0.2);
  });

  it('costYuan 等于各素材 cost 之和，onAsset 逐个回调（含失败）', async () => {
    const events: (BrollAsset | { key: string; failed: string })[] = [];
    const { deps } = fakeDeps({ imageCost: 0.25, screenshot: async () => { throw new Error('boom'); } });
    const sb = board(
      hook(0, vid('first video prompt here')),
      photo(4, gen('a jar of coins on a table')),
      browser(9, { source: 'screenshot', query: 'openai pricing' }),
    );
    const r = await fulfillVisuals(sb, deps, opts(workDir(), { onAsset: (a) => events.push(a) }));
    expect(r.costYuan).toBeCloseTo(0.5);
    expect(r.costYuan).toBeCloseTo(r.assets.reduce((s, a) => s + (a.cost ?? 0), 0));
    expect(events).toHaveLength(3);
    expect(events.filter((e) => 'failed' in e)).toHaveLength(1);
  });
});

describe('fulfillVisuals 统一记账', () => {
  /** 假依赖像真实任务客户端那样把花费记进 meter（返回的 cost 仅用于展示） */
  const metered = (meter: CostMeter) => {
    const calls = { image: [] as string[] };
    const { deps } = fakeDeps({
      image: async (p, out) => { calls.image.push(p); touch(out); meter.addTask('image', 0.2, '生图'); return { cost: 0.2 }; },
    });
    return { deps, calls };
  };

  it('预算以 meter 为准：meter 里前面步骤已花的钱也算', async () => {
    const meter = new CostMeter(FALLBACK_PRICES, 1.2);
    meter.addChat('openai/gpt-5.6-sol', { prompt_tokens: 10000, completion_tokens: 5000 }, '前序步骤'); // 0.98
    const { deps, calls } = metered(meter);
    const sb = board(hook(0, vid('first video prompt here')), hook(4, vid('second video prompt here')));
    const r = await fulfillVisuals(sb, deps, opts(workDir(), { meter, budgetYuan: 100 }));
    expect(calls.image).toHaveLength(1); // 0.98 + 0.2 ≤ 1.2，再一张就超
    expect(meter.total).toBeCloseTo(1.18);
    expect(r.failures).toEqual([{ shotIndex: 1, reason: '超出预算' }]);
  });

  it('costYuan 只用于展示，不会再叠加进 meter（不重复记账）', async () => {
    const meter = new CostMeter(FALLBACK_PRICES, 10);
    const { deps } = metered(meter);
    const r = await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), deps, opts(workDir(), { meter }));
    expect(r.costYuan).toBeCloseTo(0.2);
    expect(meter.total).toBeCloseTo(0.2);
  });
});

describe('fulfillVisuals 网址核实', () => {
  it('模型给的网址搜不到同一域名：不截它，改截搜索给出的网址', async () => {
    const { deps, calls } = fakeDeps({ search: async (q) => { calls.search.push(q); return ['https://real.example.org/jobs']; } });
    const r = await fulfillVisuals(board(browser(0, { source: 'screenshot', url: 'https://made-up.example.com/x', query: 'FDE 招聘' })), deps, opts(workDir()));
    expect(calls.search).toEqual(['made-up.example.com FDE 招聘']);
    expect(calls.screenshot).toEqual(['https://real.example.org/jobs']);
    expect(r.assets[0]?.url).toBe('https://real.example.org/jobs');
  });

  it('核实时搜索失败：不截未核实的网址，记失败', async () => {
    const { deps, calls } = fakeDeps({ search: async () => { throw new Error('网络中断'); } });
    const r = await fulfillVisuals(board(browser(0, { source: 'screenshot', url: 'https://example.com/page' })), deps, opts(workDir()));
    expect(calls.screenshot).toEqual([]);
    expect(r.failures[0]?.reason).toContain('搜索失败');
  });
});

describe('fulfillVisuals 搜索与封面预留', () => {
  const shotQuery = (): Storyboard => board(browser(0, { source: 'screenshot', query: 'central bank rate decision' }));

  it('联网搜索前检查预算：剩余不足 0.05 时不调用 search，按超出预算跳过', async () => {
    const meter = new CostMeter(FALLBACK_PRICES, 1);
    meter.addChat('openai/gpt-5.6-sol', { prompt_tokens: 10000, completion_tokens: 5000 }, '前序步骤'); // 0.98，剩 0.02
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(shotQuery(), deps, opts(workDir(), { meter }));
    expect(calls.search).toEqual([]);
    expect(r.failures).toEqual([{ shotIndex: 0, reason: '超出预算' }]);
  });

  it('预算够搜索时照常搜索并截图', async () => {
    const meter = new CostMeter(FALLBACK_PRICES, 1);
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(shotQuery(), deps, opts(workDir(), { meter }));
    expect(calls.search).toEqual(['central bank rate decision']);
    expect(r.failures).toEqual([]);
  });

  it('reserveYuan：预算 = 图价 + 预留 − 0.01 时不生图，恰好够时生图', async () => {
    const sb = board(photo(0, gen('a jar of coins on a table')));
    const short = fakeDeps();
    const r1 = await fulfillVisuals(sb, short.deps, opts(workDir(), { meter: new CostMeter(FALLBACK_PRICES, 0.2 + COVER_YUAN - 0.01), reserveYuan: COVER_YUAN }));
    expect(short.calls.image).toEqual([]);
    expect(r1.failures).toEqual([{ shotIndex: 0, reason: '超出预算' }]);
    const enough = fakeDeps();
    await fulfillVisuals(sb, enough.deps, opts(workDir(), { meter: new CostMeter(FALLBACK_PRICES, 0.2 + COVER_YUAN), reserveYuan: COVER_YUAN }));
    expect(enough.calls.image).toHaveLength(1);
  });

  it('没有 meter 时 reserveYuan 同样参与本步预算检查；缺省不预留', async () => {
    const sb = board(photo(0, gen('a jar of coins on a table')));
    const a = fakeDeps();
    await fulfillVisuals(sb, a.deps, opts(workDir(), { budgetYuan: 0.2 + COVER_YUAN - 0.01, reserveYuan: COVER_YUAN }));
    expect(a.calls.image).toEqual([]);
    const b = fakeDeps();
    await fulfillVisuals(sb, b.deps, opts(workDir(), { budgetYuan: 0.2 }));
    expect(b.calls.image).toHaveLength(1);
  });
});

describe('makeDeps', () => {
  it('没有 pexelsKey 时不提供 pexels', () => {
    const task = { run: async () => ({ taskId: '1', url: 'x' }) };
    expect(makeDeps({ apiKey: 'k', task, cfg: loadConfig({}) }).pexels).toBeUndefined();
    expect(typeof makeDeps({ apiKey: 'k', task, cfg: loadConfig({}), pexelsKey: 'p' }).pexels).toBe('function');
  });
});
