import { describe, expect, it } from 'vitest';
import type { Token } from '../src/asr/types.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { detectCuts, formatTokensForLlm, validateCuts } from '../src/cut/llm-cuts.js';

const tk = (text: string, start: number): Token => ({ text, start, end: start + 0.2 });
// 12 个字：正常剪 3 个（25%）不触发 35% 的防误删上限
const tokens = ['嗯', '我', '去', '逛', '去', '逛', 'A', 'I', '项', '目', '很', '好'].map((t, i) => tk(t, Math.round(i * 200) / 1000));

describe('formatTokensForLlm', () => {
  it('每个 token 带下标，停顿超过 0.3 秒换行', () => {
    const out = formatTokensForLlm([tk('我', 0), tk('们', 0.2), tk('好', 1.0)]);
    expect(out).toBe('[0]我[1]们\n[2]好');
  });
});

describe('validateCuts', () => {
  it('丢弃越界与倒序，按起点排序并合并重叠', () => {
    const cuts = validateCuts({ cuts: [
      { from: 4, to: 5, type: 'repeat', reason: '重复' },
      { from: 0, to: 0, type: 'filler', reason: '语气词' },
      { from: 5, to: 3, type: 'slip', reason: '倒序' },
      { from: 7, to: 99, type: 'slip', reason: '越界' },
      { from: 5, to: 6, type: 'repeat', reason: '重叠' },
    ] }, tokens.length);
    expect(cuts).toEqual([
      { from: 0, to: 0, type: 'filler', reason: '语气词' },
      { from: 4, to: 6, type: 'repeat', reason: '重复' },
    ]);
  });

  it('结构不对时报错', () => {
    expect(() => validateCuts({ nope: 1 }, 3)).toThrow('剪辑结果格式不对');
  });
});

describe('detectCuts', () => {
  it('调用 gemini-3.5-flash（low）并返回校验后的剪切', async () => {
    const calls: unknown[] = [];
    const client: LlmClient = { chatJson: async (o) => { calls.push(o); return { cuts: [{ from: 0, to: 0, type: 'filler', reason: '嗯' }, { from: 2, to: 3, type: 'repeat', reason: '去逛' }] }; } };
    const cuts = await detectCuts(client, tokens);
    expect(cuts.map((c) => [c.from, c.to])).toEqual([[0, 0], [2, 3]]);
    expect(calls[0]).toMatchObject({ model: 'google/gemini-3.5-flash', reasoningEffort: 'low' });
  });

  it('剪掉比例超过 35% 时拒绝（防止误删正文）', async () => {
    const client: LlmClient = { chatJson: async () => ({ cuts: [{ from: 0, to: 5, type: 'slip', reason: '' }] }) };
    await expect(detectCuts(client, tokens)).rejects.toThrow('剪掉比例异常');
  });
});
