import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { dropBroll, swapBroll } from '../broll/assign.js';
import { readAssetMeta, usedOf } from '../broll/credit-store.js';
import { gatherCandidates } from '../broll/gather.js';
import { generatedCandidate, screenshotCandidates } from '../broll/paid.js';
import { DEFAULT_AVOID } from '../broll/plan-check.js';
import type { Beat } from '../broll/plan.js';
import { realizeBest, realizeCandidate, type RealizedAsset } from '../broll/realize.js';
import { reviewCandidates } from '../broll/review.js';
import type { Shot, Storyboard } from '../storyboard/schema.js';
import type { BeatRecord, BeatsCtx } from './broll-beats.js';
import { brollDetail } from './detail.js';

/** 素材面板的标记：replace 换一张，remove 去掉（键是 credits.json 里的相对路径） */
export type BrollMark = 'replace' | 'remove';

const PRESENT: Record<Shot['layout'], Beat['present']> = { broll: 'broll-full', pip: 'pip', overlay: 'overlay', split: 'split', full: 'split' };
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 这个镜头原来的节拍：上一版记录里与它时间重叠最多的那个；没有记录（旧项目）时按素材记录的搜索词重建 */
export function beatForShot(shot: Shot, records: readonly BeatRecord[], workDir: string): Beat {
  const overlap = (r: BeatRecord): number => Math.min(r.end, shot.end) - Math.max(r.start, shot.start);
  const rec = records.filter((r) => (shot.broll && r.file === shot.broll.file) || overlap(r) > 0).sort((a, b) => overlap(b) - overlap(a))[0];
  const meta = shot.broll ? readAssetMeta(workDir, shot.broll.file) : undefined;
  const query = rec?.queryEn[0] ?? meta?.credit.query ?? 'documentary b-roll';
  return {
    start: shot.start, end: shot.end, present: PRESENT[shot.layout], role: 'illustrate',
    kind: rec?.kind ?? (meta?.credit.source === 'screenshot' ? 'screenshot' : meta?.kind === 'video' ? 'footage' : 'photo'),
    subject: rec?.subject ?? query, mustShow: [], avoid: [...DEFAULT_AVOID], queryEn: rec?.queryEn ?? [query], queryZh: rec?.queryZh ?? [],
    shotSize: 'MS', motion: 'static',
  };
}

/** 给一个节拍重新找一张（排除全片已用的素材，包括这个镜头现在这张） */
async function findAnother(ctx: BeatsCtx, beat: Beat, storyboard: Storyboard): Promise<{ asset?: RealizedAsset; errors: string[] }> {
  const used = usedOf(storyboard, ctx.env.workDir);
  const errors: string[] = [];
  const candidates = beat.kind === 'screenshot'
    ? await screenshotCandidates(ctx.env, ctx.paid, beat, errors)
    : (await gatherCandidates(beat, ctx.sources, used.ids, ctx.env.signal)).candidates.filter((c) => !used.ids.includes(c.id));
  try {
    const reviewed = await reviewCandidates(ctx.env, beat, candidates, `redo-${Math.round(beat.start * 1000)}`);
    const best = await realizeBest(ctx.env, beat, reviewed.candidates, reviewed.scores, { usedIds: used.ids, hashes: used.hashes });
    if (best.asset) return { asset: best.asset, errors };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    errors.push(reason(err));
  }
  if (beat.kind === 'screenshot') return { errors };
  const gen = await generatedCandidate(ctx.env, ctx.paid, beat, errors);
  if (!gen) return { errors };
  try {
    return { asset: await realizeCandidate(ctx.env, beat, gen.candidate, null), errors };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { errors: [...errors, `生图加工失败：${reason(err)}`] };
  }
}

/** 秒数 sec 落在哪个镜头里 */
const shotAt = (shots: readonly Shot[], sec: number): number => shots.findIndex((s) => sec >= s.start && sec < s.end);

/**
 * 修改版本「换一张 B-roll」：只重做 at（成片秒数，每个对应一个镜头）指向的带素材镜头，其余镜头原样不动。
 * 素材面板标了 remove 的去掉素材；其余（含标了 replace）重新检索、审片、挑一张没用过的换上，找不到就保留原素材并说明
 */
export async function redoShots(ctx: BeatsCtx, storyboard: Storyboard, at: readonly number[], marks: Readonly<Record<string, BrollMark>>, records: readonly BeatRecord[]): Promise<{ storyboard: Storyboard; notes: string[] }> {
  let current = storyboard;
  let notes: string[] = [];
  for (const sec of at) {
    throwIfCancelled(ctx.env.signal);
    const i = shotAt(current.shots, sec);
    const shot = current.shots[i];
    if (!shot?.broll) continue;
    if (marks[shot.broll.file] === 'remove') {
      current = { ...current, shots: current.shots.map((s, k) => (k === i ? dropBroll(s) : s)) };
      notes = [...notes, `镜头 ${i}：已去掉素材`];
      continue;
    }
    const got = await findAnother(ctx, beatForShot(shot, records, ctx.env.workDir), current);
    if (got.asset) current = { ...current, shots: current.shots.map((s, k) => (k === i ? swapBroll(s, got.asset as RealizedAsset) : s)) };
    const note = got.asset ? `镜头 ${i}：换成 ${got.asset.meta.credit.source} 的素材` : `镜头 ${i}：没找到可替换的素材，保留原素材（${got.errors.slice(-1)[0] ?? '没有达标的候选'}）`;
    notes = [...notes, note];
    ctx.emit(`B-roll ${note}`, brollDetail({ phase: 'beat', index: i, status: got.asset ? 'placed' : 'skipped', spentYuan: ctx.env.budget.spent() }));
  }
  return { storyboard: current, notes };
}
