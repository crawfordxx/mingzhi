import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropBroll, isCardHost, isFree, layoutFor, placeAsset, regionIn, swapBroll, type PlaceAsset } from '../src/broll/assign.js';
import { brollCapYuan, makeBudget } from '../src/broll/budget.js';
import { creditsOf, storyboardFiles, usedOf, writeAssetMeta, type AssetMeta } from '../src/broll/credit-store.js';
import { sizedUrl } from '../src/broll/fetch-original.js';
import { fitOf, gatherCandidates, queriesOf, rankForSheet, type NamedSource } from '../src/broll/gather.js';
import { mergeGapBeats } from '../src/broll/gaps.js';
import { verifiedUrls } from '../src/broll/paid.js';
import { BeatSchema, type Beat } from '../src/broll/plan.js';
import { mapFocal } from '../src/broll/realize.js';
import { restricted } from '../src/broll/sources/wikimedia.js';
import type { Candidate } from '../src/broll/sources/types.js';
import { CostMeter } from '../src/cost/meter.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';
import type { Shot, Storyboard } from '../src/storyboard/schema.js';

const beat = (over: Partial<Beat> = {}): Beat => BeatSchema.parse({
  start: 10, end: 13, role: 'illustrate', kind: 'footage', subject: '仓库里工程师拿平板给工人演示', mustShow: [], avoid: [],
  queryEn: ['engineer tablet warehouse'], queryZh: ['仓库 平板'], present: 'broll-full', shotSize: 'MS', motion: 'static', ...over,
});
const meta = (over: Partial<AssetMeta> = {}): AssetMeta => ({
  credit: { file: 'broll/x.jpg', source: 'wikimedia', page: 'https://commons.wikimedia.org/wiki/File:X.jpg', author: 'Eve', license: 'CC BY 4.0', attributionRequired: true, aiGenerated: false, modified: ['crop', 'lut'], query: 'q', fetchedAt: '2026-10-16T00:00:00Z' },
  candidateId: 'wikimedia:1', kind: 'photo', focal: { x: 0.4, y: 0.5 }, ...over,
});
const asset = (file = 'broll/a.jpg', over: Partial<AssetMeta> = {}): PlaceAsset => ({ file, meta: meta(over) });
const full = (start: number, end: number): Shot => ({ start, end, layout: 'full' });
const card = (start: number, end: number, template: 'title' | 'hook' | 'cta' = 'title'): Shot => ({
  start, end, layout: template === 'cta' ? 'full' : 'split',
  card: template === 'title' ? { template: 'title', props: { title: '标题' } } : template === 'hook' ? { template: 'hook', props: { index: 1, total: 1, headline: '钩子', highlight: [] } } : { template: 'cta', props: { actions: ['关注'] } },
});
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, source: 'wikimedia', kind: 'photo', thumb: `https://t/${id}.jpg`, url: `https://u/${id}.jpg`, width: 1080, height: 1920, page: `https://p/${id}`, license: 'CC0', attributionRequired: false, aiGenerated: false, ...over,
});

describe('regionIn 切段', () => {
  it('贴近 beat；切剩的边角要么为 0、要么不短于 1 秒；全屏插入不超过 3.5 秒', () => {
    expect(regionIn(full(10, 20), 12, 14.5, 3.5)).toEqual([12, 14.5]);
    // beat 离镜头开头只差 0.4 秒：并到开头，不留 0.4 秒的碎片
    expect(regionIn(full(10, 20), 10.4, 13, 3.5)).toEqual([10, 13]);
    // beat 比 3.5 秒长：截到 3.5 秒
    const r = regionIn(full(10, 20), 12, 18, 3.5) as [number, number];
    expect(r[1] - r[0]).toBeCloseTo(3.5);
    // 镜头只有 1.2 秒：放不下 1.5 秒
    expect(regionIn(full(10, 11.2), 10, 11.2, 3.5)).toBeNull();
    // 帧对齐的循环小数边界：取整后不越界
    expect(regionIn(full(6.166666666666667, 8.166666666666666), 6.2, 8.17, 3.5)).toEqual([6.166666666666667, 8.166666666666666]);
  });
});

describe('placeAsset 分配到镜头', () => {
  const sb: Shot[] = [card(0, 4.8, 'hook'), full(4.8, 10), card(10, 16), full(16, 20), card(20, 23, 'cta')];

  it('全屏插入切进人物全屏镜头，前后补人物，不动卡片', () => {
    const r = placeAsset(sb, beat({ start: 6, end: 9 }), asset());
    expect(r.layout).toBe('broll');
    const ins = r.shots.find((s) => s.layout === 'broll');
    expect(ins).toMatchObject({ start: 6, end: 9, broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.4, y: 0.5 } } });
    expect(r.shots.map((s) => [s.start, s.end, s.layout])).toEqual([[0, 4.8, 'split'], [4.8, 6, 'full'], [6, 9, 'broll'], [9, 10, 'full'], [10, 16, 'split'], [16, 20, 'full'], [20, 23, 'full']]);
    expect(sb[1]).toEqual(full(4.8, 10)); // 不改入参
  });

  it('1080p 横屏素材（downgrade split）在人物镜头里改为上半屏铺素材', () => {
    const r = placeAsset(sb, beat({ start: 6, end: 9 }), asset('broll/a.jpg', { downgrade: 'split' }));
    expect(r.layout).toBe('split');
    expect(r.shots.find((s) => s.broll)).toMatchObject({ layout: 'split', start: 6 });
    expect(r.shots.find((s) => s.broll)?.card).toBeUndefined();
  });

  it('分屏 beat 落在普通卡片镜头上：素材铺在上半屏做底，卡片保留', () => {
    const r = placeAsset(sb, beat({ start: 11, end: 14, present: 'split' }), asset());
    expect(r.layout).toBe('split');
    expect(r.shots[2]).toMatchObject({ start: 10, end: 16, layout: 'split', card: { template: 'title' }, broll: { file: 'broll/a.jpg' } });
  });

  it('全屏 beat 只压在卡片镜头上：从卡片头尾切一段做全屏插入，卡片留 2.5 秒，演进时刻随之前移', () => {
    const withReveal: Shot[] = sb.map((s, i) => (i === 2 ? { ...s, card: { template: 'evidenceList', props: { title: '清单', rows: [{ badge: '要点', text: '一' }, { badge: '要点', text: '二' }], reveal: [0.5, 3] } } } : s));
    const r = placeAsset(withReveal, beat({ start: 11, end: 14 }), asset());
    expect(r.layout).toBe('broll');
    expect(r.shots.map((s) => [s.start, s.end, s.layout])).toEqual([[0, 4.8, 'split'], [4.8, 10, 'full'], [10, 11, 'full'], [11, 13.5, 'broll'], [13.5, 16, 'split'], [16, 20, 'full'], [20, 23, 'full']]);
    expect((r.shots[4].card?.props as { reveal?: number[] }).reveal).toEqual([0, 0]);
  });

  it('卡片镜头太短切不出：铺在卡片上半屏做底（分屏升级，对比条等信息卡同样）', () => {
    const short: Shot[] = [full(0, 10), card(10, 13), full(13, 20)];
    const r = placeAsset(short, beat({ start: 10.5, end: 12.5 }), asset());
    expect(r.layout).toBe('split');
    expect(r.shots[1].broll?.file).toBe('broll/a.jpg');
    const dense: Shot[] = [full(0, 10), { start: 10, end: 13, layout: 'split', card: { template: 'compareBars', props: { items: [{ name: '甲', value: 0.5, tone: 'bad' }] } } }, full(13, 20)];
    expect(placeAsset(dense, beat({ start: 10.5, end: 12.5, present: 'split' }), asset())).toMatchObject({ layout: 'split', placement: 'card' });
  });

  it('还没有图的钩子：素材铺在钩子上半屏做底；钩子已有图、CTA 不让占，返回原分镜与原因', () => {
    expect(placeAsset(sb, beat({ start: 0.5, end: 3.5 }), asset())).toMatchObject({ layout: 'split', placement: 'card' });
    const withImage: Shot[] = sb.map((s, i) => (i === 0 && s.card?.template === 'hook' ? { ...s, card: { ...s.card, props: { ...s.card.props, image: 'broll/h.jpg' } } } : s));
    expect(placeAsset(withImage, beat({ start: 0.5, end: 3.5 }), asset())).toMatchObject({ shots: withImage, reason: expect.stringContaining('CTA') });
    expect(placeAsset(sb, beat({ start: 20.5, end: 22.5 }), asset()).layout).toBeUndefined();
  });

  it('落点：人物镜头 free、卡片头尾切 carve', () => {
    expect(placeAsset(sb, beat({ start: 6, end: 9 }), asset()).placement).toBe('free');
    expect(placeAsset([full(0, 10), card(10, 16), full(16, 20)], beat({ start: 11, end: 14 }), asset()).placement).toBe('carve');
  });

  it('角标：截图标来源站点、AI 生成标「AI 生成」，图库不标', () => {
    expect(placeAsset(sb, beat({ start: 6, end: 9 }), asset('broll/s.jpg', { credit: { ...meta().credit, source: 'screenshot', page: 'https://www.minzhi.example.org/a' } })).shots.find((x) => x.broll)?.broll?.label).toEqual({ kind: 'source', text: '来源：minzhi.example.org' });
    expect(placeAsset(sb, beat({ start: 6, end: 9 }), asset('broll/g.jpg', { credit: { ...meta().credit, source: 'generated', aiGenerated: true } })).shots.find((x) => x.broll)?.broll?.label).toEqual({ kind: 'ai', text: 'AI 生成' });
    expect(placeAsset(sb, beat({ start: 6, end: 9 }), asset()).shots.find((x) => x.broll)?.broll?.label).toBeUndefined();
  });

  it('浮层只放素材小窗、画中画放全屏素材', () => {
    expect(placeAsset(sb, beat({ start: 16.5, end: 19, present: 'overlay' }), asset()).layout).toBe('overlay');
    expect(placeAsset(sb, beat({ start: 16.5, end: 19, present: 'pip' }), asset()).layout).toBe('pip');
  });

  it('layoutFor / isFree / isCardHost / swapBroll / dropBroll', () => {
    expect(layoutFor('broll-full')).toBe('broll');
    expect(layoutFor('pip', 'split')).toBe('split');
    expect(layoutFor('split', 'pip')).toBe('overlay');
    expect(isFree(full(0, 1))).toBe(true);
    expect(isCardHost(card(0, 4))).toBe(true);
    expect(isCardHost(card(0, 4, 'hook'))).toBe(true); // 还没有图的钩子可以铺素材
    expect(isCardHost(card(0, 4, 'cta'))).toBe(false);
    const ins: Shot = { start: 0, end: 3, layout: 'broll', broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } };
    expect(swapBroll(ins, asset('broll/b.jpg', { downgrade: 'split' }))).toMatchObject({ layout: 'split', broll: { file: 'broll/b.jpg' } });
    expect(dropBroll(ins)).toEqual({ start: 0, end: 3, layout: 'full' });
    expect(dropBroll({ ...card(0, 4), broll: ins.broll })).toEqual(card(0, 4));
  });
});

describe('预算', () => {
  it('每 2 分钟 ¥4，短片最少够 3 张图（¥1.45）', () => {
    expect(brollCapYuan(120)).toBe(4);
    expect(brollCapYuan(60)).toBe(2);
    expect(brollCapYuan(10)).toBe(1.45);
  });

  it('项目预算（含预留）与 B-roll 上限都要满足；B-roll 花费按 meter 增量算', () => {
    const meter = new CostMeter({}, 10);
    meter.addTask('x', 5, '前序');
    const b = makeBudget({ meter, budgetYuan: 99, reserveYuan: 1.25, capYuan: 1 });
    expect(b.canAfford(0.5)).toBe(true);
    meter.addTask('x', 0.8, 'B-roll');
    expect(b.spent()).toBeCloseTo(0.8);
    expect(b.canAfford(0.3)).toBe(false); // 超过 B-roll 上限 ¥1
    const tight = makeBudget({ meter, budgetYuan: 99, reserveYuan: 4.2, capYuan: 4 });
    expect(tight.canAfford(0.2)).toBe(false); // 5.8 + 0.2 + 4.2 > 10
    const local = makeBudget({ budgetYuan: 1, capYuan: 4 });
    local.note(0.9);
    expect(local.canAfford(0.2)).toBe(false);
  });
});

describe('免费来源检索', () => {
  const src = (name: NamedSource['name'], items: Candidate[] | Error): NamedSource => ({ name, search: async () => { if (items instanceof Error) throw items; return items; } });

  it('能否铺满：竖屏、4K 横屏可全屏；1080p 横屏只能分屏；720p 连分屏都不够', () => {
    const t = { width: 1080, height: 1920 };
    expect(fitOf({ width: 1080, height: 1920 }, t)).toBe('cover');
    expect(fitOf({ width: 3840, height: 2160 }, t)).toBe('cover');
    expect(fitOf({ width: 1920, height: 1080 }, t)).toBe('split');
    expect(fitOf({ width: 1280, height: 720 }, t)).toBe('none');
    // Openverse 图片长边多为 1024：横图最多铺上半屏，竖图连上半屏都不够，都进不了全屏插入
    expect(fitOf({ width: 1024, height: 768 }, t)).toBe('split');
    expect(fitOf({ width: 768, height: 1024 }, t)).toBe('none');
  });

  it('一个来源网络失败不影响其它来源；排除已用、重复、太长的视频与撑不起的小图；能铺满的、实拍视频排前面', async () => {
    const items = [
      cand('wikimedia:1', { width: 1920, height: 1080 }),
      cand('wikimedia:2'),
      cand('wikimedia:3', { kind: 'video', durationSec: 3600 }),
      cand('wikimedia:4', { width: 640, height: 480 }),
      cand('wikimedia:5', { kind: 'video', durationSec: 12 }),
      cand('wikimedia:used'),
    ];
    const g = await gatherCandidates(beat(), [src('pexels', new Error('Pexels 网络请求失败：ECONNRESET')), src('wikimedia', items)], ['wikimedia:used']);
    expect(g.errors.length).toBeGreaterThan(0);
    expect(g.errors.every((e) => e === 'pexels：Pexels 网络请求失败：ECONNRESET')).toBe(true);
    expect(g.counts.wikimedia).toBeGreaterThanOrEqual(6);
    expect(g.candidates.map((c) => c.id)).toEqual(['wikimedia:5', 'wikimedia:2', 'wikimedia:1']);
  });

  it('不够 12 个时换第二个搜索词，联系表最多 9 个', async () => {
    const seen: string[] = [];
    const many = (q: string): Candidate[] => Array.from({ length: 7 }, (_, i) => cand(`wikimedia:${q}-${i}`));
    const s: NamedSource = { name: 'wikimedia', search: async (q) => { seen.push(q.text); return many(q.text); } };
    const g = await gatherCandidates(beat({ queryEn: ['first query', 'second query', 'third query'] }), [s], []);
    expect(seen).toEqual(['first query', 'second query']);
    expect(g.candidates).toHaveLength(9);
  });

  it('rankForSheet 交错各来源，不让一个来源占满', () => {
    const list = [cand('wikimedia:a'), cand('wikimedia:b'), cand('pexels:a', { source: 'pexels' })];
    expect(rankForSheet(list, beat({ kind: 'photo' })).map((c) => c.id)).toEqual(['wikimedia:a', 'pexels:a', 'wikimedia:b']);
  });
});

describe('搜索词', () => {
  it('第一轮只用模型的英文词（不再截前两个词），去重；第二轮取末尾实词兜底', () => {
    expect(queriesOf(beat({ queryEn: ['tired video editor', 'man rubbing eyes computer', 'desk', 'desk'] }))).toEqual(['tired video editor', 'man rubbing eyes computer', 'desk']);
    expect(queriesOf(beat({ queryEn: ['tired video editor', 'man rubbing eyes computer', 'desk'] }), 2)).toEqual(['video editor', 'eyes computer']);
  });
});

describe('Wikimedia 遗留项', () => {
  it('Restrictions 非空一律排除（商标、人格权、货币、徽章等）', () => {
    expect(restricted('trademarked')).toBe(true);
    expect(restricted('personality|trademarked')).toBe(true);
    expect(restricted('currency')).toBe(true);
    expect(restricted('  ')).toBe(false);
    expect(restricted(undefined)).toBe(false);
    expect(restricted('')).toBe(false);
  });

  it('大图按宽度参数取缩略图（省下原图），只用 Wikimedia 认的标准宽度（2560px 等非标准宽度返回 400）；小图与非 Wikimedia 用原图', () => {
    const thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/640px-X.jpg';
    const big = cand('wikimedia:9', { width: 6000, height: 4000, thumb, url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg' });
    expect(sizedUrl(big)).toEqual({ url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/3840px-X.jpg', width: 3840, height: 2560 });
    expect(sizedUrl(cand('wikimedia:t', { width: 4000, height: 6000, thumb }))).toEqual({ url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/1920px-X.jpg', width: 1920, height: 2880 });
    expect(sizedUrl(cand('wikimedia:m', { width: 3000, height: 2155, thumb })).url).toBe('https://u/wikimedia:m.jpg'); // 标准宽度 3840 比原图还宽：用原图
    expect(sizedUrl(cand('wikimedia:s', { width: 2000, height: 1000 })).url).toBe('https://u/wikimedia:s.jpg');
    expect(sizedUrl(cand('pexels:1', { source: 'pexels', width: 6000, height: 4000 })).url).toBe('https://u/pexels:1.jpg');
  });
});

describe('截图网址核实', () => {
  it('urlHint 只有搜索结果里有完全相同的网址才用；只对上域名时用搜索结果里同域名的那条；否则用搜索给出的网址', async () => {
    const hinted = beat({ kind: 'screenshot', urlHint: 'https://www.palantir.com/careers/', queryZh: ['Palantir 招聘'] });
    expect(await verifiedUrls({ search: async () => ['https://x.org', 'https://www.palantir.com/careers'] }, hinted)).toEqual(['https://www.palantir.com/careers/', 'https://x.org']);
    expect(await verifiedUrls({ search: async () => ['https://x.org', 'https://palantir.com/careers/fde'] }, hinted)).toEqual(['https://palantir.com/careers/fde', 'https://x.org']);
    expect(await verifiedUrls({ search: async () => ['https://jobs.example.org/fde'] }, hinted)).toEqual(['https://jobs.example.org/fde']);
    const queries: string[] = [];
    await verifiedUrls({ search: async (q) => { queries.push(q); return []; } }, beat({ kind: 'screenshot', queryZh: ['敏之 AI 社区'] }));
    expect(queries).toEqual(['敏之 AI 社区']);
  });
});

describe('主体位置换算', () => {
  it('裁切后主体在输出画面里的位置', () => {
    // 1920×1080 裁成 9:8 上半屏：主体在右侧 0.8 处，裁框贴右边
    const f = mapFocal({ width: 1920, height: 1080 }, { x: 0.8, y: 0.5 }, { width: 1080, height: 960 });
    expect(f.y).toBeCloseTo(0.5);
    expect(f.x).toBeGreaterThan(0.5);
    expect(f.x).toBeLessThanOrEqual(1);
  });
});

describe('素材记录与 credits', () => {
  it('按分镜实际用到的文件汇总；usedOf 给出已用候选与哈希', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-credit-'));
    writeAssetMeta(dir, 'broll/a.jpg', meta({ candidateId: 'wikimedia:1', hash: '00ff00ff00ff00ff' }));
    writeAssetMeta(dir, 'broll/b.jpg', meta({ candidateId: 'generated:b', credit: { ...meta().credit, source: 'generated', aiGenerated: true } }));
    const sb: Storyboard = { shots: [
      { start: 0, end: 3, layout: 'broll', broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } },
      { start: 3, end: 6, layout: 'split', card: { template: 'photo', props: { image: 'broll/b.jpg' } } },
      { start: 6, end: 9, layout: 'split', card: { template: 'photo', props: { image: 'broll/old.jpg' } } },
    ] };
    expect(storyboardFiles(sb)).toEqual(['broll/a.jpg', 'broll/b.jpg', 'broll/old.jpg']);
    expect(creditsOf(sb, dir).map((e) => [e.file, e.source])).toEqual([['broll/a.jpg', 'wikimedia'], ['broll/b.jpg', 'generated']]);
    expect(usedOf(sb, dir)).toEqual({ ids: ['wikimedia:1', 'generated:b'], hashes: [0x00ff00ff00ff00ffn] });
  });
});

describe('真实画面缺口', () => {
  it('新补的真实画面挤掉重叠的图表 beat；与真实 beat 重叠的不要', () => {
    const chart = beat({ kind: 'chart', queryEn: [], queryZh: [], start: 60, end: 64, present: 'split' });
    const real = beat({ kind: 'photo', start: 70, end: 73 });
    const added = [beat({ kind: 'footage', start: 61, end: 63 }), beat({ kind: 'photo', start: 71, end: 72.5 })];
    expect(mergeGapBeats([chart, real], added).map((b) => [b.start, b.kind])).toEqual([[61, 'footage'], [70, 'photo']]);
  });
});

describe('normalize 对无卡片素材镜头的边角', () => {
  const b = { file: 'broll/a.jpg', kind: 'photo' as const, focal: { x: 0.5, y: 0.5 } };
  it('无卡片的素材镜头也限 8 秒；短镜头不并进素材镜头使它变长', () => {
    const sb = { shots: [{ start: 0, end: 12, layout: 'split', broll: b }, { start: 12, end: 20, layout: 'full' }] };
    const out = normalizeStoryboard(sb, 20, ['broll/a.jpg']).storyboard.shots;
    expect(out[0]).toMatchObject({ start: 0, end: 8, layout: 'split' });
    // 全屏插入 3.2 秒 + 0.5 秒碎片 = 3.7 秒，超过全屏插入的 3.5 秒上限：碎片并进后面的卡片镜头
    const short = { shots: [{ start: 0, end: 3.2, layout: 'broll', broll: b }, { start: 3.2, end: 3.7, layout: 'full' }, { start: 3.7, end: 10, layout: 'split', card: { template: 'title', props: { title: '标题' } } }] };
    const out2 = normalizeStoryboard(short, 10, ['broll/a.jpg']).storyboard.shots;
    expect(out2[0]).toMatchObject({ start: 0, end: 3.2, layout: 'broll' });
    expect(out2[1]).toMatchObject({ start: 3.2, layout: 'split' });
  });

  it('末尾 CTA 借时长时不把前面的素材镜头整个吞掉', () => {
    const sb = { shots: [{ start: 0, end: 7, layout: 'full' }, { start: 7, end: 9.2, layout: 'broll', broll: b }, { start: 9.2, end: 10, layout: 'full', card: { template: 'cta', props: { actions: ['关注'] } } }] };
    const out = normalizeStoryboard(sb, 10, ['broll/a.jpg']).storyboard.shots;
    expect(out.find((s) => s.layout === 'broll')).toBeDefined();
    expect(out.at(-1)?.card?.template).toBe('cta');
  });

  it('人物全屏镜头上残留的素材字段去掉', () => {
    const out = normalizeStoryboard({ shots: [{ start: 0, end: 5, layout: 'full', broll: b }] }, 5, ['broll/a.jpg']).storyboard.shots;
    expect(out[0]).toEqual({ start: 0, end: 5, layout: 'full' });
  });
});
