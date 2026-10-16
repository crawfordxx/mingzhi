import type { Beat } from './plan.js';

/** 每个 beat 的 avoid 都要带上的默认禁用项（stock 套路画面） */
export const DEFAULT_AVOID = ['全息', '机器人', '霓虹', '蓝色科技光效'] as const;
/** beat 最短 1.5 秒，更短的丢弃 */
export const MIN_BEAT_SEC = 1.5;
/** broll-full 单次最长 3.5 秒，超出截断 */
export const MAX_FULL_SEC = 3.5;
/** B-roll 总覆盖率下限 */
export const MIN_COVERAGE = 0.3;
/** 真实世界画面的最大间隔（秒） */
export const MAX_REAL_GAP_SEC = 15;

const REAL_KINDS: readonly Beat['kind'][] = ['footage', 'photo', 'screenshot'];
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface CoverageReport {
  /** beats 总时长 / 片长 */
  ratio: number;
  coverageOk: boolean;
  /** 每 15 秒至少 1 个真实世界画面是否满足 */
  realOk: boolean;
  /** 超过 15 秒没有真实画面的时间段，供编排层补 */
  realGaps: { start: number; end: number }[];
}

const withDefaultAvoid = (avoid: string[]): string[] => [...new Set([...avoid, ...DEFAULT_AVOID])];

/** 越界裁进 [0, 片长]、broll-full 截到 3.5 秒；完全在片外的返回 null */
function clamp(b: Beat, durationSec: number): Beat | null {
  const start = Math.max(0, b.start);
  const capped = b.present === 'broll-full' ? Math.min(b.end, start + MAX_FULL_SEC) : b.end;
  const end = Math.min(capped, durationSec);
  return end > start ? { ...b, start: round3(start), end: round3(end) } : null;
}

/**
 * 程序修正：越界裁剪、broll-full 截断、按开始时间排序后重叠时后一个让位、短于 1.5 秒丢弃；avoid 补齐默认禁用项；不改动入参。
 * dropped 是本阶段丢弃的 beat 数
 */
export function fixBeats(beats: Beat[], durationSec: number): { beats: Beat[]; dropped: number } {
  const clamped = beats.map((b) => clamp(b, durationSec));
  const sorted = clamped.filter((b): b is Beat => b !== null).sort((a, b) => a.start - b.start);
  const kept = sorted.reduce<Beat[]>((acc, b) => {
    const prevEnd = acc.length > 0 ? acc[acc.length - 1].end : 0;
    const shifted = b.start < prevEnd ? { ...b, start: prevEnd } : b;
    return shifted.end - shifted.start >= MIN_BEAT_SEC - 1e-9 ? [...acc, { ...shifted, avoid: withDefaultAvoid(shifted.avoid) }] : acc;
  }, []);
  return { beats: kept, dropped: beats.length - kept.length };
}

/** 覆盖率与真实画面节奏；缺口 = 相邻真实画面（含片头片尾）之间超过 15 秒的空档 */
export function measureCoverage(beats: Beat[], durationSec: number): CoverageReport {
  const total = beats.reduce((sum, b) => sum + (b.end - b.start), 0);
  const ratio = durationSec > 0 ? total / durationSec : 0;
  const real = beats.filter((b) => REAL_KINDS.includes(b.kind)).sort((a, b) => a.start - b.start);
  const scan = real.reduce<{ cursor: number; gaps: CoverageReport['realGaps'] }>((acc, b) => ({
    cursor: Math.max(acc.cursor, b.end),
    gaps: b.start - acc.cursor > MAX_REAL_GAP_SEC ? [...acc.gaps, { start: acc.cursor, end: b.start }] : acc.gaps,
  }), { cursor: 0, gaps: [] });
  const realGaps = durationSec - scan.cursor > MAX_REAL_GAP_SEC ? [...scan.gaps, { start: scan.cursor, end: durationSec }] : scan.gaps;
  return { ratio, coverageOk: ratio >= MIN_COVERAGE - 1e-9, realOk: realGaps.length === 0, realGaps };
}
