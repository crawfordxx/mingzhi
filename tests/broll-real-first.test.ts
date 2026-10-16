// Task 13：真实素材优先（公平竞争、同分优先真实、生成兜底条件）、短片预算下限、节拍落位改 pip/全屏插入、检索词两轮
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPendingPhoto, placeAsset, presentFor, type PlaceAsset } from '../src/broll/assign.js';
import { brollCapYuan, EST_YUAN, makeBudget, MIN_CAP_YUAN, MIN_IMAGES } from '../src/broll/budget.js';
import type { AssetMeta } from '../src/broll/credit-store.js';
import { coverFor, fitOf, gatherCandidates, queriesOf, TARGETS, type NamedSource } from '../src/broll/gather.js';
import { BeatSchema, type Beat } from '../src/broll/plan.js';
import { GENERATED_RELEVANCE, MIN_RELEVANCE, pickBest, rankPassing, realWins, REAL_MARGIN, type CandidateScore } from '../src/broll/select.js';
import type { Candidate } from '../src/broll/sources/types.js';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import type { ChatOptions } from '../src/llm/kexiang.js';
import { collect, type BeatsCtx } from '../src/pipeline/broll-pick.js';
import type { Shot } from '../src/storyboard/schema.js';
import { brollAnswers, cand, fakeBrollDeps, makeBrollFixtures } from './helpers/broll-fakes.js';

const beat = (over: Partial<Beat> = {}): Beat => BeatSchema.parse({
  start: 6.5, end: 8.5, role: 'illustrate', kind: 'photo', subject: '手机放在客厅茶几上', mustShow: ['手机', '茶几'], avoid: [],
  queryEn: ['smartphone on wooden table empty room'], queryZh: ['手机 茶几'], present: 'split', shotSize: 'MS', motion: 'static', ...over,
});
const sc = (index: number, over: Partial<CandidateScore> = {}): CandidateScore => ({
  index, relevance: 8, aesthetic: 7, brand: 6, clean: 8, tech: 7, focal: { x: 0.5, y: 0.5 }, note: '', ...over,
});
const meta = (over: Partial<AssetMeta> = {}): AssetMeta => ({
  credit: { file: 'broll/x.jpg', source: 'openverse', page: 'https://flickr.com/p/1', author: 'Eve', license: 'CC BY 2.0', attributionRequired: true, aiGenerated: false, modified: ['crop', 'lut'], query: 'q', fetchedAt: '2026-10-16T00:00:00Z' },
  candidateId: 'openverse:1', kind: 'photo', focal: { x: 0.5, y: 0.5 }, ...over,
});
const asset = (over: Partial<AssetMeta> = {}): PlaceAsset => ({ file: 'broll/a.jpg', meta: meta(over) });
const full = (start: number, end: number): Shot => ({ start, end, layout: 'full' });
const title = (start: number, end: number): Shot => ({ start, end, layout: 'split', card: { template: 'title', props: { title: '习惯一' } } });
const photo = (start: number, end: number, image?: string): Shot => ({
  start, end, layout: 'split', card: { template: 'photo', props: { label: '习惯二', ...(image ? { image } : { visual: { source: 'generate', prompt: 'a phone lying on a coffee table' } }) } },
});

describe('真实素材与生成图公平竞争', () => {
  it('生成图相关度视为 9：真实候选同分或只低 ≤ 2 分（≥ 7）就用真实，低 2 分以上才生成', () => {
    expect(GENERATED_RELEVANCE).toBe(9);
    expect(REAL_MARGIN).toBe(2);
    expect(MIN_RELEVANCE).toBe(7);
    expect(realWins(sc(1, { relevance: 9 }))).toBe(true); // 同分优先真实
    expect(realWins(sc(1, { relevance: 7 }))).toBe(true); // 接近（差 2 分）仍优先真实
    expect(realWins(sc(1, { relevance: 6.9 }))).toBe(false); // < 7 才用生成
    expect(realWins(null)).toBe(false);
    // 生成图相关度给得低时，真实候选只要不低于它 2 分以上就赢
    expect(realWins(sc(1, { relevance: 6 }), 8)).toBe(true);
  });

  it('不再按总分一刀切：相关度够、没有硬伤（美感、干净、技术 ≥ 5）就过线；水印、模糊、难看的不过线', () => {
    const modest = sc(1, { relevance: 7, aesthetic: 6, brand: 4, clean: 7, tech: 6 }); // 总分 30，旧规则（≥ 40）会落选
    expect(pickBest([modest])).toBe(1);
    expect(pickBest([sc(1, { clean: 3 })])).toBeNull(); // 水印、叠字
    expect(pickBest([sc(1, { tech: 4 })])).toBeNull(); // 模糊、噪点
    expect(pickBest([sc(1, { aesthetic: 4 })])).toBeNull();
    expect(realWins(sc(1, { relevance: 9, clean: 3 }))).toBe(false);
  });

  it('过线的按总分排、同分看相关度', () => {
    expect(rankPassing([sc(1), sc(2, { aesthetic: 9 }), sc(3, { relevance: 6 }), sc(4, { relevance: 9, aesthetic: 6 })])).toEqual([2, 4, 1]);
  });
});

describe('分辨率：分屏、画中画、浮层只要求长边 ≥ 1024；全屏插入仍要竖屏或 4K', () => {
  it('Openverse/Flickr 的 1024 长边图能进分屏与浮层，全屏插入仍只收能铺满的', () => {
    const split = (w: number, h: number) => fitOf({ width: w, height: h }, TARGETS.split, coverFor('split', { width: w, height: h }));
    expect(split(1024, 683)).toBe('cover');
    expect(split(683, 1024)).toBe('cover'); // 竖图裁成上半屏（放大约 1.58×）
    expect(split(640, 960)).toBe('none'); // 长边不到 1024：按原规则
    const overlay = { width: 1024, height: 576 };
    expect(fitOf(overlay, TARGETS.overlay, coverFor('overlay', overlay))).toBe('cover');
    const full = (w: number, h: number) => fitOf({ width: w, height: h }, TARGETS['broll-full'], coverFor('broll-full', { width: w, height: h }));
    // 全屏节拍遇到 1024 长边的图：铺不满竖屏，退到上半屏（分屏只要求长边 ≥ 1024），不丢
    expect(full(683, 1024)).toBe('split');
    expect(full(1024, 683)).toBe('split');
    expect(full(640, 960)).toBe('none');
    expect(full(1080, 1920)).toBe('cover');
    expect(full(3840, 2160)).toBe('cover');
    // 画中画素材铺满全屏：1024 长边的图铺不满，退到分屏，但不会被丢掉
    const pip = { width: 1024, height: 683 };
    expect(fitOf(pip, TARGETS.pip, coverFor('pip', pip))).toBe('split');
  });

  it('检索阶段按放宽后的规则过滤：分屏节拍收下 1024 长边的竖图', async () => {
    const items = [cand('v', { source: 'openverse', id: 'openverse:v', width: 683, height: 1024 }), cand('s', { source: 'openverse', id: 'openverse:s', width: 600, height: 400 })];
    const src: NamedSource = { name: 'openverse', search: async () => items };
    const g = await gatherCandidates(beat({ present: 'split' }), [src], []);
    expect(g.candidates.map((c) => c.id)).toEqual(['openverse:v']);
  });
});

describe('短片 B-roll 预算下限按张数', () => {
  it('30 秒以内至少付得起 3 张图（每张含两轮审片、主体定位、兜底生图），外加一次规划与补缺口', () => {
    const perImage = EST_YUAN.score * 2 + EST_YUAN.focal + EST_YUAN.imageWide;
    expect(MIN_IMAGES).toBe(3);
    expect(MIN_CAP_YUAN).toBeCloseTo(EST_YUAN.plan + EST_YUAN.gaps + MIN_IMAGES * perImage, 2);
    for (const sec of [8, 12, 20, 30]) expect(brollCapYuan(sec)).toBeGreaterThanOrEqual(EST_YUAN.plan + EST_YUAN.gaps + 3 * perImage - 1e-9);
    expect(brollCapYuan(120)).toBe(4); // 长片不变
  });

  it('仍受项目总上限约束', () => {
    const meter = new CostMeter({}, 1);
    meter.addTask('x', 0.6, '前序');
    const b = makeBudget({ meter, budgetYuan: 1, reserveYuan: 0, capYuan: brollCapYuan(12) });
    expect(b.canAfford(0.3)).toBe(true);
    expect(b.canAfford(0.5)).toBe(false); // 0.6 + 0.5 > 项目上限 ¥1
  });
});

describe('落在人物全屏镜头上的节拍：改为全屏插入或画中画，不丢弃', () => {
  const shots: Shot[] = [title(0, 4), full(4, 6.2), full(6.2, 9), title(9, 10)];

  it('分屏节拍只落在人物全屏镜头上：≤ 3.5 秒改全屏插入，更长改画中画；落在可铺底的卡片上保持分屏', () => {
    expect(presentFor(shots, beat({ start: 6.5, end: 8.5 }))).toBe('broll-full');
    expect(presentFor([full(0, 12)], beat({ start: 1, end: 6 }))).toBe('pip');
    expect(presentFor(shots, beat({ start: 0.5, end: 3.5 }))).toBe('split');
    expect(presentFor(shots, beat({ start: 6.5, end: 8.5, present: 'overlay' }))).toBe('overlay'); // 浮层本来就放在人物上
    expect(presentFor(shots, beat({ start: 6.5, end: 8.5, present: 'broll-full' }))).toBe('broll-full');
  });

  it('按素材方向放：竖图全屏插入；只够铺上半屏的横图在人物镜头里上半屏铺素材', () => {
    const b = { ...beat(), present: presentFor(shots, beat()) };
    expect(placeAsset(shots, b, asset())).toMatchObject({ layout: 'broll', placement: 'free' });
    expect(placeAsset(shots, b, asset({ downgrade: 'split' }))).toMatchObject({ layout: 'split', placement: 'half' });
    const long = { ...beat({ start: 1, end: 6 }), present: presentFor([full(0, 12)], beat({ start: 1, end: 6 })) };
    expect(placeAsset([full(0, 12)], long, asset())).toMatchObject({ layout: 'pip', placement: 'free' });
  });

  it('还没取到图的图片卡（取不到就会退成人物全屏）：节拍素材替换它，不再为它单独生图', () => {
    const withPhoto: Shot[] = [title(0, 4), full(4, 6.2), photo(6.2, 9), title(9, 10)];
    expect(isPendingPhoto(withPhoto[2])).toBe(true);
    expect(isPendingPhoto(photo(6.2, 9, 'broll/p.jpg'))).toBe(false);
    const b = { ...beat(), present: presentFor(withPhoto, beat()) };
    expect(b.present).toBe('broll-full');
    const r = placeAsset(withPhoto, b, asset());
    expect(r).toMatchObject({ layout: 'broll', placement: 'free' });
    expect(r.shots.some((s) => s.card?.template === 'photo')).toBe(false);
    expect(r.shots.find((s) => s.broll)).toMatchObject({ start: 6.2, end: 9, layout: 'broll' });
    // 已有图的图片卡仍不让占
    const owned: Shot[] = [title(0, 4), full(4, 6.2), photo(6.2, 9, 'broll/p.jpg'), title(9, 10)];
    expect(placeAsset(owned, { ...beat(), present: 'broll-full' }, asset()).layout).toBeUndefined();
  });
});

describe('检索词：从 mustShow 生成更具体的英文词；第一轮没有合格候选时换同义/上位词再搜一次', () => {
  it('第一轮：模型的英文词 + mustShow 英文名词组合；不再截前两个词（「person opening」会搜出国际象棋开局）', () => {
    const b = beat({ queryEn: ['person opening window morning'], mustShowEn: ['curtains', 'sunlight', 'morning'] });
    expect(queriesOf(b)).toEqual(['person opening window morning', 'curtains sunlight']);
    expect(queriesOf(b)).not.toContain('person opening');
  });

  it('第二轮：同义/上位词 + 单个 mustShow 名词；没给同义词时取每个搜索词末尾的名词；不重复第一轮', () => {
    const b = beat({ queryEn: ['crossing out task notebook'], mustShowEn: ['notebook', 'pen'], queryAlt: ['to-do list', 'checklist'] });
    expect(queriesOf(b, 2)).toEqual(['to-do list', 'checklist', 'notebook', 'pen']);
    const old = beat({ queryEn: ['crossing out task notebook', 'writing on paper close up'] });
    expect(queriesOf(old, 2)).toEqual(['task notebook', 'writing paper']);
  });

  describe('collect 两轮检索（真实 ffmpeg 拼联系表，不联网）', () => {
    const cfg = loadConfig({});
    beforeAll(async () => { await makeBrollFixtures(); });

    const ctxWith = (score: (o: ChatOptions) => unknown, sources: NamedSource[]): { ctx: BeatsCtx; labels: string[] } => {
      const llm = brollAnswers({ beats: [] }, { score });
      const { deps } = fakeBrollDeps(sources);
      const env = { workDir: mkdtempSync(join(tmpdir(), 'mz-t13-')), ffmpeg: cfg.ffmpeg, lut: '', llm, budget: makeBudget({ budgetYuan: 10, capYuan: 2 }), fetchImpl: deps.fetchImpl ?? fetch };
      return { ctx: { env, captions: [], durationSec: 12, sources, paid: deps, emit: () => undefined }, labels: llm.labels };
    };
    const rows = (o: ChatOptions, relevance: number) => ({ scores: Array.from({ length: Number(/共 (\d+) 格/.exec(o.user)?.[1]) }, (_, i) => ({ index: i + 1, relevance, aesthetic: 7, brand: 6, clean: 8, tech: 7 })) });

    it('第一轮全部相关度不够：用第二轮检索词再搜、再审一次，两轮候选合在一起挑；检索词按轮记录', async () => {
      const seen: string[] = [];
      const src: NamedSource = { name: 'wikimedia', search: async (q) => { seen.push(q.text); return seen.length === 1 ? [cand('p0'), cand('p1')] : [cand('p2'), cand('p3')]; } };
      let call = 0;
      const { ctx, labels } = ctxWith((o) => rows(o, (call += 1) === 1 ? 5 : 8), [src]);
      const pool = await collect(ctx, beat({ queryEn: ['crossing out task notebook'], mustShowEn: [], queryAlt: ['checklist'] }), 'beat-1', []);
      expect(pool.queries).toEqual([['crossing out task notebook'], ['checklist']]);
      expect(labels.filter((l) => l === 'B-roll 审片打分')).toHaveLength(2);
      expect(pool.reviewed.candidates.map((c) => c.id)).toEqual(['wikimedia:p0', 'wikimedia:p1', 'wikimedia:p2', 'wikimedia:p3']);
      expect(rankPassing(pool.reviewed.scores)).toEqual([3, 4]); // 第二轮的候选按合并后的序号
    });

    it('第一轮已有合格候选：不搜第二轮', async () => {
      const seen: string[] = [];
      const src: NamedSource = { name: 'wikimedia', search: async (q) => { seen.push(q.text); return [cand('p0'), cand('p1')]; } };
      const { ctx, labels } = ctxWith((o) => rows(o, 8), [src]);
      const pool = await collect(ctx, beat({ queryEn: ['phone on table'], queryAlt: ['smartphone'] }), 'beat-1', []);
      expect(pool.queries).toEqual([['phone on table']]);
      expect(labels.filter((l) => l === 'B-roll 审片打分')).toHaveLength(1);
      expect(seen).toEqual(['phone on table']);
    });
  });
});
