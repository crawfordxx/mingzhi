import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fulfillVisuals, makeDeps, visualKey, type BrollAsset, type BrollDeps } from '../src/broll/fulfill.js';
import { loadConfig } from '../src/config.js';
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
    image: async (prompt, out) => { calls.image.push(prompt); touch(out); return { cost: imageCost }; },
    video: async (prompt, out) => { calls.video.push(prompt); touch(out); return { cost: videoCost }; },
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

  it('onStart 只在真正去取素材前回调（缓存命中不回调）；onStatus 透传给视频依赖', async () => {
    const dir = workDir();
    const cached = gen('a jar of coins on a table');
    mkdirSync(join(dir, 'broll'));
    touch(join(dir, 'broll', `${visualKey(cached)}.jpg`));
    const fresh = vid('slow push-in on a glass of cola');
    const started: number[] = [];
    const statuses: string[] = [];
    const { deps } = fakeDeps({ video: async (_p, out, onStatus) => { onStatus?.('running'); touch(out); return { cost: 2.4 }; } });
    await fulfillVisuals(board(photo(0, cached), hook(5, fresh)), deps, opts(dir, { onStart: (n) => started.push(n.shotIndex), onStatus: (s) => statuses.push(s) }));
    expect(started).toEqual([1]);
    expect(statuses).toEqual(['running']);
  });

  it('依赖写到临时文件再改名：成功后只留正式文件，失败不留残留', async () => {
    const dir = workDir();
    const outs: string[] = [];
    const { deps } = fakeDeps({ video: async (_p, out) => { outs.push(out); touch(out); return { cost: 2.4 }; } });
    const visual = vid('slow push-in on a glass of cola');
    await fulfillVisuals(board(hook(0, visual)), deps, opts(dir));
    const final = join(dir, `broll/${visualKey(visual)}.mp4`);
    expect(outs[0]).toMatch(/\.part\.mp4$/);
    expect(existsSync(final)).toBe(true);
    expect(existsSync(outs[0] as string)).toBe(false);
  });
});

describe('fulfillVisuals 截图', () => {
  it('有 url 直接截图，相对路径写回 browser.image，visual 保留', async () => {
    const dir = workDir();
    const visual: Visual = { source: 'screenshot', url: 'https://example.com/page' };
    const { deps, calls } = fakeDeps();
    const r = await fulfillVisuals(board(browser(0, visual)), deps, opts(dir));
    expect(calls.search).toEqual([]);
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
  it('视频失败也计入 maxVideos：第 2 个视频需求不再发起视频', async () => {
    const videoPrompts: string[] = [];
    const { deps, calls } = fakeDeps({ video: async (p) => { videoPrompts.push(p); throw new Error('超时'); } });
    const sb = board(hook(0, vid('first video prompt here')), hook(4, vid('second video prompt here')));
    const r = await fulfillVisuals(sb, deps, opts(workDir(), { maxVideos: 1 }));
    expect(videoPrompts).toEqual(['first video prompt here']);
    expect(calls.image).toEqual(['first video prompt here', 'second video prompt here']);
    expect(r.assets.map((a) => a.source)).toEqual(['generate', 'generate']);
  });

  it('hook 视频写回 hook.props.video', async () => {
    const { deps } = fakeDeps();
    const visual = vid('slow push-in on a glass of cola');
    const r = await fulfillVisuals(board(hook(0, visual)), deps, opts(workDir()));
    expect(shotCard(r.storyboard, 0)).toMatchObject({ template: 'hook', props: { video: `broll/${visualKey(visual)}.mp4`, visual } });
    expect(r.assets[0]?.source).toBe('video');
  });

  it('maxVideos=1 时第 2 个视频需求改为生图', async () => {
    const { deps, calls } = fakeDeps();
    const sb = board(hook(0, vid('first video prompt here')), hook(4, vid('second video prompt here')));
    const r = await fulfillVisuals(sb, deps, opts(workDir(), { maxVideos: 1 }));
    expect(calls.video).toEqual(['first video prompt here']);
    expect(calls.image).toEqual(['second video prompt here']);
    expect(r.assets.map((a) => a.source)).toEqual(['video', 'generate']);
    expect(shotCard(r.storyboard, 1)).toMatchObject({ props: { image: r.assets[1]?.file } });
  });

  it('视频失败退到生图', async () => {
    const { deps, calls } = fakeDeps({ video: async () => { throw new Error('超时'); } });
    const r = await fulfillVisuals(board(hook(0, vid('slow push-in on a glass of cola'))), deps, opts(workDir()));
    expect(calls.image).toHaveLength(1);
    expect(r.assets[0]?.source).toBe('generate');
  });

  it('预算 3 元：第 1 个视频之后视频与生图都超预算，记 failure「超出预算」且不再调用', async () => {
    const { deps, calls } = fakeDeps({ videoCost: 2.9 });
    const sb = board(hook(0, vid('first video prompt here')), hook(4, vid('second video prompt here')));
    const r = await fulfillVisuals(sb, deps, opts(workDir(), { budgetYuan: 3 }));
    expect(calls.video).toHaveLength(1);
    expect(calls.image).toEqual([]);
    expect(r.failures).toEqual([{ shotIndex: 1, reason: '超出预算' }]);
    expect(r.costYuan).toBeCloseTo(2.9);
  });

  it('接口没返回 cost 时按预估计费', async () => {
    const { deps } = fakeDeps({ image: async (_p, out) => { touch(out); return {}; } });
    const r = await fulfillVisuals(board(photo(0, gen('a jar of coins on a table'))), deps, opts(workDir()));
    expect(r.costYuan).toBeCloseTo(0.2);
  });

  it('costYuan 等于各素材 cost 之和，onAsset 逐个回调（含失败）', async () => {
    const events: (BrollAsset | { key: string; failed: string })[] = [];
    const { deps } = fakeDeps({ imageCost: 0.25, videoCost: 2.5, screenshot: async () => { throw new Error('boom'); } });
    const sb = board(
      hook(0, vid('first video prompt here')),
      photo(4, gen('a jar of coins on a table')),
      browser(9, { source: 'screenshot', query: 'openai pricing' }),
    );
    const r = await fulfillVisuals(sb, deps, opts(workDir(), { onAsset: (a) => events.push(a) }));
    expect(r.costYuan).toBeCloseTo(2.75);
    expect(r.costYuan).toBeCloseTo(r.assets.reduce((s, a) => s + (a.cost ?? 0), 0));
    expect(events).toHaveLength(3);
    expect(events.filter((e) => 'failed' in e)).toHaveLength(1);
  });
});

describe('makeDeps', () => {
  it('没有 pexelsKey 时不提供 pexels', () => {
    const task = { run: async () => ({ taskId: '1', url: 'x' }) };
    expect(makeDeps({ apiKey: 'k', task, cfg: loadConfig({}) }).pexels).toBeUndefined();
    expect(typeof makeDeps({ apiKey: 'k', task, cfg: loadConfig({}), pexelsKey: 'p' }).pexels).toBe('function');
  });
});
