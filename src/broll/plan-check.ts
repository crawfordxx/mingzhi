import type { Beat } from './plan.js';
import { presentCounts, presentIssues, rebalancePresent } from './plan-present.js';

/** 每个 beat 的 avoid 都要带上的默认禁用项（stock 套路画面） */
export const DEFAULT_AVOID = ['全息', '机器人', '霓虹', '蓝色科技光效'] as const;
/** beat 最短 1.5 秒，更短的丢弃 */
export const MIN_BEAT_SEC = 1.5;
/** broll-full 单次最长 3.5 秒，超出截断 */
export const MAX_FULL_SEC = 3.5;
/** 其他呈现方式单个 beat 最长 8 秒，超出截断 */
export const MAX_BEAT_SEC = 8;
/** B-roll 总覆盖率下限 */
export const MIN_COVERAGE = 0.3;
/** 真实世界画面的最大间隔（秒） */
export const MAX_REAL_GAP_SEC = 15;

const REAL_KINDS: readonly Beat['kind'][] = ['footage', 'photo', 'screenshot'];
/** chart、ui 是自绘或界面示意，不需要去图库检索 */
const NO_SEARCH_KINDS: readonly Beat['kind'][] = ['chart', 'ui', 'generated'];
const SHOT_ORDER = ['ECU', 'CU', 'MS', 'WS'] as const;
/** 搜索词里不许出现的 stock 套路词 */
const FORBIDDEN_QUERY = /hologra|robot|neon|glowing|全息|机器人|霓虹/i;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface CoverageReport {
  /** 全部 beat 总时长 / 片长（含 chart、ui，口径是画面被规划占用的比例） */
  ratio: number;
  /** 只算实拍、实物、截图的总时长 / 片长 */
  realRatio: number;
  coverageOk: boolean;
  /** 每 15 秒至少 1 个真实世界画面是否满足 */
  realOk: boolean;
  /** 超过 15 秒没有真实画面的时间段，供编排层补 */
  realGaps: { start: number; end: number }[];
  /** 呈现方式分布（broll-full 每 30 秒至少 1 次、pip+overlay 每 60 秒至少 1 次、split 不超过 60%）是否满足 */
  presentOk: boolean;
  /** 分布不达标的原因 */
  presentIssues: string[];
  presentCounts: Record<Beat['present'], number>;
}

/** 越界裁进 [0, 片长]、broll-full 截到 3.5 秒、其他最长 8 秒；完全在片外的返回 null */
function clamp(b: Beat, durationSec: number): Beat | null {
  const start = Math.max(0, b.start);
  const end = Math.min(b.end, start + (b.present === 'broll-full' ? MAX_FULL_SEC : MAX_BEAT_SEC), durationSec);
  return end > start ? { ...b, start: round3(start), end: round3(end) } : null;
}

/** 重叠时后一个让位，让位后短于 1.5 秒的丢弃；入参须已按开始时间排序 */
const resolveOverlaps = (sorted: Beat[]): Beat[] => sorted.reduce<Beat[]>((acc, b) => {
  const prevEnd = acc.length > 0 ? acc[acc.length - 1].end : 0;
  const shifted = b.start < prevEnd ? { ...b, start: prevEnd } : b;
  return shifted.end - shifted.start >= MIN_BEAT_SEC - 1e-9 ? [...acc, shifted] : acc;
}, []);

/** avoid 补齐默认禁用项、搜索词滤掉禁用词；urlHint 一律标记为未核实（是模型凭记忆给的） */
function cleanFields(b: Beat): Beat {
  const { urlHint, urlHintUnverified: _marked, ...rest } = b;
  return {
    ...rest,
    avoid: [...new Set([...b.avoid, ...DEFAULT_AVOID])],
    queryEn: b.queryEn.filter((q) => !FORBIDDEN_QUERY.test(q)),
    queryZh: b.queryZh.filter((q) => !FORBIDDEN_QUERY.test(q)),
    ...(b.queryAlt ? { queryAlt: b.queryAlt.filter((q) => !FORBIDDEN_QUERY.test(q)) } : {}),
    ...(urlHint ? { urlHint, urlHintUnverified: true as const } : {}),
  };
}

/** 需要检索的 beat 搜索词被滤光后无法检索，丢弃（截图类有 urlHint 可保留） */
const searchable = (b: Beat): boolean => NO_SEARCH_KINDS.includes(b.kind) || b.queryEn.length > 0 || (b.kind === 'screenshot' && Boolean(b.urlHint));

/** 相邻同景别时把后一个调到相邻景别，尽量不和再后一个相同 */
const alternateShots = (beats: Beat[]): Beat[] => beats.reduce<Beat[]>((acc, b, i) => {
  if (acc.length === 0 || acc[acc.length - 1].shotSize !== b.shotSize) return [...acc, b];
  const idx = SHOT_ORDER.indexOf(b.shotSize);
  const options = [SHOT_ORDER[idx - 1], SHOT_ORDER[idx + 1]].filter((s) => s !== undefined);
  const next = beats[i + 1]?.shotSize;
  return [...acc, { ...b, shotSize: options.find((s) => s !== next) ?? options[0] }];
}, []);

/** 改成 broll-full 的 beat 也要截到 3.5 秒 */
const capFull = (b: Beat): Beat => (b.present === 'broll-full' && b.end - b.start > MAX_FULL_SEC ? { ...b, end: round3(b.start + MAX_FULL_SEC) } : b);

/**
 * 程序修正：越界裁剪、时长上限（broll-full 3.5 秒，其他 8 秒）、按开始时间排序后重叠时后一个让位、短于 1.5 秒丢弃；
 * avoid 补齐默认禁用项、搜索词滤掉禁用词（滤光的丢弃）、urlHint 标记未核实；相邻同景别时调整景别；
 * 呈现方式分布不达标时按 kind 与 role 改 present。不改动入参。dropped 是本阶段丢弃的 beat 数
 */
export function fixBeats(beats: Beat[], durationSec: number): { beats: Beat[]; dropped: number } {
  const clamped = beats.map((b) => clamp(b, durationSec)).filter((b): b is Beat => b !== null);
  const kept = resolveOverlaps(clamped.sort((a, b) => a.start - b.start)).map(cleanFields).filter(searchable);
  const final = rebalancePresent(alternateShots(kept), durationSec).map(capFull);
  return { beats: final, dropped: beats.length - final.length };
}

const totalSec = (beats: Beat[]): number => beats.reduce((sum, b) => sum + (b.end - b.start), 0);

/** 覆盖率、真实画面节奏与呈现分布；入参须已经过 fixBeats（重叠会重复累计）。缺口 = 相邻真实画面（含片头片尾）之间超过 15 秒的空档 */
export function measureCoverage(beats: Beat[], durationSec: number): CoverageReport {
  const ratio = durationSec > 0 ? totalSec(beats) / durationSec : 0;
  const real = beats.filter((b) => REAL_KINDS.includes(b.kind)).sort((a, b) => a.start - b.start);
  const scan = real.reduce<{ cursor: number; gaps: CoverageReport['realGaps'] }>((acc, b) => ({
    cursor: Math.max(acc.cursor, b.end),
    gaps: b.start - acc.cursor > MAX_REAL_GAP_SEC ? [...acc.gaps, { start: acc.cursor, end: b.start }] : acc.gaps,
  }), { cursor: 0, gaps: [] });
  const realGaps = durationSec - scan.cursor > MAX_REAL_GAP_SEC ? [...scan.gaps, { start: scan.cursor, end: durationSec }] : scan.gaps;
  const issues = presentIssues(beats, durationSec);
  return {
    ratio,
    realRatio: durationSec > 0 ? totalSec(real) / durationSec : 0,
    coverageOk: ratio >= MIN_COVERAGE - 1e-9,
    realOk: realGaps.length === 0,
    realGaps,
    presentOk: issues.length === 0,
    presentIssues: issues,
    presentCounts: presentCounts(beats),
  };
}
