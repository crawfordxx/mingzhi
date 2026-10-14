import type { Token } from '../asr/types.js';
import { formatTokensForLlm } from '../cut/llm-cuts.js';
import type { LlmClient } from '../llm/kexiang.js';
import { fallbackLines, MAX_LINE_WIDTH, validateLines, type CaptionLine, type LinesVerdict } from './lines.js';

export const CAPTION_MODEL = 'google/gemini-3.5-flash';

export type CaptionsSource = 'llm' | 'partial' | 'fallback';
export interface PolishResult { lines: CaptionLine[]; source: CaptionsSource; warning?: string }

const SYSTEM_PROMPT = `你是短视频字幕编辑。输入是剪辑后保留的逐字识别稿，[n] 是下标，换行代表说话停顿。
把它分成字幕行：每行一个自然语义单位，显示宽度不超过 ${MAX_LINE_WIDTH}（汉字记 1，英文字母、数字、空格记 0.55）；行与行按顺序覆盖全部下标，不重叠、不遗漏。
每行的 text 是校对后的显示文字：改正同音错字（如 geth→GitHub、疯人→帮人），英文专名用正确大小写，
数量与金额用短视频常见写法（六百五十条→650 条，三点五万→3.5 万；但口语化金额如「五毛一」保持原样），不要标点。
只输出 JSON：{"lines":[{"from":起始下标,"to":结束下标(含),"text":"显示文字"}]}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function askLines(client: LlmClient, user: string, kept: number[]): Promise<LinesVerdict> {
  const raw = await client.chatJson({ model: CAPTION_MODEL, reasoningEffort: 'low', system: SYSTEM_PROMPT, user });
  return validateLines(raw, kept);
}

/** 逐行挽救：超宽行退回原字，在它自己的下标区间内用兜底分行重切，其余行保留模型结果 */
function salvage(lines: CaptionLine[], tooWide: number[], tokens: Token[], kept: number[]): PolishResult {
  if (tooWide.length === 0) return { lines, source: 'llm' };
  const wide = new Set(tooWide);
  const merged = lines.flatMap((l, i) => (wide.has(i) ? fallbackLines(tokens, kept.filter((k) => k >= l.from && k <= l.to)) : [l]));
  const adopted = lines.length - tooWide.length;
  return {
    lines: merged,
    source: 'partial',
    warning: `字幕校对：${adopted}/${lines.length} 行采用模型结果，${tooWide.length} 行超宽已按原字自动分行`,
  };
}

/** 模型校对字幕：结构不合法时带上原因重试 1 次；仍失败或请求出错则整体退回兜底分行。不打控制台，由调用方展示 warning */
export async function polishCaptions(client: LlmClient, tokens: Token[], kept: number[]): Promise<PolishResult> {
  if (kept.length === 0) return { lines: [], source: 'fallback' };
  const user = formatTokensForLlm(tokens, kept);
  try {
    let verdict = await askLines(client, user, kept);
    if (!verdict.ok) {
      verdict = await askLines(client, `${user}\n\n上一次的输出不合格：${verdict.reason}。请重新输出，严格按顺序覆盖全部下标。`, kept);
    }
    if (verdict.ok) return salvage(verdict.lines, verdict.tooWide, tokens, kept);
    return { lines: fallbackLines(tokens, kept), source: 'fallback', warning: `字幕校对结果不合法（${verdict.reason}），改用自动分行` };
  } catch (err) {
    return { lines: fallbackLines(tokens, kept), source: 'fallback', warning: `字幕校对失败，改用自动分行：${errorText(err)}` };
  }
}
