import { rethrowIfCancelled } from '../cancel.js';
import { planCrop, type Size } from './crop.js';
import type { Beat } from './plan.js';
import type { Candidate, Source, SourceQuery } from './sources/types.js';

/** 一个免费图库来源 */
export interface NamedSource { name: 'pexels' | 'pixabay' | 'wikimedia'; search: Source }

/** 每个来源每次取的候选数（5–8） */
export const PER_SOURCE = 6;
/** 凑够这么多候选就不再换搜索词 */
export const WANT_CANDIDATES = 12;
/** 联系表最多放 9 格 */
export const SHEET_SLOTS = 9;
/** 视频原文件上限：太大的下载慢、也多半是长片 */
export const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
/** 视频最长时长：图库里几十分钟的演讲、纪录片不要 */
export const MAX_VIDEO_SEC = 180;

/** 各呈现方式的加工目标尺寸：全屏插入与画中画铺满竖屏，分屏上半屏，浮层是胸前 16:9 小窗 */
export const TARGETS: Record<Beat['present'], Size> = {
  'broll-full': { width: 1080, height: 1920 },
  pip: { width: 1080, height: 1920 },
  split: { width: 1080, height: 960 },
  overlay: { width: 1280, height: 720 },
};

/** 全屏类呈现：素材要能铺满竖屏（竖屏或 4K 横屏），1080p 横屏只能退到分屏 */
export const isFullPresent = (p: Beat['present']): boolean => p === 'broll-full' || p === 'pip';

export interface Gathered {
  candidates: Candidate[];
  /** 各来源返回的候选数（过滤前） */
  counts: Record<string, number>;
  /** 失败的来源与原因（网络失败、限流）：该来源跳过，其它来源照常 */
  errors: string[];
}

/** beat 的检索种类：实拍优先视频（图片补充），实物照片只要图 */
function kindOf(beat: Beat): SourceQuery['kind'] {
  return beat.kind === 'footage' ? 'any' : 'photo';
}

/** 能否用在目标尺寸上：缩到小窗（pip 降级）的不要；全屏目标再看能否铺满 */
export function fitOf(c: Pick<Candidate, 'width' | 'height'>, target: Size): 'cover' | 'split' | 'none' {
  const plan = planCrop({ width: c.width, height: c.height }, { x: 0.5, y: 0.5 }, target);
  if (!plan.downgrade) return 'cover';
  return plan.downgrade === 'split' ? 'split' : 'none';
}

/** 视频太长、太大的不要（下载与选段都不划算） */
const sane = (c: Candidate): boolean =>
  c.kind === 'photo' || ((c.durationSec ?? 0) <= MAX_VIDEO_SEC && (c.sizeBytes ?? 0) <= MAX_VIDEO_BYTES);

/** 排序：能铺满的在前；实拍 beat 视频在前；其余保持各来源的相关度顺序并交错，不让一个来源占满联系表 */
export function rankForSheet(candidates: readonly Candidate[], beat: Beat): Candidate[] {
  const target = TARGETS[beat.present];
  const order = new Map<string, number>();
  const perSource = new Map<string, number>();
  for (const c of candidates) {
    const k = perSource.get(c.source) ?? 0;
    perSource.set(c.source, k + 1);
    order.set(c.id, k);
  }
  const score = (c: Candidate): number =>
    (fitOf(c, target) === 'cover' ? 0 : 100) + (beat.kind === 'footage' && c.kind !== 'video' ? 50 : 0) + (order.get(c.id) ?? 0);
  return [...candidates].sort((a, b) => score(a) - score(b));
}

/** 搜索词：模型给的英文词，再补每个词的前两个词（Wikimedia 是字面检索，长词组常常零结果） */
export function queriesOf(beat: Beat): string[] {
  const short = beat.queryEn.map((q) => q.split(/\s+/).slice(0, 2).join(' ')).filter((q) => q.split(' ').length === 2);
  return [...new Set([...beat.queryEn, ...short])];
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function searchAll(sources: readonly NamedSource[], q: SourceQuery, signal?: AbortSignal): Promise<{ found: Candidate[]; counts: Record<string, number>; errors: string[] }> {
  const settled = await Promise.allSettled(sources.map((s) => s.search(q, signal)));
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  const found = settled.flatMap((r, i) => {
    if (r.status === 'fulfilled') { counts[sources[i].name] = r.value.length; return r.value; }
    rethrowIfCancelled(r.reason);
    if (signal?.aborted) throw r.reason;
    errors.push(`${sources[i].name}：${reason(r.reason)}`);
    return [];
  });
  return { found, counts, errors };
}

/**
 * 免费来源并行检索一个 beat 的候选：英文搜索词逐个试，凑够 12 个就停；
 * 去掉全片已用过的、重复的、太长太大的视频、分辨率连小窗都撑不起的；排好序最多留 9 个上联系表
 */
export async function gatherCandidates(beat: Beat, sources: readonly NamedSource[], usedIds: readonly string[], signal?: AbortSignal): Promise<Gathered> {
  const orientation: SourceQuery['orientation'] = isFullPresent(beat.present) ? 'portrait' : 'landscape';
  const target = TARGETS[beat.present];
  let pool: Candidate[] = [];
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  for (const text of queriesOf(beat)) {
    if (pool.length >= WANT_CANDIDATES || sources.length === 0) break;
    const r = await searchAll(sources, { text, orientation, kind: kindOf(beat), perPage: PER_SOURCE }, signal);
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
    errors.push(...r.errors);
    const fresh = r.found.filter((c) => !usedIds.includes(c.id) && !pool.some((p) => p.id === c.id) && sane(c) && fitOf(c, target) !== 'none');
    pool = [...pool, ...fresh];
  }
  return { candidates: rankForSheet(pool, beat).slice(0, SHEET_SLOTS), counts, errors };
}
