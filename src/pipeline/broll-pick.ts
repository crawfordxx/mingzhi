import type { TimedCaption } from '../captions/lines.js';
import { rethrowIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { gatherCandidates, type NamedSource } from '../broll/gather.js';
import { generatedCandidate, screenshotCandidates, variantFor, type PaidDeps } from '../broll/paid.js';
import type { Beat } from '../broll/plan.js';
import { realizeBest, realizeCandidate, type BeatEnv, type RealizedAsset } from '../broll/realize.js';
import { reviewCandidates, type Reviewed } from '../broll/review.js';
import type { PickedState } from '../broll/select.js';
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

/** 一个节拍的候选池：审片结果、各来源返回数、失败原因 */
export interface Pool { reviewed: Reviewed; counts: Record<string, number>; errors: string[] }
/** 挑选结果：加工好的素材（或没有）、生图的公网地址、新的全片已选状态、是否发起过生图 */
export interface Pick { asset?: RealizedAsset; url?: string; state: PickedState; errors: string[]; generated: boolean }

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 截图类联网核实后截图，其余免费来源检索（排除全片已用的候选）；有候选就拼联系表打分 */
export async function collect(ctx: BeatsCtx, beat: Beat, sheetName: string, usedIds: readonly string[]): Promise<Pool> {
  const found = beat.kind === 'screenshot'
    ? await screenshotCandidates(ctx.env, ctx.paid, beat).then((r) => ({ candidates: r.value, counts: { screenshot: r.value.length }, errors: r.errors }))
    : await gatherCandidates(beat, ctx.sources, usedIds, ctx.env.signal);
  const candidates = found.candidates.filter((c) => !usedIds.includes(c.id));
  try {
    return { reviewed: await reviewCandidates(ctx.env, beat, candidates, sheetName), counts: found.counts, errors: found.errors };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { reviewed: { candidates: [], scores: [] }, counts: found.counts, errors: [...found.errors, `审片失败：${reason(err)}`] };
  }
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
