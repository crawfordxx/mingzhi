import type { Beat } from './plan.js';

type Present = Beat['present'];

/** 呈现方式分布目标：全屏每 30 秒至少 1 次，pip+overlay 每 60 秒至少 1 次，split 不超过六成 */
const FULL_PER_SEC = 30;
const LIGHT_PER_SEC = 60;
export const MAX_SPLIT_RATIO = 0.6;

export interface PresentTargets { minFull: number; minLight: number }

export const presentTargets = (durationSec: number): PresentTargets => ({
  minFull: Math.floor(durationSec / FULL_PER_SEC),
  minLight: Math.floor(durationSec / LIGHT_PER_SEC),
});

export const presentCounts = (beats: Beat[]): Record<Present, number> => ({
  'broll-full': beats.filter((b) => b.present === 'broll-full').length,
  split: beats.filter((b) => b.present === 'split').length,
  pip: beats.filter((b) => b.present === 'pip').length,
  overlay: beats.filter((b) => b.present === 'overlay').length,
});

/** 分布不达标的原因（中文，兼作重试提示）；达标返回空数组 */
export function presentIssues(beats: Beat[], durationSec: number): string[] {
  const counts = presentCounts(beats);
  const { minFull, minLight } = presentTargets(durationSec);
  const light = counts.pip + counts.overlay;
  return [
    ...(counts['broll-full'] < minFull ? [`broll-full 只有 ${counts['broll-full']} 次，至少需要 ${minFull} 次`] : []),
    ...(light < minLight ? [`pip 与 overlay 合计只有 ${light} 次，至少需要 ${minLight} 次`] : []),
    ...(counts.split > beats.length * MAX_SPLIT_RATIO ? [`split 占 ${counts.split}/${beats.length}，不能超过 ${MAX_SPLIT_RATIO * 100}%`] : []),
  ];
}

const isReal = (b: Beat): boolean => b.kind === 'footage' || b.kind === 'photo';

/** 各呈现方式的适配分：全屏给实拍与实物（具体名词、动作），pip 给讲解截图与流程，overlay 给情绪与总结；0 表示不适合 */
const SCORERS: Record<Present, (b: Beat) => number> = {
  'broll-full': (b) => (b.kind === 'footage' ? 3 : b.kind === 'photo' ? 2 : 0) + (isReal(b) && (b.role === 'illustrate' || b.role === 'emote') ? 1 : 0),
  pip: (b) => ({ screenshot: 3, ui: 3, chart: 2, footage: 1, photo: 1, generated: 1 })[b.kind] + (b.role === 'prove' || b.role === 'locate' ? 1 : 0),
  overlay: (b) => (b.role === 'emote' ? 3 : b.role === 'define' ? 2 : 1) + (b.kind === 'generated' ? 1 : 0),
  split: () => 0,
};

interface Choice { index: number; present: Present; score: number }

/** 在仍是 split 的 beat 里挑一个最适合改成 options 之一的；没有适合的返回 null */
function bestChoice(beats: Beat[], options: Present[]): Choice | null {
  const choices = beats.flatMap((b, index) => (b.present === 'split' ? options.map((present) => ({ index, present, score: SCORERS[present](b) })) : []));
  return choices.filter((c) => c.score > 0).sort((a, b) => b.score - a.score)[0] ?? null;
}

function promote(beats: Beat[], need: number, options: Present[]): Beat[] {
  const choice = need > 0 ? bestChoice(beats, options) : null;
  if (!choice) return beats;
  return promote(beats.map((b, i) => (i === choice.index ? { ...b, present: choice.present } : b)), need - 1, options);
}

/** 分布不达标时，按 kind 与 role 把最适合的 split beat 改成 broll-full、pip、overlay；不改动入参 */
export function rebalancePresent(beats: Beat[], durationSec: number): Beat[] {
  const { minFull, minLight } = presentTargets(durationSec);
  const withFull = promote(beats, minFull - presentCounts(beats)['broll-full'], ['broll-full']);
  const counts = presentCounts(withFull);
  const withLight = promote(withFull, minLight - counts.pip - counts.overlay, ['pip', 'overlay']);
  const excessSplit = presentCounts(withLight).split - Math.floor(withLight.length * MAX_SPLIT_RATIO);
  return promote(withLight, excessSplit, ['broll-full', 'pip', 'overlay']);
}
