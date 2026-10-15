import type { TimedCaption } from '../captions/lines.js';
import type { EditPlan as CutPlan, TimeRange } from '../cut/plan.js';
import type { Storyboard } from '../storyboard/schema.js';
import { canonicalize } from './layout-rules.js';
import { outputToSource } from './spans.js';

const round = (n: number): number => Math.round(n * 1000) / 1000;
/** 重新对时后短于此的字幕丢弃（基本只剩被剪得所剩无几的残片） */
const MIN_CAPTION_SEC = 0.1;

/** 原片时间区间 → 成片时间区间（只取落在 keep 内的部分） */
function sourceToOutput(keep: TimeRange[], from: number, to: number): TimeRange[] {
  const pieces: TimeRange[] = [];
  let offset = 0;
  for (const r of keep) {
    const lo = Math.max(from, r.start);
    const hi = Math.min(to, r.end);
    if (hi > lo) pieces.push({ start: round(offset + lo - r.start), end: round(offset + hi - r.start) });
    offset += r.end - r.start;
  }
  return pieces;
}

/** 旧成片时间区间 → 新成片时间区间：先回到原片时间，再按新剪辑方案换算；整段都被剪掉返回 null */
export function remapRange(oldKeep: TimeRange[], newKeep: TimeRange[], start: number, end: number): TimeRange | null {
  const pieces = outputToSource(oldKeep, start, end).flatMap((p) => sourceToOutput(newKeep, p.start, p.end));
  if (pieces.length === 0) return null;
  return { start: Math.min(...pieces.map((p) => p.start)), end: Math.max(...pieces.map((p) => p.end)) };
}

/**
 * 字幕按新剪辑方案重新对时（不改文字、不调模型）：每句字幕按它在原片里的位置换算到新成片时间；
 * 整句被剪掉的丢弃，重叠的把前一句的结尾收到下一句开头。
 */
export function retimeCaptions(captions: TimedCaption[], oldPlan: CutPlan, newPlan: CutPlan): TimedCaption[] {
  const timed = captions.flatMap((c) => {
    const r = remapRange(oldPlan.keep, newPlan.keep, c.start, c.end);
    return r && r.end - r.start >= MIN_CAPTION_SEC ? [{ ...c, start: r.start, end: r.end }] : [];
  }).sort((a, b) => a.start - b.start);
  return timed.map((c, i) => (timed[i + 1] && c.end > timed[i + 1].start ? { ...c, end: timed[i + 1].start } : c));
}

/**
 * 分镜按新剪辑方案平移（卡片、素材、配乐、封面标题原样保留）：
 * 镜头按同样方式换算，完全落在被剪区间里的镜头删掉；镜头之间的新增内容并入前一个镜头，
 * 片头从 0、片尾到新成片末尾；随后交给 normalizeStoryboard 做版式整理（过短的并入相邻镜头、卡片镜头限长等）。
 */
export function remapStoryboard(oldPlan: CutPlan, newPlan: CutPlan, storyboard: Storyboard): Storyboard {
  const moved = storyboard.shots.flatMap((s) => {
    const r = remapRange(oldPlan.keep, newPlan.keep, s.start, s.end);
    return r ? [{ ...s, start: r.start, end: r.end }] : [];
  }).sort((a, b) => a.start - b.start);
  if (moved.length === 0) return canonicalize({ ...storyboard, shots: [{ start: 0, end: newPlan.outputDurationSec, layout: 'full' }] }).storyboard;
  const joined = moved.map((s, i) => ({
    ...s,
    start: i === 0 ? 0 : s.start,
    end: i === moved.length - 1 ? newPlan.outputDurationSec : moved[i + 1].start,
  }));
  return canonicalize({ ...storyboard, shots: joined }).storyboard;
}
