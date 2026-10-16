/**
 * 持续演进：列表（evidenceList、strikeList）、对比（compareBars）、流程（flow）卡跨 2–4 句字幕，条目按 reveal 秒点逐条出现/点亮。
 * 模型按字幕给成片时间轴上的秒数，归一化后换算成镜头内秒数；模型没写时按镜头内字幕起点补齐
 */
import type { TimedCaption } from '../captions/lines.js';
import type { CardSpec, Shot } from './schema.js';

/** 最后一条至少在镜头结束前这么久出现，来得及看清 */
export const REVEAL_TAIL_SEC = 0.5;
/** 全部条目都在开头这么短的时间内出现就不算演进（按模板默认节奏） */
const MIN_SPREAD_SEC = 0.3;

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

/** 一组镜头内秒数 → 合法的 reveal：夹进 [0, 时长 − REVEAL_TAIL_SEC]、单调不减；条数不对或没有展开时返回 undefined */
function cleanReveal(times: number[], n: number, dur: number): number[] | undefined {
  if (times.length !== n || n < 2) return undefined;
  const hi = Math.max(0, dur - REVEAL_TAIL_SEC);
  const clamped = times.reduce<number[]>((acc, t) => [...acc, round(Math.max(acc[acc.length - 1] ?? 0, Math.min(hi, Math.max(0, t))))], []);
  return clamped[clamped.length - 1] - clamped[0] < MIN_SPREAD_SEC ? undefined : clamped;
}

/** 归一化最后一步：reveal 从成片秒数换算成镜头内秒数并校验，不合格的去掉 */
export function revealToLocal(shots: Shot[]): Shot[] {
  return shots.map((s) => {
    const card = s.card;
    if (!isRevealing(card) || !('reveal' in card.props) || !card.props.reveal) return s;
    const local = card.props.reveal.map((t) => t - s.start);
    return withReveal(s, card, cleanReveal(local, revealItems(card), s.end - s.start));
  });
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
    const reveal = cleanReveal(times, n, s.end - s.start);
    return reveal ? withReveal(s, card, reveal) : s;
  });
}
