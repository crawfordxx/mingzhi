import type { TimedCaption } from '../captions/lines.js';
import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { placeAsset } from '../broll/assign.js';
import { EST_YUAN } from '../broll/budget.js';
import { usedOf } from '../broll/credit-store.js';
import { gatherCandidates, type NamedSource } from '../broll/gather.js';
import { fillRealGaps } from '../broll/gaps.js';
import { generatedCandidate, screenshotCandidates, type PaidDeps } from '../broll/paid.js';
import { planBeats, type Beat } from '../broll/plan.js';
import { realizeBest, realizeCandidate, type BeatEnv, type RealizedAsset } from '../broll/realize.js';
import { reviewCandidates, type Reviewed } from '../broll/review.js';
import type { PickedState } from '../broll/select.js';
import type { Layout, Storyboard } from '../storyboard/schema.js';
import { brollDetail, type ProgressDetail } from './detail.js';

/** 需要检索素材的节拍种类（chart、ui 由卡片模板自绘） */
const SEARCH_KINDS: readonly Beat['kind'][] = ['footage', 'photo', 'screenshot', 'generated'];
/** 同时审片的节拍数 */
const CONCURRENCY = 3;
/** 兜底生图每 2 分钟最多几张 */
const GENERATED_PER_2MIN = 5;

/** 一个节拍的结果：放进了哪种版式、用了哪个来源，或为什么跳过（降级为卡片或人像） */
export interface BeatRecord {
  start: number; end: number; present: Beat['present']; kind: Beat['kind']; subject: string; queryEn: string[]; queryZh: string[];
  candidates: number; counts?: Record<string, number>;
  status: 'placed' | 'skipped'; source?: string; file?: string; layout?: Layout; reason?: string;
}

export interface BeatsCtx {
  env: BeatEnv;
  captions: TimedCaption[];
  durationSec: number;
  sources: readonly NamedSource[];
  paid: PaidDeps;
  emit: (message: string, detail?: ProgressDetail) => void;
}

export interface BeatsResult {
  storyboard: Storyboard;
  records: BeatRecord[];
  /** 生图的公网地址（图生视频要用），按素材文件索引 */
  imageUrls: Record<string, string>;
  /** 规划失败等整体问题（不中断出片） */
  note?: string;
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const yuan = (v: number): string => `¥${v.toFixed(2)}`;
const label = (b: Beat): string => `${b.start.toFixed(1)}–${b.end.toFixed(1)} 秒`;
const recordOf = (b: Beat): Omit<BeatRecord, 'candidates' | 'status'> =>
  ({ start: b.start, end: b.end, present: b.present, kind: b.kind, subject: b.subject, queryEn: b.queryEn, queryZh: b.queryZh });

/** 并发上限为 limit 的 map（保持顺序） */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) { const i = next; next += 1; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 规划节拍（并补真实画面缺口）；失败返回 null 与原因，余额不足、取消原样抛出 */
async function plan(ctx: BeatsCtx, storyboard: Storyboard): Promise<{ beats: Beat[]; note: string } | { error: string }> {
  const { env } = ctx;
  if (!env.budget.canAfford(EST_YUAN.plan)) return { error: 'B-roll 预算不足，跳过节拍规划' };
  try {
    const planned = await planBeats(env.llm, ctx.captions, storyboard, ctx.durationSec);
    const gaps = env.budget.canAfford(EST_YUAN.gaps) ? await fillRealGaps(env.llm, ctx.captions, planned.beats, planned.coverage, ctx.durationSec) : { beats: planned.beats, coverage: planned.coverage, added: 0 };
    const beats = gaps.beats.filter((b) => SEARCH_KINDS.includes(b.kind));
    const note = `节拍 ${gaps.beats.length} 个（需检索 ${beats.length} 个）· 覆盖 ${Math.round(gaps.coverage.ratio * 100)}%${gaps.added > 0 ? ` · 补真实画面 ${gaps.added} 个` : ''}`;
    return { beats, note };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { error: `节拍规划失败：${reason(err)}` };
  }
}

interface Pool { reviewed: Reviewed; counts: Record<string, number>; errors: string[] }

/** 阶段一（并行）：截图类联网核实后截图，其余免费来源检索；有候选就拼联系表打分 */
async function collect(ctx: BeatsCtx, beat: Beat, i: number): Promise<Pool> {
  const errors: string[] = [];
  let counts: Record<string, number> = {};
  let candidates;
  if (beat.kind === 'screenshot') {
    candidates = await screenshotCandidates(ctx.env, ctx.paid, beat, errors);
    counts = { screenshot: candidates.length };
  } else {
    const g = await gatherCandidates(beat, ctx.sources, [], ctx.env.signal);
    candidates = g.candidates;
    counts = g.counts;
    errors.push(...g.errors);
  }
  try {
    return { reviewed: await reviewCandidates(ctx.env, beat, candidates, `beat-${i + 1}`), counts, errors };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { reviewed: { candidates: [], scores: [] }, counts, errors: [...errors, `审片失败：${reason(err)}`] };
  }
}

interface Pick { asset?: RealizedAsset; url?: string; state: PickedState; errors: string[] }

/** 阶段二（逐个）：挑没用过、不重复的最高分加工；都不达标且不是截图类时兜底生图（受张数与预算约束） */
async function pick(ctx: BeatsCtx, beat: Beat, pool: Pool, state: PickedState, mayGenerate: boolean): Promise<Pick> {
  const best = await realizeBest(ctx.env, beat, pool.reviewed.candidates, pool.reviewed.scores, state);
  const errors = [...pool.errors, ...best.failures];
  if (best.asset || beat.kind === 'screenshot' || !mayGenerate) return { ...best, errors: best.asset ? errors : [...errors, '没有达标的候选'] };
  const gen = await generatedCandidate(ctx.env, ctx.paid, beat, errors);
  if (!gen) return { state, errors };
  try {
    const asset = await realizeCandidate(ctx.env, beat, gen.candidate, null);
    return { asset, ...(gen.url ? { url: gen.url } : {}), state: { ...state, usedIds: [...state.usedIds, gen.candidate.id] }, errors };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { state, errors: [...errors, `生图加工失败：${reason(err).slice(0, 120)}`] };
  }
}

/** 试放一个占位素材：这段时间里有没有能放素材的镜头（没有就不必检索、审片，省钱） */
function hostable(storyboard: Storyboard, beat: Beat): boolean {
  const dummy = { file: 'broll/probe.jpg', meta: { credit: {} as RealizedAsset['meta']['credit'], candidateId: '', kind: 'photo' as const, focal: { x: 0.5, y: 0.5 } } };
  return placeAsset(storyboard.shots, beat, dummy).layout !== undefined;
}

const countText = (counts: Record<string, number>): string => Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('、');

/**
 * 节拍编排：规划 → 每个节拍并行检索与审片 → 逐个挑选、加工、放进镜头（全片不复用同一素材）。
 * 单个节拍失败只跳过该节拍（镜头保持卡片或人像）；规划失败整体跳过；余额不足与取消原样抛出
 */
export async function runBeats(ctx: BeatsCtx, storyboard: Storyboard): Promise<BeatsResult> {
  const { env } = ctx;
  const planned = await plan(ctx, storyboard);
  if ('error' in planned) {
    ctx.emit(`B-roll：${planned.error}`, brollDetail({ phase: 'plan', beats: 0, spentYuan: env.budget.spent(), error: planned.error }));
    return { storyboard, records: [], imageUrls: {}, note: planned.error };
  }
  const beats = planned.beats.filter((b) => hostable(storyboard, b));
  const unhosted = planned.beats.length - beats.length;
  const skipped: BeatRecord[] = planned.beats.filter((b) => !beats.includes(b))
    .map((b) => ({ ...recordOf(b), candidates: 0, status: 'skipped', reason: '这段时间没有可放素材的镜头（钩子、CTA、自带画面或信息密的卡片占着），未检索' }));
  ctx.emit(`B-roll 规划：${planned.note}${unhosted > 0 ? ` · ${unhosted} 个节拍落在钩子、CTA 或已有画面的卡片上，不检索` : ''}`, brollDetail({ phase: 'plan', beats: beats.length, spentYuan: env.budget.spent(), items: beats.map(recordOf) }));
  const pools = await mapLimit(beats, CONCURRENCY, async (beat, i) => {
    throwIfCancelled(env.signal);
    const pool = await collect(ctx, beat, i);
    ctx.emit(`节拍 ${i + 1}/${beats.length}（${label(beat)}）：候选 ${pool.reviewed.candidates.length} 个${countText(pool.counts) ? `（${countText(pool.counts)}）` : ''}`,
      brollDetail({ phase: 'beat', index: i, candidates: pool.reviewed.candidates.length, counts: pool.counts, spentYuan: env.budget.spent() }));
    return pool;
  });
  const placed = await placeAll(ctx, storyboard, beats, pools, planned.note);
  return { ...placed, records: [...placed.records, ...skipped].sort((a, b) => a.start - b.start) };
}

async function placeAll(ctx: BeatsCtx, storyboard: Storyboard, beats: Beat[], pools: Pool[], note: string): Promise<BeatsResult> {
  const { env } = ctx;
  const used = usedOf(storyboard, env.workDir);
  let state: PickedState = { usedIds: used.ids, hashes: used.hashes };
  let shots = storyboard.shots;
  let records: BeatRecord[] = [];
  let imageUrls: Record<string, string> = {};
  const maxGenerated = Math.max(1, Math.round((GENERATED_PER_2MIN * ctx.durationSec) / 120));
  for (const [i, beat] of beats.entries()) {
    throwIfCancelled(env.signal);
    const generated = records.filter((r) => r.source === 'generated').length;
    const got = await pick(ctx, beat, pools[i], state, generated < maxGenerated);
    state = got.state;
    const base = { ...recordOf(beat), candidates: pools[i].reviewed.candidates.length, counts: pools[i].counts };
    const placed = got.asset ? placeAsset(shots, beat, got.asset) : undefined;
    const record: BeatRecord = placed?.layout && got.asset
      ? { ...base, status: 'placed', source: got.asset.meta.credit.source, file: got.asset.file, layout: placed.layout }
      : { ...base, status: 'skipped', reason: placed?.reason ?? (got.errors.slice(-2).join('；') || '没有达标的候选') };
    if (placed?.layout) shots = placed.shots;
    if (got.url && got.asset) imageUrls = { ...imageUrls, [got.asset.file]: got.url };
    records = [...records, record];
    ctx.emit(`节拍 ${i + 1}/${beats.length}（${label(beat)}）：${record.status === 'placed' ? `入选 ${record.source}（${record.layout}）` : `跳过（${record.reason}）`} · 已花 ${yuan(env.budget.spent())}`,
      brollDetail({ phase: 'beat', index: i, status: record.status, source: record.source, layout: record.layout, reason: record.reason, spentYuan: env.budget.spent() }));
  }
  return { storyboard: { ...storyboard, shots }, records, imageUrls, note };
}
