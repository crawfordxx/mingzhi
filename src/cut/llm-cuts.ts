import { z } from 'zod';
import type { Token } from '../asr/types.js';
import type { LlmClient } from '../llm/kexiang.js';

export const CUT_MODEL = 'google/gemini-3.5-flash';
export const MAX_CUT_RATIO = 0.35;
const LINE_BREAK_GAP = 0.3;

export const CUT_TYPES = ['filler', 'repeat', 'slip', 'false_start'] as const;
export type CutType = (typeof CUT_TYPES)[number];
export interface Cut { from: number; to: number; type: CutType; reason: string }
/** dropped：模型返回里结构不对或下标越界/倒序而被丢弃的条数 */
export interface CutsResult { cuts: Cut[]; dropped: number }

const CutSchema = z.object({ from: z.number().int(), to: z.number().int(), type: z.enum(CUT_TYPES), reason: z.string().default('') });

const SYSTEM_PROMPT = `你是专业口播剪辑师。输入是逐字识别稿，每个字前的 [n] 是它的下标，换行代表说话停顿。
找出应该删掉的部分，只删这四类：
- filler：无意义的语气词和口头禅（嗯、啊、呃、然后呢、就是说 等，出现在句首或句中停顿处时）
- repeat：结巴式重复，只保留最后一次（如「去逛，去逛」删第一个「去逛」）；整句重录：同一句话说了多遍，只保留最后一遍完整的
- slip：说错后自己更正，删掉错误部分和更正提示词（如「六百，不对，六百五十」删「六百，不对，」）
- false_start：说了半句放弃、随后重说的开头
绝不删除有信息量的正文；拿不准就不删。无需剪时返回 {"cuts":[]}。
只输出 JSON：{"cuts":[{"from":起始下标,"to":结束下标(含),"type":"filler|repeat|slip|false_start","reason":"一句话原因"}]}`;

/** 每个 token 前标下标，只列 indices 里的下标（默认全部）；相邻两项间隔超过 0.3 秒视为停顿并换行，帮助模型理解语气 */
export function formatTokensForLlm(tokens: Token[], indices: number[] = tokens.map((_, i) => i)): string {
  return indices
    .map((idx, k) => {
      const gap = k > 0 ? tokens[idx].start - tokens[indices[k - 1]].end : 0;
      return `${k > 0 && gap > LINE_BREAK_GAP ? '\n' : ''}[${idx}]${tokens[idx].text}`;
    })
    .join('');
}

/** 逐项校验：坏项与越界/倒序项丢弃并计数；cuts 缺失视为 []；按起点排序并合并重叠或相邻的剪切 */
export function validateCuts(raw: unknown, tokenCount: number): CutsResult {
  const items = (raw as { cuts?: unknown } | null)?.cuts ?? [];
  if (!Array.isArray(items)) throw new Error('剪辑结果格式不对：cuts 不是数组');
  const valid = items
    .map((item) => CutSchema.safeParse(item))
    .flatMap((p) => (p.success ? [p.data] : []))
    .filter((c) => c.from >= 0 && c.from <= c.to && c.to < tokenCount)
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
  const result = validateCuts(raw, tokens.length);
  const removed = result.cuts.reduce((n, c) => n + (c.to - c.from + 1), 0);
  if (removed / tokens.length > MAX_CUT_RATIO) {
    throw new Error(`剪掉比例异常（${Math.round((removed / tokens.length) * 100)}%），已停止以免误删正文`);
  }
  return result;
}
