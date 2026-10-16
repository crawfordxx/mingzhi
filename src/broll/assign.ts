import { MAX_SHOT_SEC, MIN_SHOT_SEC, type Broll, type Layout, type Shot, type TemplateId } from '../storyboard/schema.js';
import type { AssetMeta } from './credit-store.js';
import { MAX_FULL_SEC, MIN_BEAT_SEC } from './plan-check.js';
import type { Beat } from './plan.js';

/** 有自己画面的卡片（钩子、图片、网页）和 CTA 不让 B-roll 占用 */
const PROTECTED: readonly TemplateId[] = ['hook', 'cta', 'photo', 'browser'];
/** 能铺在图上的轻卡片：标题、大数字、标签（列表、对比条、流程这类信息密的卡压在图上读不清） */
const LIGHT: readonly TemplateId[] = ['title', 'bigNumber', 'chips'];
/** 全屏插入从卡片镜头头尾切出时，卡片至少留这么长（来得及进场、读完） */
export const CARD_KEEP_SEC = 2.5;
const EPS = 1e-6;
const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface PlaceAsset { file: string; meta: AssetMeta }
export interface PlaceResult { shots: Shot[]; layout?: Layout; reason?: string }

/** 人物全屏、没有卡片也没有素材的镜头：可以切出一段放 B-roll */
export const isFree = (s: Shot): boolean => !s.card && !s.broll && s.layout === 'full';
/** 分屏轻卡片镜头：素材可以铺在上半屏做底，卡片变玻璃排在图上 */
export const isCardHost = (s: Shot): boolean => s.layout === 'split' && !!s.card && LIGHT.includes(s.card.template) && !s.broll;
/** 可以从头尾切出一段做全屏插入的卡片镜头（普通卡片，留得下 2.5 秒卡片） */
const isCarvable = (s: Shot): boolean => s.layout === 'split' && !!s.card && !PROTECTED.includes(s.card.template) && !s.broll && s.end - s.start >= CARD_KEEP_SEC + MIN_BEAT_SEC - EPS;

/** 镜头里的素材字段 */
export function brollOf(asset: PlaceAsset): Broll {
  const { meta } = asset;
  return { file: asset.file, kind: meta.kind, focal: meta.focal, ...(meta.kind === 'video' && meta.durationSec ? { durationSec: meta.durationSec } : {}) };
}

/** beat 的呈现方式 → 镜头版式；素材只够铺上半屏（1080p 横屏）时全屏类退到分屏 */
export function layoutFor(present: Beat['present'], downgrade?: AssetMeta['downgrade']): Layout {
  if (present === 'broll-full' || present === 'pip') return downgrade === 'split' ? 'split' : present === 'pip' ? 'pip' : 'broll';
  return present === 'overlay' || downgrade === 'pip' ? 'overlay' : 'split';
}

const overlap = (s: Shot, a: number, b: number): number => Math.max(0, Math.min(s.end, b) - Math.max(s.start, a));

/**
 * 在镜头 shot 里取一段 [a, b] 放素材：尽量贴近 beat 的 [start, end]；切剩的边角要么为 0、要么不短于 1 秒（避免归一化把碎片并进素材镜头）；
 * 长度在 [1.5, maxLen] 之间。取不到返回 null
 */
export function regionIn(shot: Shot, start: number, end: number, maxLen: number): [number, number] | null {
  const starts = [shot.start, Math.max(shot.start, start), shot.start + MIN_SHOT_SEC];
  const options = starts.flatMap((a) => [shot.end, Math.min(shot.end, end), a + maxLen, shot.end - MIN_SHOT_SEC].map((b) => [round(a), round(b)] as [number, number]));
  const ok = ([a, b]: [number, number]): boolean => {
    const len = b - a, head = a - shot.start, tail = shot.end - b;
    return a >= shot.start - EPS && b <= shot.end + EPS && len >= MIN_BEAT_SEC - EPS && len <= maxLen + EPS
      && (head < EPS || head >= MIN_SHOT_SEC - EPS) && (tail < EPS || tail >= MIN_SHOT_SEC - EPS);
  };
  const fit = ([a, b]: [number, number]): number => Math.max(0, Math.min(b, end) - Math.max(a, start)) * 10 - Math.abs(a - start) - Math.abs(b - end);
  return options.filter(ok).sort((x, y) => fit(y) - fit(x))[0] ?? null;
}

/** 把第 i 个镜头切成 前段（人物）/ 素材段 / 后段（人物） */
function carve(shots: Shot[], i: number, [a, b]: [number, number], inserted: Shot): Shot[] {
  const s = shots[i];
  const pieces: Shot[] = [
    ...(a - s.start > EPS ? [{ start: s.start, end: a, layout: 'full' as const }] : []),
    { ...inserted, start: a, end: b },
    ...(s.end - b > EPS ? [{ start: b, end: s.end, layout: 'full' as const }] : []),
  ];
  return [...shots.slice(0, i), ...pieces, ...shots.slice(i + 1)];
}

const byOverlap = (shots: Shot[], beat: Beat, pred: (s: Shot) => boolean): number[] =>
  shots.map((s, i) => [i, overlap(s, beat.start, beat.end)] as const).filter(([i, len]) => len > EPS && pred(shots[i])).sort((x, y) => y[1] - x[1]).map(([i]) => i);

/** 在人物全屏镜头里切一段，按 layout 放素材 */
function placeOnFree(shots: Shot[], beat: Beat, asset: PlaceAsset, layout: Layout): Shot[] | null {
  const maxLen = layout === 'broll' ? MAX_FULL_SEC : MAX_SHOT_SEC;
  for (const i of byOverlap(shots, beat, isFree)) {
    const r = regionIn(shots[i], beat.start, beat.end, maxLen);
    if (r) return carve(shots, i, r, { start: r[0], end: r[1], layout, broll: brollOf(asset) });
  }
  return null;
}

/** 卡片的演进时刻整体前移 shift 秒（从头部切走一段后，镜头内时钟从切点开始） */
function shiftReveal(shot: Shot, shift: number): Shot {
  const props = shot.card?.props as { reveal?: number[] } | undefined;
  if (!shot.card || !props?.reveal) return shot;
  return { ...shot, card: { ...shot.card, props: { ...props, reveal: props.reveal.map((t) => round(Math.max(0, t - shift))) } } as Shot['card'] };
}

/** 从卡片镜头尾部（卡片留前 2.5 秒）或头部（卡片留后 2.5 秒）切一段做全屏插入；切剩的另一侧补人物 */
function carveCard(shots: Shot[], i: number, beat: Beat, asset: PlaceAsset, layout: Layout): Shot[] | null {
  const s = shots[i];
  const maxLen = layout === 'broll' ? MAX_FULL_SEC : MAX_SHOT_SEC;
  const inserted = (a: number, b: number): Shot => ({ start: a, end: b, layout, broll: brollOf(asset) });
  const tail = regionIn({ start: s.start + CARD_KEEP_SEC, end: s.end, layout: 'full' }, beat.start, beat.end, maxLen);
  const head = regionIn({ start: s.start, end: s.end - CARD_KEEP_SEC, layout: 'full' }, beat.start, beat.end, maxLen);
  const gain = (r: [number, number] | null): number => (r ? overlap({ ...s, start: r[0], end: r[1] }, beat.start, beat.end) : -1);
  const useTail = gain(tail) >= gain(head);
  const r = useTail ? tail : head;
  if (!r) return null;
  const pieces: Shot[] = useTail
    ? [{ ...s, end: r[0] }, inserted(r[0], r[1]), ...(s.end - r[1] > EPS ? [{ start: r[1], end: s.end, layout: 'full' as const }] : [])]
    : [...(r[0] - s.start > EPS ? [{ start: s.start, end: r[0], layout: 'full' as const }] : []), inserted(r[0], r[1]), shiftReveal({ ...s, start: r[1] }, r[1] - s.start)];
  return [...shots.slice(0, i), ...pieces, ...shots.slice(i + 1)];
}

/** 全屏插入、画中画没有人物镜头可放时，从重叠最多的普通卡片镜头头尾切一段 */
function placeOnCardEdge(shots: Shot[], beat: Beat, asset: PlaceAsset, layout: Layout): Shot[] | null {
  for (const i of byOverlap(shots, beat, isCarvable)) {
    const out = carveCard(shots, i, beat, asset, layout);
    if (out) return out;
  }
  return null;
}

/** 铺在分屏卡片镜头的上半屏做底：beat 至少盖住该镜头 1.5 秒（或一半） */
function placeOnCard(shots: Shot[], beat: Beat, asset: PlaceAsset): Shot[] | null {
  const i = byOverlap(shots, beat, isCardHost).find((k) => overlap(shots[k], beat.start, beat.end) >= Math.min(MIN_BEAT_SEC, (shots[k].end - shots[k].start) / 2) - EPS);
  return i === undefined ? null : shots.map((s, k) => (k === i ? { ...s, broll: brollOf(asset) } : s));
}

/**
 * 把一个加工好的素材放进分镜（不改入参）：全屏插入、画中画、浮层先放进人物全屏镜头里切出的一段；
 * 全屏插入、画中画再试从普通卡片镜头头尾切一段（卡片留 2.5 秒）；放不下或呈现方式是分屏时，铺到重叠的轻卡片（标题、大数字、标签）上半屏做底；
 * 再不行在人物镜头里切一段上半屏铺素材。都不行返回原分镜与原因
 */
export function placeAsset(shots: Shot[], beat: Beat, asset: PlaceAsset): PlaceResult {
  const layout = layoutFor(beat.present, asset.meta.downgrade);
  if (layout !== 'split') {
    const free = placeOnFree(shots, beat, asset, layout);
    if (free) return { shots: free, layout };
  }
  if (layout === 'broll' || layout === 'pip') {
    const edge = placeOnCardEdge(shots, beat, asset, layout);
    if (edge) return { shots: edge, layout };
  }
  const card = placeOnCard(shots, beat, asset);
  if (card) return { shots: card, layout: 'split' };
  const half = placeOnFree(shots, beat, asset, 'split');
  if (half) return { shots: half, layout: 'split' };
  return { shots, reason: '这段时间没有可放素材的镜头（钩子、CTA、自带画面或信息密的卡片占着）' };
}

/** 把镜头里的素材换成另一个（重做单个镜头）：全屏类素材只够铺上半屏时改成分屏 */
export function swapBroll(shot: Shot, asset: PlaceAsset): Shot {
  const downgraded = (shot.layout === 'broll' || shot.layout === 'pip') && asset.meta.downgrade === 'split';
  return { ...shot, broll: brollOf(asset), ...(downgraded ? { layout: 'split' as const } : {}) };
}

/** 去掉镜头里的素材：全屏插入、画中画、无卡片的分屏与浮层回到人物全屏 */
export function dropBroll(shot: Shot): Shot {
  const { broll: _b, ...rest } = shot;
  return rest.card ? rest : { ...rest, layout: 'full' };
}

