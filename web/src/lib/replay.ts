/**
 * 重播时间表（纯函数，无副作用，单测见 replay.test.ts）。
 * 整个重播（开场停顿 + 事件放映 + 收尾停顿）严格不超过 REPLAY_MAX_MS。
 */
export const REPLAY_MAX_MS = 20_000;
/** 点「重播」后先停一下再放第一条 */
export const REPLAY_LEAD_MS = 300;
/** 放完最后一条后停一下再回到完整画面 */
export const REPLAY_HOLD_MS = 1_400;
/** 事件放映本身可用的时长 */
export const REPLAY_BUDGET_MS = REPLAY_MAX_MS - REPLAY_LEAD_MS - REPLAY_HOLD_MS;
const MIN_GAP_MS = 40;
const PROGRESS_WEIGHT = 0.25;

export interface Timed { t: number; step: string; detail?: { kind: string } }

/**
 * 第 i 条事件在放映开始后第几毫秒出现。
 * 真实间隔先开平方（长的抠像、渲染被压得多，短的识别、分镜几乎不压），同一步骤里连续的进度事件再乘 1/4，
 * 然后整体缩放到 ≤ budget；真实总时长本来就更短时按原速。每条至少间隔 40ms（放不下时再整体压缩）。
 */
export function replayOffsets(events: readonly Timed[], budget = REPLAY_BUDGET_MS): number[] {
  if (!events.length) return [];
  const gaps = events.map((e, i) => (i === 0 ? 0 : Math.max(0, e.t - events[i - 1].t)));
  const target = Math.min(budget, gaps.reduce((a, b) => a + b, 0));
  const repeatProgress = (i: number) => i > 0 && events[i].detail?.kind === 'progress' && events[i - 1].step === events[i].step;
  const curved = gaps.map((g, i) => Math.sqrt(g) * (repeatProgress(i) ? PROGRESS_WEIGHT : 1));
  const sum = curved.reduce((a, b) => a + b, 0) || 1;
  const scaled = curved.map((c, i) => (i === 0 ? 0 : Math.max(MIN_GAP_MS, (c / sum) * target)));
  const total = scaled.reduce((a, b) => a + b, 0);
  const fit = total > budget ? scaled.map((s) => (s * budget) / total) : scaled;
  return fit.reduce<number[]>((acc, g, i) => [...acc, (i === 0 ? 0 : acc[i - 1]) + g], []);
}
