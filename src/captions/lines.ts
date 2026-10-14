import { z } from 'zod';
import type { Token } from '../asr/types.js';
import type { Cut } from '../cut/llm-cuts.js';
import { mapToOutput, type TimeRange } from '../cut/plan.js';

/** 每行显示宽度上限（汉字记 1，英文字母、数字、半角符号记 0.55），提示词与兜底分行都用它 */
export const MAX_LINE_WIDTH = 14;
/** 校验上限：在提示词上限上留 1 的容差 */
export const MAX_DISPLAY_WIDTH = MAX_LINE_WIDTH + 1;
const HALF_WIDTH = 0.55;
const BREAK_GAP = 0.35;
const MIN_CAPTION_SEC = 0.4;

export interface CaptionLine { from: number; to: number; text: string }
export interface TimedCaption { start: number; end: number; text: string }
/** 结构合法时 tooWide 是超宽行在 lines 里的位置；结构不合法时给出原因，供重试提示 */
export type LinesVerdict = { ok: true; lines: CaptionLine[]; tooWide: number[] } | { ok: false; reason: string };

const LinesSchema = z.object({ lines: z.array(z.object({ from: z.number().int(), to: z.number().int(), text: z.string() })) });

/** 显示宽度：ASCII 可见字符与空格记 0.55，其余（汉字、全角符号）记 1；按百分位整数累加避免浮点误差 */
export function displayWidth(text: string): number {
  const units = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) <= 0x7e ? HALF_WIDTH * 100 : 100), 0);
  return Math.round(units) / 100;
}

const isAsciiWord = (text: string): boolean => /^[A-Za-z0-9]+$/.test(text);

export function keptIndices(tokenCount: number, cuts: Cut[]): number[] {
  const removed = new Set(cuts.flatMap((c) => Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from + k)));
  return Array.from({ length: tokenCount }, (_, i) => i).filter((i) => !removed.has(i));
}

/** 行末连续英文/数字 token 的起始位置；没有则返回 group.length */
function trailingWordStart(group: number[], tokens: Token[]): number {
  let k = group.length;
  while (k > 0 && isAsciiWord(tokens[group[k - 1]].text)) k -= 1;
  return k;
}

/** 不依赖模型的兜底分行：遇到停顿或达到宽度上限就换行；不在连续英文/数字 token 之间断开（不拆 GitHub、pdf） */
export function fallbackLines(tokens: Token[], kept: number[], maxWidth = MAX_LINE_WIDTH): CaptionLine[] {
  const groups: number[][] = [];
  let current: number[] = [];
  kept.forEach((idx, k) => {
    const prev = k > 0 ? tokens[kept[k - 1]] : undefined;
    const width = displayWidth(current.map((i) => tokens[i].text).join('') + tokens[idx].text);
    if (prev && tokens[idx].start - prev.end > BREAK_GAP) {
      groups.push(current);
      current = [];
    } else if (current.length > 0 && width > maxWidth) {
      const wordStart = isAsciiWord(tokens[idx].text) ? trailingWordStart(current, tokens) : current.length;
      const at = wordStart > 0 ? wordStart : current.length; // 整行都是英文时只能硬断
      groups.push(current.slice(0, at));
      current = current.slice(at);
    }
    current = [...current, idx];
  });
  groups.push(current);
  return groups.filter((g) => g.length > 0)
    .map((g) => ({ from: g[0], to: g[g.length - 1], text: g.map((i) => tokens[i].text).join('') }));
}

/** 第 i 行的结构问题；没有问题返回 null。行必须按顺序紧接、覆盖全部保留下标（行内可跨过被剪下标） */
function lineProblem(lines: CaptionLine[], i: number, kept: number[], keptSet: Set<number>): string | null {
  const l = lines[i];
  if (!keptSet.has(l.from) || !keptSet.has(l.to)) return `第 ${i + 1} 行的下标 ${l.from}–${l.to} 不是保留下标`;
  if (l.from > l.to) return `第 ${i + 1} 行起始下标大于结束下标`;
  if (l.text.trim().length === 0) return `第 ${i + 1} 行文字为空`;
  const expected = i === 0 ? kept[0] : kept[kept.indexOf(lines[i - 1].to) + 1];
  if (expected === undefined) return `第 ${i + 1} 行多余：上一行已到最后一个保留下标`;
  if (l.from !== expected) return `第 ${i + 1} 行应从下标 ${expected} 开始，实际是 ${l.from}`;
  return null;
}

/** 校验模型分行：结构上要求顺序递增、覆盖全部保留下标；结构合法时再标出显示宽度超过上限的行 */
export function validateLines(raw: unknown, kept: number[]): LinesVerdict {
  const parsed = LinesSchema.safeParse(raw);
  if (!parsed.success || parsed.data.lines.length === 0) return { ok: false, reason: '没有按 {"lines":[...]} 格式输出非空的行列表' };
  const lines = parsed.data.lines;
  const keptSet = new Set(kept);
  const problem = lines.map((_, i) => lineProblem(lines, i, kept, keptSet)).find((p) => p !== null);
  if (problem) return { ok: false, reason: problem };
  const last = kept[kept.length - 1];
  if (lines[lines.length - 1].to !== last) return { ok: false, reason: `最后一行应到下标 ${last} 结束` };
  const trimmed = lines.map((l) => ({ ...l, text: l.text.trim() }));
  const tooWide = trimmed.flatMap((l, i) => (displayWidth(l.text) > MAX_DISPLAY_WIDTH ? [i] : []));
  return { ok: true, lines: trimmed, tooWide };
}

/** 起点落在被剪区域时，吸附到其后第一段保留区间的开头；无可吸附处返回 null */
function snapStart(t: number, keep: TimeRange[]): number | null {
  const direct = mapToOutput(t, keep);
  if (direct !== null) return direct;
  const next = keep.find((r) => r.start > t);
  return next ? mapToOutput(next.start, keep) : null;
}

/** 终点落在被剪区域时，吸附到其前最后一段保留区间的末尾；无可吸附处返回 null */
function snapEnd(t: number, keep: TimeRange[]): number | null {
  const direct = mapToOutput(t, keep);
  if (direct !== null) return direct;
  const prev = [...keep].reverse().find((r) => r.end < t);
  return prev ? mapToOutput(prev.end, keep) : null;
}

export function timeCaptions(lines: CaptionLine[], tokens: Token[], keep: TimeRange[]): TimedCaption[] {
  const timed = lines.flatMap((l) => {
    const start = snapStart(tokens[l.from].start, keep);
    const end = snapEnd(tokens[l.to].end, keep);
    if (start === null || end === null || start >= end) return [];
    return [{ start, end: Math.max(end, start + MIN_CAPTION_SEC), text: l.text }];
  });
  return timed.map((c, i) => {
    const next = timed[i + 1];
    return next && c.end > next.start ? { ...c, end: next.start } : c;
  });
}
