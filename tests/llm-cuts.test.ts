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
  it('丢弃越界与倒序，按起点排序并合并重叠，返回丢弃条数', () => {
    const { cuts, dropped } = validateCuts({ cuts: [
      { from: 4, to: 5, type: 'repeat', reason: '重复' },
      { from: 0, to: 0, type: 'filler', reason: '语气词' },
      { from: 5, to: 3, type: 'slip', reason: '倒序' },
      { from: 7, to: 99, type: 'slip', reason: '越界' },
      { from: 5, to: 6, type: 'repeat', reason: '重叠' },
    ] }, tokens);
    expect(cuts).toEqual([
      { from: 0, to: 0, type: 'filler', reason: '语气词' },
      { from: 4, to: 6, type: 'repeat', reason: '重复' },
    ]);
    expect(dropped).toBe(2);
  });

  it('逐项校验：坏项丢弃并计数，好项保留', () => {
    const res = validateCuts({ cuts: [
      { from: 1, to: 1, type: 'filler' },
      { from: 2, to: 2, type: 'unknown', reason: '类型不对' },
      { from: '3', to: 3, type: 'repeat', reason: '下标不是数字' },
      null,
    ] }, tokens);
    expect(res).toEqual({ cuts: [{ from: 1, to: 1, type: 'filler', reason: '' }], dropped: 3 });
  });

  it('text 与下标对应的文字一致时原样采用', () => {
    const { cuts } = validateCuts({ cuts: [{ from: 2, to: 3, text: '去逛', type: 'repeat', reason: '' }] }, tokens);
    expect(cuts.map((c) => [c.from, c.to])).toEqual([[2, 3]]);
  });

  it('下标数错时按 text 在附近重新定位（实测：模型理由说删「直接其实」，下标只框住「其实」）', () => {
    const t = ['成', '本', '直', '接', '其', '实', '直', '接', '放', '在'].map((s, i) => tk(s, i * 0.2));
    const { cuts, dropped } = validateCuts({ cuts: [{ from: 4, to: 5, text: '直接其实', type: 'repeat', reason: '' }] }, t);
    expect(cuts.map((c) => [c.from, c.to])).toEqual([[2, 5]]);
    expect(dropped).toBe(0);
  });

  it('多处同文时取离模型下标最近的一处；英文 token 不区分大小写、忽略空格', () => {
    const t = ['去', '逛', 'AI', '去', '逛', 'AI', '项', '目'].map((s, i) => tk(s, i * 0.2));
    const { cuts } = validateCuts({ cuts: [{ from: 4, to: 6, text: '去逛 ai', type: 'repeat', reason: '' }] }, t);
    expect(cuts.map((c) => [c.from, c.to])).toEqual([[3, 5]]);
  });

  it('附近找不到 text 时丢弃该项并计数', () => {
    const { cuts, dropped } = validateCuts({ cuts: [{ from: 0, to: 0, text: '然后呢', type: 'filler', reason: '' }] }, tokens);
    expect(cuts).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('false_start 后面没有重说（被删的字在随后 8 个字里都没再出现）时丢弃（实测：「得把」被识别成「你把」，模型误删「有人」）', () => {
    const t = [...'缺口有人你把新技术真正带进业务'].map((s, i) => tk(s, i * 0.2));
    const { cuts, dropped } = validateCuts({ cuts: [{ from: 2, to: 3, text: '有人', type: 'false_start', reason: '' }] }, t);
    expect(cuts).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('false_start 后面紧接着重说时保留', () => {
    const t = [...'我们今天我们今天来聊'].map((s, i) => tk(s, i * 0.2));
    const { cuts } = validateCuts({ cuts: [{ from: 0, to: 3, text: '我们今天', type: 'false_start', reason: '' }] }, t);
    expect(cuts.map((c) => [c.from, c.to])).toEqual([[0, 3]]);
  });

  it('cuts 缺失视为没有要剪的；cuts 不是数组时报错', () => {
    expect(validateCuts({}, tokens.slice(0, 3))).toEqual({ cuts: [], dropped: 0 });
    expect(validateCuts(null, tokens.slice(0, 3))).toEqual({ cuts: [], dropped: 0 });
    expect(() => validateCuts({ cuts: 'x' }, tokens.slice(0, 3))).toThrow('剪辑结果格式不对');
  });
});

describe('detectCuts', () => {
  it('调用 gpt-5.6-sol（low）并返回校验后的剪切', async () => {
    const calls: unknown[] = [];
    const client: LlmClient = { chatJson: async (o) => { calls.push(o); return { cuts: [{ from: 0, to: 0, type: 'filler', reason: '嗯' }, { from: 2, to: 3, type: 'repeat', reason: '去逛' }] }; } };
    const { cuts, dropped } = await detectCuts(client, tokens);
    expect(cuts.map((c) => [c.from, c.to])).toEqual([[0, 0], [2, 3]]);
    expect(dropped).toBe(0);
    expect(calls[0]).toMatchObject({ model: 'openai/gpt-5.6-sol', reasoningEffort: 'low' });
  });

  it('提示词说明无需剪时返回空列表，并把整句重录归入 repeat', async () => {
    let system = '';
    const client: LlmClient = { chatJson: async (o) => { system = o.system; return { cuts: [] }; } };
    expect(await detectCuts(client, tokens)).toEqual({ cuts: [], dropped: 0 });
    expect(system).toContain('{"cuts":[]}');
    expect(system).toContain('整句重录：同一句话说了多遍，只保留最后一遍完整的');
  });

  it('提示词要求逐字抄出要删的原文，并提醒识别稿有同音错字、半句放弃必须有重说', async () => {
    let system = '';
    const client: LlmClient = { chatJson: async (o) => { system = o.system; return { cuts: [] }; } };
    await detectCuts(client, tokens);
    expect(system).toContain('"text":"要删的原文"');
    expect(system).toContain('同音错字');
    expect(system).toContain('紧接着重说了同样的内容');
  });

  it('剪掉比例超过 35% 时拒绝（防止误删正文）', async () => {
    const client: LlmClient = { chatJson: async () => ({ cuts: [{ from: 0, to: 5, type: 'slip', reason: '' }] }) };
    await expect(detectCuts(client, tokens)).rejects.toThrow('剪掉比例异常');
  });
});
