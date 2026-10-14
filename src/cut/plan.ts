import type { SpeechSegment, Token } from '../asr/types.js';
import type { Cut } from './llm-cuts.js';

export interface TimeRange { start: number; end: number }
export interface EditPlan { keep: TimeRange[]; sourceDurationSec: number; outputDurationSec: number }
export interface PlanOptions { pad: number; mergeGap: number; minKeep: number }

/** pad：语音段前后各留的气口；mergeGap：小于此间隔的两段直接连上；minKeep：短于此的碎片丢弃 */
export const DEFAULT_PLAN_OPTIONS: PlanOptions = { pad: 0.12, mergeGap: 0.3, minKeep: 0.25 };

/** 成片帧率；保留区间边界对齐到 1/FPS 秒，渲染时音视频每段等长，字幕时间不漂移 */
export const FPS = 30;

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

/** 区间两端四舍五入到最近的帧，返回帧号；末尾不超过原片最后一个完整帧 */
function toFrames(r: TimeRange, maxFrame: number): { start: number; end: number } {
  return { start: Math.round(r.start * FPS), end: Math.min(Math.round(r.end * FPS), maxFrame) };
}

export function buildEditPlan(segments: SpeechSegment[], cutRanges: TimeRange[], sourceDurationSec: number, opts: PlanOptions = DEFAULT_PLAN_OPTIONS): EditPlan {
  const padded = segments.map((s) => ({ start: Math.max(0, s.start - opts.pad), end: Math.min(sourceDurationSec, s.end + opts.pad) }));
  const maxFrame = Math.floor(sourceDurationSec * FPS + 1e-6);
  const frames = mergeClose(padded, opts.mergeGap)
    .flatMap((r) => subtract(r, cutRanges))
    .map((r) => toFrames(r, maxFrame))
    .filter((f) => f.end - f.start >= opts.minKeep * FPS);
  const keep = frames.map((f) => ({ start: f.start / FPS, end: f.end / FPS }));
  const outputDurationSec = round(frames.reduce((sum, f) => sum + (f.end - f.start), 0) / FPS);
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
