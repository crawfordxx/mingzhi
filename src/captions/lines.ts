import { z } from 'zod';
import type { Token } from '../asr/types.js';
import type { Cut } from '../cut/llm-cuts.js';
import { mapToOutput, type TimeRange } from '../cut/plan.js';
import type { LlmClient } from '../llm/kexiang.js';

export const MAX_LINE_CHARS = 14;
const MAX_DISPLAY_CHARS = 16;
const BREAK_GAP = 0.35;
const MIN_CAPTION_SEC = 0.4;

export interface CaptionLine { from: number; to: number; text: string }
export interface TimedCaption { start: number; end: number; text: string }

const LinesSchema = z.object({ lines: z.array(z.object({ from: z.number().int(), to: z.number().int(), text: z.string() })) });

const SYSTEM_PROMPT = `你是短视频字幕编辑。输入是剪辑后保留的逐字识别稿，[n] 是下标。
把它分成字幕行：每行一个自然语义单位，不超过 ${MAX_LINE_CHARS} 个汉字；行与行按顺序覆盖全部下标，不重叠、不遗漏。
每行的 text 是校对后的显示文字：改正同音错字（如 geth→GitHub、疯人→帮人），英文专名用正确大小写，
数量与金额用短视频常见写法（六百五十条→650 条，三点五万→3.5 万；但口语化金额如「五毛一」保持原样），不要标点。
只输出 JSON：{"lines":[{"from":起始下标,"to":结束下标(含),"text":"显示文字"}]}`;

export function keptIndices(tokenCount: number, cuts: Cut[]): number[] {
  const removed = new Set(cuts.flatMap((c) => Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from + k)));
  return Array.from({ length: tokenCount }, (_, i) => i).filter((i) => !removed.has(i));
}

/** 不依赖模型的兜底分行：遇到停顿或达到字数上限就换行 */
export function fallbackLines(tokens: Token[], kept: number[], maxChars = MAX_LINE_CHARS): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let current: number[] = [];
  const flush = (): void => {
    if (current.length) lines.push({ from: current[0], to: current[current.length - 1], text: current.map((i) => tokens[i].text).join('') });
    current = [];
  };
  kept.forEach((idx, k) => {
    const prev = k > 0 ? tokens[kept[k - 1]] : undefined;
    const length = current.reduce((n, i) => n + tokens[i].text.length, 0);
    if (prev && (tokens[idx].start - prev.end > BREAK_GAP || length + tokens[idx].text.length > maxChars)) flush();
    current.push(idx);
  });
  flush();
  return lines;
}

/** 校验模型分行：顺序递增、首尾都是保留下标、显示字数不超限；任一不满足返回 null */
export function validateLines(raw: unknown, kept: number[]): CaptionLine[] | null {
  const parsed = LinesSchema.safeParse(raw);
  if (!parsed.success || parsed.data.lines.length === 0) return null;
  const keptSet = new Set(kept);
  const lines = parsed.data.lines;
  const ok = lines.every((l, i) => keptSet.has(l.from) && keptSet.has(l.to) && l.from <= l.to
    && l.text.trim().length > 0 && [...l.text].length <= MAX_DISPLAY_CHARS && (i === 0 || l.from > lines[i - 1].to))
    && coversKept(lines, kept);
  return ok ? lines.map((l) => ({ ...l, text: l.text.trim() })) : null;
}

/** 行必须从第一个保留下标开始、到最后一个结束，且相邻行紧接、不跳过任何保留下标（行内可跨过被剪下标） */
function coversKept(lines: CaptionLine[], kept: number[]): boolean {
  if (lines[0].from !== kept[0] || lines[lines.length - 1].to !== kept[kept.length - 1]) return false;
  return lines.every((l, i) => i === 0 || l.from === kept[kept.indexOf(lines[i - 1].to) + 1]);
}

export async function polishCaptions(client: LlmClient, tokens: Token[], kept: number[]): Promise<CaptionLine[]> {
  if (kept.length === 0) return [];
  const user = kept.map((i) => `[${i}]${tokens[i].text}`).join('');
  try {
    const raw = await client.chatJson({ model: 'google/gemini-3.5-flash', reasoningEffort: 'low', system: SYSTEM_PROMPT, user });
    const lines = validateLines(raw, kept);
    if (lines) return lines;
    console.warn('字幕校对结果不合法，改用自动分行');
  } catch (err) {
    console.warn(`字幕校对失败，改用自动分行：${err instanceof Error ? err.message : String(err)}`);
  }
  return fallbackLines(tokens, kept);
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
