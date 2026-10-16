import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { placeAsset, type Placement } from '../broll/assign.js';
import { EST_YUAN } from '../broll/budget.js';
import { usedOf } from '../broll/credit-store.js';
import { fillRealGaps } from '../broll/gaps.js';
import { planBeats, type Beat } from '../broll/plan.js';
import type { RealizedAsset } from '../broll/realize.js';
import type { PickedState } from '../broll/select.js';
import type { Layout, Storyboard } from '../storyboard/schema.js';
import { collect, pick, type BeatsCtx, type Pool } from './broll-pick.js';
import { brollDetail } from './detail.js';

export type { BeatsCtx } from './broll-pick.js';

/** 需要检索素材的节拍种类（chart、ui 由卡片模板自绘） */
const SEARCH_KINDS: readonly Beat['kind'][] = ['footage', 'photo', 'screenshot', 'generated'];
/** 同时审片的节拍数 */
const CONCURRENCY = 3;
/** 兜底生图每 2 分钟最多发起几次 */
const GENERATED_PER_2MIN = 5;
/** 短片也至少允许 2 次（还受 B-roll 花费上限约束） */
const MIN_GENERATED = 2;

/**
 * 一个节拍的结果（含完整的节拍字段，存进版本状态，「换一张」时按原节拍重做）：
 * 放进了哪种版式、落点（placement）、用了哪个来源，或为什么跳过（镜头保持卡片或人像）
 */
export type BeatRecord = Beat & {
  candidates: number; counts?: Record<string, number>;
  status: 'placed' | 'skipped'; source?: string; file?: string; layout?: Layout; placement?: Placement; reason?: string;
  /** 这个节拍用过的全部候选 id（含「换一张」换掉的），重做时都排除，不会换回旧图 */
  history?: string[];
};

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
const NO_HOST = '这段时间没有可放素材的镜头（CTA 或自带画面的卡片占着）';

/** 并发上限为 limit 的 map（保持顺序）；某一项抛错后其余 worker 不再领新任务（余额不足时不多花钱） */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next;
      next += 1;
      try { out[i] = await fn(items[i], i); } catch (err) { failed = true; throw err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 截图只铺上半屏（只截了首屏标题区，铺不满竖屏）：全屏插入、画中画的截图节拍改成分屏 */
const fitScreenshot = (b: Beat): Beat => (b.kind === 'screenshot' && (b.present === 'broll-full' || b.present === 'pip') ? { ...b, present: 'split' } : b);

/** 规划节拍（并补真实画面缺口）；失败返回原因，余额不足、取消原样抛出 */
async function plan(ctx: BeatsCtx, storyboard: Storyboard): Promise<{ beats: Beat[]; note: string } | { error: string }> {
  const { env } = ctx;
  if (!env.budget.canAfford(EST_YUAN.plan)) return { error: 'B-roll 预算不足，跳过节拍规划' };
  try {
    const planned = await planBeats(env.llm, ctx.captions, storyboard, ctx.durationSec);
    const gaps = env.budget.canAfford(EST_YUAN.gaps) ? await fillRealGaps(env.llm, ctx.captions, planned.beats, planned.coverage, ctx.durationSec) : { beats: planned.beats, coverage: planned.coverage, added: 0 };
    const beats = gaps.beats.filter((b) => SEARCH_KINDS.includes(b.kind)).map(fitScreenshot);
    const note = `节拍 ${gaps.beats.length} 个（需检索 ${beats.length} 个）· 覆盖 ${Math.round(gaps.coverage.ratio * 100)}%${gaps.added > 0 ? ` · 补真实画面 ${gaps.added} 个` : ''}`;
    return { beats, note };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { error: `节拍规划失败：${reason(err)}` };
  }
}

/** 试放一个占位素材：这段时间里有没有能放素材的镜头（没有就不检索、不审片、不付费） */
export function hostable(storyboard: Storyboard, beat: Beat): boolean {
  const dummy = { file: 'broll/probe.jpg', meta: { credit: {} as RealizedAsset['meta']['credit'], candidateId: '', kind: 'photo' as const, focal: { x: 0.5, y: 0.5 } } };
  return placeAsset(storyboard.shots, beat, dummy).layout !== undefined;
}

const countText = (counts: Record<string, number>): string => Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('、');
const skip = (b: Beat, why: string, candidates = 0): BeatRecord => ({ ...b, candidates, status: 'skipped', reason: why });

/**
 * 节拍编排：规划 → 每个节拍并行检索与审片 → 逐个挑选、加工、放进镜头（全片不复用同一素材，id 与画面哈希都查）。
 * 没有镜头可放的节拍不检索；单个节拍失败只跳过该节拍（镜头保持卡片或人像）；规划失败整体跳过；余额不足与取消原样抛出
 */
export async function runBeats(ctx: BeatsCtx, storyboard: Storyboard): Promise<BeatsResult> {
  const { env } = ctx;
  const planned = await plan(ctx, storyboard);
  if ('error' in planned) {
    ctx.emit(`B-roll：${planned.error}`, brollDetail({ phase: 'plan', beats: 0, spentYuan: env.budget.spent(), error: planned.error }));
    return { storyboard, records: [], imageUrls: {}, note: planned.error };
  }
  const beats = planned.beats.filter((b) => hostable(storyboard, b));
  const skipped = planned.beats.filter((b) => !beats.includes(b)).map((b) => skip(b, `${NO_HOST}，未检索`));
  const used = usedOf(storyboard, env.workDir);
  ctx.emit(`B-roll 规划：${planned.note}${skipped.length > 0 ? ` · ${skipped.length} 个节拍没有可放的镜头，不检索` : ''}`,
    brollDetail({ phase: 'plan', beats: beats.length, spentYuan: env.budget.spent(), items: planned.beats }));
  const pools = await mapLimit(beats, CONCURRENCY, async (beat, i) => {
    throwIfCancelled(env.signal);
    const pool = await collect(ctx, beat, `beat-${i + 1}`, used.ids);
    ctx.emit(`节拍 ${i + 1}/${beats.length}（${label(beat)}）：候选 ${pool.reviewed.candidates.length} 个${countText(pool.counts) ? `（${countText(pool.counts)}）` : ''}`,
      brollDetail({ phase: 'beat', index: i, candidates: pool.reviewed.candidates.length, counts: pool.counts, spentYuan: env.budget.spent() }));
    return pool;
  });
  const placed = await placeAll(ctx, storyboard, beats, pools, { usedIds: used.ids, hashes: used.hashes });
  return { ...placed, records: [...placed.records, ...skipped].sort((a, b) => a.start - b.start), note: planned.note };
}

/** 一个节拍：先确认当前分镜里还放得下（前面的节拍可能占了宿主镜头）再挑选、付费，然后放进镜头 */
async function placeOne(ctx: BeatsCtx, shots: Storyboard['shots'], beat: Beat, pool: Pool, state: PickedState, mayGenerate: boolean): Promise<{ shots: Storyboard['shots']; record: BeatRecord; state: PickedState; url?: string; generated: boolean }> {
  const base = { candidates: pool.reviewed.candidates.length, counts: pool.counts };
  if (!hostable({ shots }, beat)) return { shots, record: { ...skip(beat, `${NO_HOST}（前面的节拍已占用）`), ...base }, state, generated: false };
  const got = await pick(ctx, beat, pool, state, mayGenerate);
  const r = got.asset ? placeAsset(shots, beat, got.asset) : undefined;
  if (!got.asset || !r?.layout) return { shots, record: { ...skip(beat, r?.reason ?? (got.errors.slice(-2).join('；') || '没有达标的候选')), ...base }, state, generated: got.generated };
  const record: BeatRecord = { ...beat, ...base, status: 'placed', source: got.asset.meta.credit.source, file: got.asset.file, layout: r.layout, ...(r.placement ? { placement: r.placement } : {}), history: [got.asset.meta.candidateId] };
  return { shots: r.shots, record, state: got.state, ...(got.url ? { url: got.url } : {}), generated: got.generated };
}

async function placeAll(ctx: BeatsCtx, storyboard: Storyboard, beats: Beat[], pools: Pool[], start: PickedState): Promise<Omit<BeatsResult, 'note'>> {
  const { env } = ctx;
  let state = start;
  let shots = storyboard.shots;
  let records: BeatRecord[] = [];
  let imageUrls: Record<string, string> = {};
  let generated = 0;
  const maxGenerated = Math.max(MIN_GENERATED, Math.round((GENERATED_PER_2MIN * ctx.durationSec) / 120));
  for (const [i, beat] of beats.entries()) {
    throwIfCancelled(env.signal);
    const one = await placeOne(ctx, shots, beat, pools[i], state, generated < maxGenerated);
    ({ shots, state } = one);
    generated += one.generated ? 1 : 0;
    if (one.url && one.record.file) imageUrls = { ...imageUrls, [one.record.file]: one.url };
    records = [...records, one.record];
    const r = one.record;
    ctx.emit(`节拍 ${i + 1}/${beats.length}（${label(beat)}）：${r.status === 'placed' ? `入选 ${r.source}（${r.layout}）` : `跳过（${r.reason}）`} · 已花 ${yuan(env.budget.spent())}`,
      brollDetail({ phase: 'beat', index: i, status: r.status, source: r.source, layout: r.layout, placement: r.placement, reason: r.reason, spentYuan: env.budget.spent() }));
  }
  return { storyboard: { ...storyboard, shots }, records, imageUrls };
}
