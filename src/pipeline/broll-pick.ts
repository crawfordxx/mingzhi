import type { TimedCaption } from '../captions/lines.js';
import { rethrowIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { gatherCandidates, queriesOf, type NamedSource } from '../broll/gather.js';
import { generatedCandidate, screenshotCandidates, variantFor, type PaidDeps } from '../broll/paid.js';
import type { Beat } from '../broll/plan.js';
import { realizeBest, realizeCandidate, type BeatEnv, type RealizedAsset } from '../broll/realize.js';
import { reviewCandidates, type Reviewed } from '../broll/review.js';
import { rankPassing, type PickedState } from '../broll/select.js';
import type { ProgressDetail } from './detail.js';

/** 节拍编排与「换一张」共用的环境 */
export interface BeatsCtx {
  env: BeatEnv;
  captions: TimedCaption[];
  durationSec: number;
  sources: readonly NamedSource[];
  paid: PaidDeps;
  emit: (message: string, detail?: ProgressDetail) => void;
}

/** 一个节拍的候选池：审片结果（两轮合并）、各来源返回数、失败原因、每轮实际发出的检索词 */
export interface Pool { reviewed: Reviewed; counts: Record<string, number>; errors: string[]; queries: string[][] }
/** 挑选结果：加工好的素材（或没有）、生图的公网地址、新的全片已选状态、是否发起过生图 */
export interface Pick { asset?: RealizedAsset; url?: string; state: PickedState; errors: string[]; generated: boolean }

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const EMPTY: Reviewed = { candidates: [], scores: [] };
const addCounts = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
  Object.entries(b).reduce((acc, [k, v]) => ({ ...acc, [k]: (acc[k] ?? 0) + v }), a);

/** 一轮：截图类联网核实后截图，其余免费来源检索（排除 usedIds）；有候选就拼联系表打分，审片失败只记原因 */
async function oneRound(ctx: BeatsCtx, beat: Beat, sheetName: string, usedIds: readonly string[], round: 1 | 2): Promise<Pool> {
  const found = beat.kind === 'screenshot'
    ? await screenshotCandidates(ctx.env, ctx.paid, beat).then((r) => ({ candidates: r.value, queries: [] as string[], counts: { screenshot: r.value.length }, errors: r.errors }))
    : await gatherCandidates(beat, ctx.sources, usedIds, ctx.env.signal, round);
  const candidates = found.candidates.filter((c) => !usedIds.includes(c.id));
  const base = { counts: found.counts, queries: [found.queries] };
  try {
    return { ...base, reviewed: await reviewCandidates(ctx.env, beat, candidates, sheetName), errors: found.errors };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { ...base, reviewed: EMPTY, errors: [...found.errors, `审片失败：${reason(err)}`] };
  }
}

/** 两轮合并：第二轮的序号接在第一轮的候选后面（candidates[index - 1] 仍对得上） */
function merge(a: Pool, b: Pool): Pool {
  const offset = a.reviewed.candidates.length;
  const scores = [...a.reviewed.scores, ...b.reviewed.scores.map((s) => ({ ...s, index: s.index + offset }))];
  return { reviewed: { candidates: [...a.reviewed.candidates, ...b.reviewed.candidates], scores }, counts: addCounts(a.counts, b.counts), errors: [...a.errors, ...b.errors], queries: [...a.queries, ...b.queries] };
}

/**
 * 检索并审片。第一轮没有能赢过兜底生图的候选（见 realWins）时，换同义/上位词再搜、再审一次（排除第一轮已看过的），两轮合并；
 * 截图类只有一轮
 */
export async function collect(ctx: BeatsCtx, beat: Beat, sheetName: string, usedIds: readonly string[]): Promise<Pool> {
  const first = await oneRound(ctx, beat, sheetName, usedIds, 1);
  if (beat.kind === 'screenshot' || rankPassing(first.reviewed.scores).length > 0 || queriesOf(beat, 2).length === 0) return first;
  const seen = [...usedIds, ...first.reviewed.candidates.map((c) => c.id)];
  return merge(first, await oneRound(ctx, beat, `${sheetName}-r2`, seen, 2));
}

/** 兜底生图：取第一个没用过的变体（同一 beat 第 n 次生成换角度、换缓存键），加工失败只记原因 */
async function generate(ctx: BeatsCtx, beat: Beat, state: PickedState, errors: string[]): Promise<Pick> {
  const gen = await generatedCandidate(ctx.env, ctx.paid, beat, variantFor(ctx.env, beat, state.usedIds));
  const all = [...errors, ...gen.errors];
  if (!gen.value) return { state, errors: all, generated: true };
  try {
    const asset = await realizeCandidate(ctx.env, beat, gen.value.candidate, null);
    return { asset, ...(gen.value.url ? { url: gen.value.url } : {}), state: { ...state, usedIds: [...state.usedIds, gen.value.candidate.id] }, errors: all, generated: true };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { state, errors: [...all, `生图加工失败：${reason(err).slice(0, 120)}`], generated: true };
  }
}

/** 挑没用过、不重复的最高分加工；都不达标且不是截图类时兜底生图（mayGenerate 为假时不生） */
export async function pick(ctx: BeatsCtx, beat: Beat, pool: Pool, state: PickedState, mayGenerate: boolean): Promise<Pick> {
  const best = await realizeBest(ctx.env, beat, pool.reviewed.candidates, pool.reviewed.scores, state);
  const errors = [...pool.errors, ...best.failures];
  if (best.asset) return { asset: best.asset, state: best.state, errors, generated: false };
  if (beat.kind === 'screenshot' || !mayGenerate) return { state, errors: [...errors, '没有达标的候选'], generated: false };
  return generate(ctx, beat, state, [...errors, '没有达标的候选，兜底生图']);
}
