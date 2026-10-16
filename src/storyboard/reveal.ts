/**
 * 持续演进：列表（evidenceList、strikeList）、对比（compareBars）、流程（flow）卡跨 2–4 句字幕，条目按 reveal 秒点逐条出现/点亮。
 * reveal 一律存「镜头内相对秒」：模型（生成、重写、对话换卡）按字幕给的成片秒数由 revealToLocal 换算；模型没写时 fillReveal 按镜头内字幕起点补齐；
 * 剪辑平移按镜头伸缩同比缩放（scaleReveal），再由 fitRevealToShots 按新时长校验（越界的均匀重排）
 */
import type { TimedCaption } from '../captions/lines.js';
import type { CardSpec, Shot } from './schema.js';

/** 最后一条至少在镜头结束前这么久出现，来得及看清 */
export const REVEAL_TAIL_SEC = 0.5;

type Revealing = Extract<CardSpec, { template: 'evidenceList' | 'strikeList' | 'compareBars' | 'flow' }>;

/** 支持 reveal 的卡片条目数；其他模板返回 0 */
export function revealItems(card: CardSpec): number {
  switch (card.template) {
    case 'evidenceList': return card.props.rows.length;
    case 'strikeList': return card.props.items.length;
    case 'compareBars': return card.props.items.length;
    case 'flow': return card.props.steps.length;
    default: return 0;
  }
}

const isRevealing = (card: CardSpec | undefined): card is Revealing => card !== undefined && revealItems(card) > 0;
const round = (n: number): number => Math.round(n * 1000) / 1000;

function withReveal(shot: Shot, card: Revealing, reveal: number[] | undefined): Shot {
  const { reveal: _old, ...props } = card.props as Revealing['props'] & { reveal?: number[] };
  return { ...shot, card: { ...card, props: reveal ? { ...props, reveal } : props } as CardSpec };
}

/** 相邻两条至少隔这么久出现（夹紧后挤在同一时刻的条目往后错开） */
export const MIN_REVEAL_GAP_SEC = 0.25;

/** 在 [from, hi] 里均匀排 n 个时刻（第一条在 from） */
const evenly = (n: number, from: number, hi: number): number[] => Array.from({ length: n }, (_, i) => round(from + (n > 1 ? (i * (hi - from)) / (n - 1) : 0)));

/**
 * 一组镜头内秒数 → 合法的 reveal：夹进 [0, 时长 − REVEAL_TAIL_SEC]、单调、相邻至少 MIN_REVEAL_GAP_SEC；
 * 往后错开放不下时在 [首条, 上限] 里均匀重排；连均匀重排都放不下（镜头太短）或条数不对返回 undefined
 */
export function fitReveal(times: readonly number[], n: number, dur: number): number[] | undefined {
  if (times.length !== n || n < 2) return undefined;
  const hi = Math.max(0, dur - REVEAL_TAIL_SEC);
  if ((n - 1) * MIN_REVEAL_GAP_SEC > hi + 1e-9) return undefined;
  const clamped = times.map((t) => Math.min(hi, Math.max(0, t)));
  const spaced = clamped.reduce<number[]>((acc, t) => [...acc, round(acc.length ? Math.max(t, acc[acc.length - 1] + MIN_REVEAL_GAP_SEC) : t)], []);
  if (spaced[n - 1] <= hi + 1e-9) return spaced;
  return evenly(n, Math.min(spaced[0], hi - (n - 1) * MIN_REVEAL_GAP_SEC), hi);
}

/**
 * 模型给的秒数 → 镜头内秒数：全部落在 [起点 − 0.5, 终点] 视为成片秒数（减去起点）；否则全部落在 [0, 时长] 视为已是镜头内秒数；
 * 两样都不是（越界）就在整个镜头里均匀重排
 */
function toLocal(times: readonly number[], start: number, end: number): number[] {
  const dur = end - start;
  if (times.every((t) => t >= start - 0.5 && t <= end)) return times.map((t) => t - start);
  if (times.every((t) => t >= 0 && t <= dur)) return [...times];
  return evenly(times.length, 0, Math.max(0, dur - REVEAL_TAIL_SEC));
}

const revealOf = (card: Revealing): number[] | undefined => (card.props as { reveal?: number[] }).reveal;

/** 模型输出（生成、重写、对话换卡）的 reveal 统一换算成镜头内秒数并校验，不合格的去掉 */
export function revealToLocal(shots: Shot[]): Shot[] {
  return shots.map((s) => {
    const card = s.card;
    const reveal = isRevealing(card) ? revealOf(card) : undefined;
    if (!isRevealing(card) || !reveal) return s;
    return withReveal(s, card, fitReveal(toLocal(reveal, s.start, s.end), revealItems(card), s.end - s.start));
  });
}

/** 已是镜头内秒数的 reveal 按当前镜头时长再校验一次（编辑平移、镜头被截短之后）；越界的按镜头时长均匀重排 */
export function fitRevealToShots(shots: Shot[]): Shot[] {
  return shots.map((s) => {
    const card = s.card;
    const reveal = isRevealing(card) ? revealOf(card) : undefined;
    if (!isRevealing(card) || !reveal) return s;
    const dur = s.end - s.start;
    const inside = reveal.every((t) => t >= 0 && t <= dur);
    const fitted = fitReveal(inside ? reveal : evenly(reveal.length, 0, Math.max(0, dur - REVEAL_TAIL_SEC)), revealItems(card), dur);
    return fitted && fitted.every((t, i) => t === reveal[i]) ? s : withReveal(s, card, fitted);
  });
}

/** 镜头时长按 factor 缩放（剪辑平移改变了镜头长度）时，reveal 同比缩放，保持与口播的相对位置 */
export function scaleReveal(shot: Shot, factor: number): Shot {
  const card = shot.card;
  const reveal = isRevealing(card) ? revealOf(card) : undefined;
  if (!isRevealing(card) || !reveal || factor === 1) return shot;
  return withReveal(shot, card, reveal.map((t) => round(t * factor)));
}

/** 模型没写 reveal 的演进卡：镜头内有 ≥ 2 句字幕起点时，第 i 条对应第 ⌊i·k/n⌋ 句的起点（第一条在镜头开始时出现） */
export function fillReveal(shots: Shot[], captions: TimedCaption[]): Shot[] {
  return shots.map((s) => {
    const card = s.card;
    if (!isRevealing(card) || ('reveal' in card.props && card.props.reveal)) return s;
    const starts = captions.map((c) => c.start - s.start).filter((t) => t > -0.5 && t < s.end - s.start - REVEAL_TAIL_SEC);
    if (starts.length < 2) return s;
    const n = revealItems(card);
    const times = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : starts[Math.floor((i * starts.length) / n)]));
    const reveal = fitReveal(times, n, s.end - s.start);
    return reveal ? withReveal(s, card, reveal) : s;
  });
}
