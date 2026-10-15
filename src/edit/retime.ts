import type { Token } from '../asr/types.js';
import { fallbackLines, type TimedCaption, timeCaptions } from '../captions/lines.js';
import { mapToOutput, type EditPlan as CutPlan, type TimeRange } from '../cut/plan.js';
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
    return r ? [{ ...c, start: r.start, end: r.end }] : [];
  });
  return trimOverlaps(timed);
}

/** 按开始时间排序，重叠时把前一句收尾到后一句开头；收到不足 MIN_CAPTION_SEC 的丢弃 */
function trimOverlaps(captions: TimedCaption[]): TimedCaption[] {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  return sorted
    .map((c, i) => (sorted[i + 1] && c.end > sorted[i + 1].start ? { ...c, end: sorted[i + 1].start } : c))
    .filter((c) => c.end - c.start >= MIN_CAPTION_SEC);
}

const midpoint = (t: Token): number => (t.start + t.end) / 2;

/**
 * 找回的片段补字幕：取 restored（原片时间）内、并且在新剪辑方案里确实保留的 token，
 * 用现有的分行规则（fallbackLines，每行宽度与停顿断行）和 timeCaptions 生成字幕，
 * 与 existing（已重新对时的字幕）合并。existing 里已有文字包含它的（此前版本找回过）不重复添加；
 * 包住新字幕的旧字幕在新字幕开头处收尾，不把相邻字幕拉长。
 */
export function captionsForRestored(tokens: Token[], restored: TimeRange[], newPlan: CutPlan, existing: TimedCaption[]): TimedCaption[] {
  const inside = tokens.flatMap((t, i) => {
    const mid = midpoint(t);
    return restored.some((r) => mid >= r.start && mid <= r.end) && mapToOutput(mid, newPlan.keep) !== null ? [i] : [];
  });
  if (inside.length === 0) return existing;
  const fresh = timeCaptions(fallbackLines(tokens, inside), tokens, newPlan.keep)
    .filter((n) => !existing.some((e) => e.start < n.end && n.start < e.end && e.text.includes(n.text)));
  return trimOverlaps([...existing, ...fresh]);
}

/** 对比平移前后的分镜，说明哪些卡片因为所在镜头整个被删而消失；没有则返回空列表，供回复里告诉用户 */
export function droppedCardNotes(before: Storyboard, after: Storyboard): string[] {
  const count = (sb: Storyboard) => sb.shots.reduce<Record<string, number>>(
    (acc, s) => (s.card ? { ...acc, [s.card.template]: (acc[s.card.template] ?? 0) + 1 } : acc),
    {},
  );
  const b = count(before);
  const a = count(after);
  const lost = Object.entries(b).flatMap(([t, n]) => (n > (a[t] ?? 0) ? [{ t, n: n - (a[t] ?? 0) }] : []));
  if (lost.length === 0) return [];
  const total = lost.reduce((sum, l) => sum + l.n, 0);
  return [`去掉了 ${total} 张卡片（${lost.map((l) => (l.n > 1 ? `${l.t}×${l.n}` : l.t)).join('、')}）`];
}

/**
 * 分镜按新剪辑方案平移（卡片、素材、配乐、封面标题原样保留）：
 * 镜头按同样方式换算，完全落在被剪区间里的镜头删掉；镜头之间的新增内容并入前一个镜头，
 * 片头从 0、片尾到新成片末尾；随后交给 normalizeStoryboard 做版式整理（过短的并入相邻镜头、卡片镜头限长等）。
 */
export function remapStoryboard(oldPlan: CutPlan, newPlan: CutPlan, storyboard: Storyboard): Storyboard {
  if (!(newPlan.outputDurationSec > 0)) throw new Error('剪辑后成片长度为 0，无法平移分镜');
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
