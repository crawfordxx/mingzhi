import { MAX_SHOT_SEC, MIN_SHOT_SEC, type Broll, type Layout, type Shot, type TemplateId } from '../storyboard/schema.js';
import type { AssetMeta } from './credit-store.js';
import { MAX_FULL_SEC, MIN_BEAT_SEC } from './plan-check.js';
import type { Beat } from './plan.js';

/** 自带画面的卡片（图片、网页）和 CTA 不让 B-roll 占用；钩子已有图或视频时同样不占 */
const PROTECTED: readonly TemplateId[] = ['cta', 'photo', 'browser'];
/** 头部切会让演进条目在镜头开头挤着出现：同等收益时优先尾部切 */
const HEAD_CARVE_PENALTY = 0.5;
/** 全屏插入从卡片镜头头尾切出时，卡片至少留这么长（来得及进场、读完） */
export const CARD_KEEP_SEC = 2.5;
const EPS = 1e-6;
const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface PlaceAsset { file: string; meta: AssetMeta }
/** 落点：free 人物镜头里切一段、carve 从卡片镜头头尾切一段、card 卡片镜头上半屏做底、half 人物镜头里切一段上半屏铺素材 */
export type Placement = 'free' | 'carve' | 'card' | 'half';
export interface PlaceResult { shots: Shot[]; layout?: Layout; placement?: Placement; reason?: string }

/** 人物全屏、没有卡片也没有素材的镜头：可以切出一段放 B-roll */
export const isFree = (s: Shot): boolean => !s.card && !s.broll && s.layout === 'full';
/** 还没取到图的图片卡（取不到就会退成人物全屏）：节拍素材可以替换它，省下为它单独生图 */
export function isPendingPhoto(s: Shot): boolean {
  if (s.card?.template !== 'photo' || s.broll) return false;
  const p = s.card.props;
  return !p.image && !p.video;
}
/** 能切一段放素材的镜头：人物全屏，或还没有图的图片卡 */
const isOpen = (s: Shot): boolean => isFree(s) || isPendingPhoto(s);
/** 卡片自己有没有画面：图片卡、网页卡、已取到图或视频的钩子 */
function ownMedia(s: Shot): boolean {
  if (!s.card) return false;
  if (PROTECTED.includes(s.card.template)) return true;
  const p = s.card.props as { image?: string; video?: string };
  return s.card.template === 'hook' && Boolean(p.image || p.video);
}
/** 分屏卡片镜头（含还没有图的钩子）：素材铺满上半屏 + 底部渐变压暗，卡片变玻璃排在图上 */
export const isCardHost = (s: Shot): boolean => s.layout === 'split' && !!s.card && !ownMedia(s) && !s.broll;
/** 可以从头尾切出一段做全屏插入的卡片镜头（普通卡片，留得下 2.5 秒卡片；钩子不切） */
const isCarvable = (s: Shot): boolean => isCardHost(s) && s.card?.template !== 'hook' && s.end - s.start >= CARD_KEEP_SEC + MIN_BEAT_SEC - EPS;

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** 画面角标：截图标来源站点，AI 生成标「AI 生成」；图库素材不标（署名在 credits 与导出文本里） */
export function labelOf(meta: AssetMeta): Broll['label'] {
  if (meta.credit.source === 'generated' || meta.credit.aiGenerated) return { kind: 'ai', text: 'AI 生成' };
  const host = meta.credit.source === 'screenshot' ? hostOf(meta.credit.page) : '';
  return host ? { kind: 'source', text: `来源：${host}`.slice(0, 30) } : undefined;
}

/** 镜头里的素材字段 */
export function brollOf(asset: PlaceAsset): Broll {
  const { meta } = asset;
  const label = labelOf(meta);
  return { file: asset.file, kind: meta.kind, focal: meta.focal, ...(meta.kind === 'video' && meta.durationSec ? { durationSec: meta.durationSec } : {}), ...(label ? { label } : {}) };
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
  // 取整到毫秒后再夹回镜头内：镜头边界是帧对齐的循环小数（如 8.1666…），取整会越界
  const near = (v: number, edge: number): boolean => Math.abs(v - edge) < 1e-3;
  const within = (v: number): number => (near(v, shot.start) ? shot.start : near(v, shot.end) ? shot.end : Math.min(shot.end, Math.max(shot.start, round(v))));
  const options = starts.flatMap((a) => [shot.end, Math.min(shot.end, end), a + maxLen, shot.end - MIN_SHOT_SEC].map((b) => [within(a), within(b)] as [number, number]));
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

/** 在人物全屏镜头（或还没有图的图片卡，切剩的部分回到人物全屏）里切一段，按 layout 放素材 */
function placeOnFree(shots: Shot[], beat: Beat, asset: PlaceAsset, layout: Layout): Shot[] | null {
  const maxLen = layout === 'broll' ? MAX_FULL_SEC : MAX_SHOT_SEC;
  for (const i of byOverlap(shots, beat, isOpen)) {
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
  const useTail = gain(tail) >= gain(head) - HEAD_CARVE_PENALTY;
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

/** 能铺底的分屏卡片镜头：beat 至少盖住该镜头 1.5 秒（或一半） */
const cardHostOf = (shots: Shot[], beat: Beat): number | undefined =>
  byOverlap(shots, beat, isCardHost).find((k) => overlap(shots[k], beat.start, beat.end) >= Math.min(MIN_BEAT_SEC, (shots[k].end - shots[k].start) / 2) - EPS);

/** 铺在分屏卡片镜头的上半屏做底 */
function placeOnCard(shots: Shot[], beat: Beat, asset: PlaceAsset): Shot[] | null {
  const i = cardHostOf(shots, beat);
  return i === undefined ? null : shots.map((s, k) => (k === i ? { ...s, broll: brollOf(asset) } : s));
}

/**
 * 节拍的呈现方式按落点修正：分屏节拍没有能铺底的卡片、只落在人物全屏镜头（或还没有图的图片卡）上时，
 * ≤ 3.5 秒改全屏插入、更长改画中画（检索按竖屏找；素材只够铺上半屏时放置阶段再退回上半屏）。截图只铺上半屏，不改
 */
export function presentFor(shots: Shot[], beat: Beat): Beat['present'] {
  if (beat.present !== 'split' || beat.kind === 'screenshot' || cardHostOf(shots, beat) !== undefined) return beat.present;
  const onPerson = byOverlap(shots, beat, isOpen).some((i) => regionIn(shots[i], beat.start, beat.end, MAX_SHOT_SEC) !== null);
  if (!onPerson) return beat.present;
  return beat.end - beat.start <= MAX_FULL_SEC + EPS ? 'broll-full' : 'pip';
}

/**
 * 把一个加工好的素材放进分镜（不改入参），按顺序试：
 * 1. 全屏插入、画中画、浮层：人物全屏镜头（或还没有图的图片卡，素材替换它）里切一段（free）；
 * 2. 全屏插入、画中画：从普通卡片镜头头尾切一段，卡片留 2.5 秒（carve）；
 * 3. 时间上覆盖到的卡片镜头（含还没有图的钩子）：素材铺满上半屏做底，卡片排在图上（card，分屏升级）；
 * 4. 人物镜头里切一段上半屏铺素材（half）。都不行返回原分镜与原因
 */
export function placeAsset(shots: Shot[], beat: Beat, asset: PlaceAsset): PlaceResult {
  const layout = layoutFor(beat.present, asset.meta.downgrade);
  const free = layout === 'split' ? null : placeOnFree(shots, beat, asset, layout);
  if (free) return { shots: free, layout, placement: 'free' };
  const edge = layout === 'broll' || layout === 'pip' ? placeOnCardEdge(shots, beat, asset, layout) : null;
  if (edge) return { shots: edge, layout, placement: 'carve' };
  const card = placeOnCard(shots, beat, asset);
  if (card) return { shots: card, layout: 'split', placement: 'card' };
  const half = placeOnFree(shots, beat, asset, 'split');
  if (half) return { shots: half, layout: 'split', placement: 'half' };
  return { shots, reason: '这段时间没有可放素材的镜头（CTA 或自带画面的卡片占着）' };
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

