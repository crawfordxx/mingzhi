import { z } from 'zod';
import type { Token } from '../asr/types.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { alignLines, splitWide } from './align.js';
import { displayWidth, fallbackLines, MAX_DISPLAY_WIDTH, MAX_LINE_WIDTH, type CaptionLine } from './lines.js';

export const CAPTION_MODEL = 'google/gemini-3.5-flash';
/** 原稿里至少这么多比例的字要能和字幕对上，否则视为改写过多 */
const MIN_MATCH_RATIO = 0.8;
const PAUSE_GAP = 0.3;

export type CaptionsSource = 'llm' | 'partial' | 'fallback';
export interface PolishResult { lines: CaptionLine[]; source: CaptionsSource; warning?: string }

const SYSTEM_PROMPT = `你是短视频字幕编辑。输入是剪辑后保留的口播识别稿，换行代表说话停顿。识别稿来自语音识别，常有同音错字。
把它分成字幕行并校对：
- 每行一个自然语义单位，按顺序覆盖全部内容，不增不删、不改说法；不要在词语中间断行
- 每行显示宽度不超过 ${MAX_LINE_WIDTH}（汉字记 1，英文字母、数字、空格记 0.55），一般 6～12 个字，宁短勿长
- 改正同音错字（如 geth→GitHub、疯人→帮人），英文专名用正确大小写
- 数量与金额用短视频常见写法（六百五十条→650 条，三点五万→3.5 万；但口语化金额如「五毛一」保持原样）
- 不要标点
只输出 JSON：{"lines":["第一行","第二行"]}`;

const SPLIT_PROMPT = `下面是一组太长的短视频字幕行。把每一行在语义停顿处拆成几行，每行显示宽度不超过 ${MAX_LINE_WIDTH}（汉字记 1，英文字母、数字、空格记 0.55），不要改动、增删任何字，不要在词语中间断开。
只输出 JSON：{"lines":[["第1行拆出的第1段","第1行拆出的第2段"],["第2行拆出的第1段","…"]]}，外层顺序与条数与输入一致。`;

const LinesSchema = z.object({ lines: z.array(z.string().min(1)).min(1) });
const SplitSchema = z.object({ lines: z.array(z.array(z.string().min(1)).min(1)) });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sameChars = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

/** 只列保留的字，不带下标；相邻两字间隔超过 0.3 秒视为停顿并换行 */
function formatPlain(tokens: Token[], kept: number[]): string {
  return kept.map((idx, k) => `${k > 0 && tokens[idx].start - tokens[kept[k - 1]].end > PAUSE_GAP ? '\n' : ''}${tokens[idx].text}`).join('');
}

/** 请模型分行校对；结构不合法时带上原因重试 1 次，仍不合法则抛错 */
async function askLines(client: LlmClient, user: string): Promise<string[]> {
  const ask = (u: string): Promise<unknown> => client.chatJson({ model: CAPTION_MODEL, reasoningEffort: 'low', system: SYSTEM_PROMPT, user: u });
  let parsed = LinesSchema.safeParse(await ask(user));
  if (!parsed.success) parsed = LinesSchema.safeParse(await ask(`${user}\n\n上一次的输出不合格：没有按 {"lines":["…"]} 输出非空的字幕行列表。请重新输出。`));
  if (!parsed.success) throw new Error('字幕校对结果不合法：没有按 {"lines":["…"]} 输出非空的字幕行列表');
  return parsed.data.lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

/** 请模型拆分超宽行；某行的拆分改了字或仍超宽则记为 null，由调用方在行中切开。请求失败不影响整体 */
async function askSplit(client: LlmClient, wide: string[]): Promise<(string[] | null)[]> {
  try {
    const raw = await client.chatJson({ model: CAPTION_MODEL, reasoningEffort: 'low', system: SPLIT_PROMPT, user: JSON.stringify(wide) });
    const parsed = SplitSchema.safeParse(raw);
    if (!parsed.success || parsed.data.lines.length !== wide.length) return wide.map(() => null);
    return parsed.data.lines.map((parts, i) => {
      const trimmed = parts.map((p) => p.trim());
      const ok = sameChars(trimmed.join(''), wide[i]) && trimmed.every((p) => p.length > 0 && displayWidth(p) <= MAX_DISPLAY_WIDTH);
      return ok ? trimmed : null;
    });
  } catch (err) {
    rethrowIfBalance(err);
    return wide.map(() => null);
  }
}

/** 让每行不超宽：超宽行先请模型拆，拆不好的在行中切开；返回新行与被硬切的行数 */
async function fitWidth(client: LlmClient, texts: string[]): Promise<{ texts: string[]; hardSplits: number }> {
  const wideAt = texts.flatMap((t, i) => (displayWidth(t) > MAX_DISPLAY_WIDTH ? [i] : []));
  if (wideAt.length === 0) return { texts, hardSplits: 0 };
  const splits = await askSplit(client, wideAt.map((i) => texts[i]));
  const byLine = new Map(wideAt.map((i, k) => [i, splits[k]]));
  const out = texts.flatMap((t, i) => (byLine.has(i) ? byLine.get(i) ?? splitWide(t, MAX_LINE_WIDTH) : [t]));
  return { texts: out, hardSplits: splits.filter((s) => s === null).length };
}

const fallback = (tokens: Token[], kept: number[], warning: string): PolishResult => ({ lines: fallbackLines(tokens, kept), source: 'fallback', warning });

/** 模型分行校对字幕：模型只给文字，逐字对齐回原稿得到下标；任何一步失败或改写过多则整体退回兜底分行。不打控制台，由调用方展示 warning */
export async function polishCaptions(client: LlmClient, tokens: Token[], kept: number[]): Promise<PolishResult> {
  if (kept.length === 0) return { lines: [], source: 'fallback' };
  try {
    const texts = await askLines(client, formatPlain(tokens, kept));
    const fitted = await fitWidth(client, texts);
    const { lines, matchedRatio } = alignLines(tokens, kept, fitted.texts);
    if (matchedRatio < MIN_MATCH_RATIO) {
      return fallback(tokens, kept, `字幕校对改写过多（只有 ${Math.round(matchedRatio * 100)}% 的字对得上原稿），改用自动分行`);
    }
    if (fitted.hardSplits === 0) return { lines, source: 'llm' };
    return { lines, source: 'partial', warning: `字幕校对：${fitted.hardSplits} 行超宽，已在行中自动切开` };
  } catch (err) {
    rethrowIfBalance(err);
    return fallback(tokens, kept, `字幕校对失败，改用自动分行：${errorText(err)}`);
  }
}
