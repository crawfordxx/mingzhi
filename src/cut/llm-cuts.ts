import { z } from 'zod';
import type { Token } from '../asr/types.js';
import type { LlmClient } from '../llm/kexiang.js';

export const CUT_MODEL = 'google/gemini-3.5-flash';
export const MAX_CUT_RATIO = 0.35;
const LINE_BREAK_GAP = 0.3;
/** 模型下标与 text 对不上时，在模型下标前后这么多个 token 内按文字重新定位 */
const ANCHOR_WINDOW = 20;
/** false_start 必须在随后这么多个 token 内重说（被删的字再次出现），否则视为误判 */
const RESTATE_WINDOW = 8;

export const CUT_TYPES = ['filler', 'repeat', 'slip', 'false_start'] as const;
export type CutType = (typeof CUT_TYPES)[number];
export interface Cut { from: number; to: number; type: CutType; reason: string }
/** dropped：模型返回里结构不对、下标越界/倒序、或 text 在附近找不到而被丢弃的条数 */
export interface CutsResult { cuts: Cut[]; dropped: number }

const CutSchema = z.object({ from: z.number().int(), to: z.number().int(), text: z.string().optional(), type: z.enum(CUT_TYPES), reason: z.string().default('') });
type RawCut = z.infer<typeof CutSchema>;

const SYSTEM_PROMPT = `你是专业口播剪辑师。输入是逐字识别稿，每个字前的 [n] 是它的下标，换行代表说话停顿。
识别稿来自语音识别，常有同音错字（如把「得把」识别成「你把」），读起来别扭不等于说错了，不能据此删除。
找出应该删掉的部分，只删这四类：
- filler：无意义的语气词和口头禅（嗯、啊、呃、然后呢、就是说 等，出现在句首或句中停顿处时）
- repeat：结巴式重复，只保留最后一次（如「去逛，去逛」删第一个「去逛」）；重说时插了新词，只删前面多出来的那次（如「大家可以试，自己动手试一下」删第一个「试」）；整句重录：同一句话说了多遍，只保留最后一遍完整的
- slip：说错后自己更正，删掉错误部分和更正提示词（如「六百，不对，六百五十」删「六百，不对，」）
- false_start：说了半句放弃、并且紧接着重说了同样的内容，删掉放弃的那半句；后面没有重说的不算
删完后整句要通顺、意思完整；绝不删除有信息量的正文；拿不准就不删。无需剪时返回 {"cuts":[]}。
每项的 text 必须逐字抄出 from 到 to 这段原文（不含下标），用来核对下标。
只输出 JSON：{"cuts":[{"from":起始下标,"to":结束下标(含),"text":"要删的原文","type":"filler|repeat|slip|false_start","reason":"一句话原因"}]}`;

/** 每个 token 前标下标，只列 indices 里的下标（默认全部）；相邻两项间隔超过 0.3 秒视为停顿并换行，帮助模型理解语气 */
export function formatTokensForLlm(tokens: Token[], indices: number[] = tokens.map((_, i) => i)): string {
  return indices
    .map((idx, k) => {
      const gap = k > 0 ? tokens[idx].start - tokens[indices[k - 1]].end : 0;
      return `${k > 0 && gap > LINE_BREAK_GAP ? '\n' : ''}[${idx}]${tokens[idx].text}`;
    })
    .join('');
}

const norm = (text: string): string => text.replace(/\s+/g, '').toLowerCase();
const spanText = (tokens: Token[], from: number, to: number): string => tokens.slice(from, to + 1).map((t) => t.text).join('');

/** 在下标 around 前后 ANCHOR_WINDOW 内找文字恰好等于 text 的连续 token 区间（忽略空格与大小写），取起点离 around 最近的；找不到返回 null */
export function anchorText(tokens: Token[], text: string, around: number): { from: number; to: number } | null {
  const target = norm(text);
  if (!target) return null;
  const hits: { from: number; to: number }[] = [];
  for (let i = Math.max(0, around - ANCHOR_WINDOW); i <= Math.min(tokens.length - 1, around + ANCHOR_WINDOW); i += 1) {
    let acc = '';
    for (let j = i; j < tokens.length && acc.length < target.length; j += 1) {
      acc += norm(tokens[j].text);
      if (acc === target) hits.push({ from: i, to: j });
    }
  }
  return [...hits].sort((a, b) => Math.abs(a.from - around) - Math.abs(b.from - around))[0] ?? null;
}

/** 确定一项剪切的下标：没给 text 时只认合法下标；给了 text 且与下标文字一致时原样采用，否则按 text 在附近重新定位 */
function locate(c: RawCut, tokens: Token[]): { from: number; to: number } | null {
  const inRange = c.from >= 0 && c.from <= c.to && c.to < tokens.length;
  if (c.text === undefined) return inRange ? { from: c.from, to: c.to } : null;
  if (inRange && norm(spanText(tokens, c.from, c.to)) === norm(c.text)) return { from: c.from, to: c.to };
  return anchorText(tokens, c.text, Math.min(Math.max(c.from, 0), tokens.length - 1));
}

/** 半句放弃之后必须重说：被删的字至少有一个在随后 RESTATE_WINDOW 个 token 内再次出现。
 * 识别稿的同音错字会让正常的话看起来像说了一半（实测「有人得把」识别成「有人你把」），没有重说就不删 */
function restated(tokens: Token[], from: number, to: number): boolean {
  const removed = new Set(norm(spanText(tokens, from, to)));
  const after = norm(spanText(tokens, to + 1, to + RESTATE_WINDOW));
  return [...after].some((ch) => removed.has(ch));
}

/** 逐项校验：坏项、越界/倒序项、text 对不上的项、没有重说的 false_start 丢弃并计数；cuts 缺失视为 []；按起点排序并合并重叠或相邻的剪切 */
export function validateCuts(raw: unknown, tokens: Token[]): CutsResult {
  const items = (raw as { cuts?: unknown } | null)?.cuts ?? [];
  if (!Array.isArray(items)) throw new Error('剪辑结果格式不对：cuts 不是数组');
  const valid = items
    .map((item) => CutSchema.safeParse(item))
    .flatMap((p) => (p.success ? [p.data] : []))
    .flatMap((c): Cut[] => {
      const at = locate(c, tokens);
      if (!at || (c.type === 'false_start' && !restated(tokens, at.from, at.to))) return [];
      return [{ ...at, type: c.type, reason: c.reason }];
    })
    .sort((a, b) => a.from - b.from);
  const cuts = valid.reduce<Cut[]>((acc, c) => {
    const last = acc[acc.length - 1];
    if (last && c.from <= last.to + 1) return [...acc.slice(0, -1), { ...last, to: Math.max(last.to, c.to) }];
    return [...acc, { ...c }];
  }, []);
  return { cuts, dropped: items.length - valid.length };
}

export async function detectCuts(client: LlmClient, tokens: Token[]): Promise<CutsResult> {
  if (tokens.length === 0) return { cuts: [], dropped: 0 };
  const raw = await client.chatJson({ model: CUT_MODEL, reasoningEffort: 'low', system: SYSTEM_PROMPT, user: formatTokensForLlm(tokens) });
  const result = validateCuts(raw, tokens);
  const removed = result.cuts.reduce((n, c) => n + (c.to - c.from + 1), 0);
  if (removed / tokens.length > MAX_CUT_RATIO) {
    throw new Error(`剪掉比例异常（${Math.round((removed / tokens.length) * 100)}%），已停止以免误删正文`);
  }
  return result;
}
