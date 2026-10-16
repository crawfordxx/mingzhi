import { throwIfCancelled } from '../cancel.js';
import { dropBroll, swapBroll } from '../broll/assign.js';
import { readAssetMeta, usedOf } from '../broll/credit-store.js';
import { DEFAULT_AVOID } from '../broll/plan-check.js';
import { BeatSchema, type Beat } from '../broll/plan.js';
import type { RealizedAsset } from '../broll/realize.js';
import type { Shot, Storyboard } from '../storyboard/schema.js';
import type { BeatRecord } from './broll-beats.js';
import { collect, pick, type BeatsCtx } from './broll-pick.js';
import { brollDetail } from './detail.js';

/** 素材面板的标记：replace 换一张，remove 去掉（键是 credits.json 里的相对路径） */
export type BrollMark = 'replace' | 'remove';

const PRESENT: Record<Shot['layout'], Beat['present']> = { broll: 'broll-full', pip: 'pip', overlay: 'overlay', split: 'split', full: 'split' };

/** 记录里的完整节拍（存进版本状态的那份）；字段不全的旧记录返回 undefined */
function beatOf(r: BeatRecord): Beat | undefined {
  const parsed = BeatSchema.safeParse(r);
  return parsed.success ? parsed.data : undefined;
}

/** 这个镜头对应的上一版节拍记录：素材文件相同的那条，否则时间重叠最多的那条 */
function recordForShot(shot: Shot, records: readonly BeatRecord[]): BeatRecord | undefined {
  const overlap = (r: BeatRecord): number => Math.min(r.end, shot.end) - Math.max(r.start, shot.start);
  return records.find((r) => shot.broll && r.file === shot.broll.file) ?? records.filter((r) => overlap(r) > 0).sort((a, b) => overlap(b) - overlap(a))[0];
}

/**
 * 这个镜头原来的节拍：用原节拍的全部字段（mustShow、avoid 等），只把时间换成镜头现在的时间；
 * 没有记录（旧项目）时按素材记录的搜索词重建
 */
export function beatForShot(shot: Shot, records: readonly BeatRecord[], workDir: string): Beat {
  const rec = recordForShot(shot, records);
  const original = rec ? beatOf(rec) : undefined;
  const present = original?.present ?? PRESENT[shot.layout];
  if (original) return { ...original, start: shot.start, end: shot.end, present };
  const meta = shot.broll ? readAssetMeta(workDir, shot.broll.file) : undefined;
  const query = meta?.credit.query || 'documentary b-roll';
  return {
    start: shot.start, end: shot.end, present, role: 'illustrate',
    kind: meta?.credit.source === 'screenshot' ? 'screenshot' : meta?.kind === 'video' ? 'footage' : 'photo',
    subject: query, mustShow: [], avoid: [...DEFAULT_AVOID], queryEn: [query], queryZh: [], shotSize: 'MS', motion: 'static',
  };
}

/** 给一个节拍重新找一张：排除全片已用的素材（id 与画面哈希）和这个节拍用过的全部候选；生图取下一个没用过的变体，保证换到新图 */
async function findAnother(ctx: BeatsCtx, beat: Beat, storyboard: Storyboard, history: readonly string[]): Promise<{ asset?: RealizedAsset; errors: string[] }> {
  const used = usedOf(storyboard, ctx.env.workDir);
  const ids = [...new Set([...used.ids, ...history])];
  const pool = await collect(ctx, beat, `redo-${Math.round(beat.start * 1000)}-${history.length}`, ids);
  const got = await pick(ctx, beat, pool, { usedIds: ids, hashes: used.hashes }, true);
  return { ...(got.asset ? { asset: got.asset } : {}), errors: got.errors };
}

/** 秒数 sec 落在哪个镜头里 */
const shotAt = (shots: readonly Shot[], sec: number): number => shots.findIndex((s) => sec >= s.start && sec < s.end);
const withShot = (sb: Storyboard, i: number, shot: Shot): Storyboard => ({ ...sb, shots: sb.shots.map((s, k) => (k === i ? shot : s)) });

/**
 * 修改版本「换一张 B-roll」：只重做 at（成片秒数，每个对应一个镜头）指向的带素材镜头，其余镜头原样不动。
 * 素材面板标了 remove 的去掉素材；其余（含标了 replace）按原节拍重新检索、审片、挑一张没用过的换上；
 * 拿不到新的（或只拿回原来那张）就保留原素材并说明
 */
export async function redoShots(ctx: BeatsCtx, storyboard: Storyboard, at: readonly number[], marks: Readonly<Record<string, BrollMark>>, records: readonly BeatRecord[]): Promise<{ storyboard: Storyboard; notes: string[]; records: BeatRecord[] }> {
  let current = storyboard;
  let notes: string[] = [];
  let recs = [...records];
  for (const sec of at) {
    throwIfCancelled(ctx.env.signal);
    const i = shotAt(current.shots, sec);
    const shot = current.shots[i];
    if (!shot?.broll) continue;
    if (marks[shot.broll.file] === 'remove') {
      current = withShot(current, i, dropBroll(shot));
      notes = [...notes, `镜头 ${i}：已去掉素材`];
      continue;
    }
    const rec = recordForShot(shot, recs);
    const oldMeta = readAssetMeta(ctx.env.workDir, shot.broll.file);
    const history = [...(rec?.history ?? []), ...(oldMeta ? [oldMeta.candidateId] : [])];
    const got = await findAnother(ctx, beatForShot(shot, recs, ctx.env.workDir), current, history);
    const fresh = got.asset && got.asset.file !== shot.broll.file ? got.asset : undefined;
    if (fresh) {
      current = withShot(current, i, swapBroll(shot, fresh));
      const old = shot.broll.file;
      recs = recs.map((r) => (r === rec || r.file === old ? { ...r, file: fresh.file, source: fresh.meta.credit.source, history: [...new Set([...history, fresh.meta.candidateId])] } : r));
    }
    const note = fresh ? `镜头 ${i}：换成 ${fresh.meta.credit.source} 的素材` : `镜头 ${i}：没找到可替换的素材，保留原素材（${got.errors.slice(-1)[0] ?? '没有达标的候选'}）`;
    notes = [...notes, note];
    ctx.emit(`B-roll ${note}`, brollDetail({ phase: 'beat', index: i, status: fresh ? 'placed' : 'skipped', spentYuan: ctx.env.budget.spent() }));
  }
  return { storyboard: current, notes, records: recs };
}
