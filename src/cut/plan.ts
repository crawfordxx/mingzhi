import type { SpeechSegment, Token } from '../asr/types.js';
import type { Cut } from './llm-cuts.js';

export interface TimeRange { start: number; end: number }
export interface EditPlan { keep: TimeRange[]; sourceDurationSec: number; outputDurationSec: number }
export interface PlanOptions { pad: number; mergeGap: number; minKeep: number }

/** pad：语音段前后各留的气口；mergeGap：小于此间隔的两段直接连上；minKeep：短于此的碎片丢弃 */
export const DEFAULT_PLAN_OPTIONS: PlanOptions = { pad: 0.12, mergeGap: 0.3, minKeep: 0.25 };

const round = (n: number): number => Math.round(n * 1000) / 1000;

export function cutsToRanges(cuts: Cut[], tokens: Token[]): TimeRange[] {
  return cuts.map((c) => ({ start: tokens[c.from].start, end: tokens[c.to].end }));
}

function mergeClose(ranges: TimeRange[], gap: number): TimeRange[] {
  return [...ranges].sort((a, b) => a.start - b.start).reduce<TimeRange[]>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && r.start - last.end < gap) return [...acc.slice(0, -1), { start: last.start, end: Math.max(last.end, r.end) }];
    return [...acc, { ...r }];
  }, []);
}

function subtract(range: TimeRange, cuts: TimeRange[]): TimeRange[] {
  return cuts.reduce<TimeRange[]>((pieces, cut) => pieces.flatMap((p) => {
    if (cut.end <= p.start || cut.start >= p.end) return [p];
    return [{ start: p.start, end: cut.start }, { start: cut.end, end: p.end }].filter((x) => x.end > x.start);
  }), [range]);
}

export function buildEditPlan(segments: SpeechSegment[], cutRanges: TimeRange[], sourceDurationSec: number, opts: PlanOptions = DEFAULT_PLAN_OPTIONS): EditPlan {
  const padded = segments.map((s) => ({ start: Math.max(0, s.start - opts.pad), end: Math.min(sourceDurationSec, s.end + opts.pad) }));
  const keep = mergeClose(padded, opts.mergeGap)
    .flatMap((r) => subtract(r, cutRanges))
    .filter((r) => r.end - r.start >= opts.minKeep)
    .map((r) => ({ start: round(r.start), end: round(r.end) }));
  const outputDurationSec = round(keep.reduce((sum, r) => sum + (r.end - r.start), 0));
  return { keep, sourceDurationSec, outputDurationSec };
}

/** 原片时间 → 成片时间；落在被剪掉的区域返回 null */
export function mapToOutput(t: number, keep: TimeRange[]): number | null {
  let offset = 0;
  for (const r of keep) {
    if (t >= r.start && t <= r.end) return round(offset + (t - r.start));
    offset += r.end - r.start;
  }
  return null;
}
