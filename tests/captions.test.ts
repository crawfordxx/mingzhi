import { describe, expect, it } from 'vitest';
import type { Token } from '../src/asr/types.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { fallbackLines, keptIndices, polishCaptions, timeCaptions, validateLines } from '../src/captions/lines.js';
import { toAss } from '../src/captions/ass.js';

// 用毫秒整数计算再换算成秒，避免 0.4 + 0.2 = 0.6000000000000001 这类浮点误差
const toks = (s: string, gapAt = -1): Token[] => [...s].map((ch, i) => {
  const startMs = i * 200 + (gapAt >= 0 && i >= gapAt ? 1000 : 0);
  return { text: ch, start: startMs / 1000, end: (startMs + 200) / 1000 };
});

describe('keptIndices', () => {
  it('去掉被剪的下标', () => {
    expect(keptIndices(6, [{ from: 1, to: 2, type: 'repeat', reason: '' }])).toEqual([0, 3, 4, 5]);
  });
});

describe('fallbackLines', () => {
  it('按停顿和字数上限分行', () => {
    const tokens = toks('我平时经常逛项目今天看到一个', 8);
    const lines = fallbackLines(tokens, tokens.map((_, i) => i), 6);
    expect(lines.map((l) => l.text)).toEqual(['我平时经常逛', '项目', '今天看到一个']);
    expect(lines[0]).toMatchObject({ from: 0, to: 5 });
  });
});

describe('validateLines', () => {
  const kept = [0, 1, 2, 3, 4, 5];
  it('合法时原样返回', () => {
    const raw = { lines: [{ from: 0, to: 2, text: 'GitHub' }, { from: 3, to: 5, text: '650 条' }] };
    expect(validateLines(raw, kept)).toEqual(raw.lines);
  });
  it('乱序、越界、超长、引用被剪下标时返回 null', () => {
    expect(validateLines({ lines: [{ from: 3, to: 5, text: 'a' }, { from: 0, to: 2, text: 'b' }] }, kept)).toBeNull();
    expect(validateLines({ lines: [{ from: 0, to: 9, text: 'a' }] }, kept)).toBeNull();
    expect(validateLines({ lines: [{ from: 0, to: 5, text: '一二三四五六七八九十一二三四五六七' }] }, kept)).toBeNull();
    expect(validateLines({ lines: [{ from: 0, to: 1, text: 'a' }] }, [0, 2])).toBeNull(); // 下标 1 已被剪掉
  });
});

describe('polishCaptions', () => {
  it('模型结果不合法时退回兜底分行', async () => {
    const tokens = toks('你好世界');
    const client: LlmClient = { chatJson: async () => ({ lines: [{ from: 9, to: 9, text: 'x' }] }) };
    const lines = await polishCaptions(client, tokens, [0, 1, 2, 3]);
    expect(lines.map((l) => l.text)).toEqual(['你好世界']);
  });
});

describe('timeCaptions', () => {
  it('映射到成片时间，跳过被剪掉的行，并消除重叠', () => {
    const tokens = toks('一二三四五六');
    const keep = [{ start: 0, end: 0.6 }, { start: 0.8, end: 1.2 }];
    const out = timeCaptions([{ from: 0, to: 2, text: '一二三' }, { from: 4, to: 5, text: '五六' }], tokens, keep);
    expect(out).toEqual([{ start: 0, end: 0.6, text: '一二三' }, { start: 0.6, end: 1, text: '五六' }]);
  });
});

describe('toAss', () => {
  it('生成带样式与时间的 ASS，并转义花括号', () => {
    const ass = toAss([{ start: 1.5, end: 3.25, text: '怎么{少}花冤枉钱' }], { width: 1080, height: 1920 });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,怎么\\{少\\}花冤枉钱');
  });
});
