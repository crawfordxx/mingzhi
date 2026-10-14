import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('跳过中间的保留下标时返回 null', () => {
    expect(validateLines({ lines: [{ from: 0, to: 1, text: 'a' }, { from: 4, to: 5, text: 'b' }] }, kept)).toBeNull();
  });
  it('没有从第一个保留下标开始时返回 null', () => {
    expect(validateLines({ lines: [{ from: 1, to: 3, text: 'a' }, { from: 4, to: 5, text: 'b' }] }, kept)).toBeNull();
  });
  it('没有到最后一个保留下标结束时返回 null', () => {
    expect(validateLines({ lines: [{ from: 0, to: 2, text: 'a' }, { from: 3, to: 4, text: 'b' }] }, kept)).toBeNull();
  });
  it('一行可以跨过被剪的下标', () => {
    const cutKept = [0, 1, 4, 5];
    const split = { lines: [{ from: 0, to: 1, text: 'a' }, { from: 4, to: 5, text: 'b' }] };
    const whole = { lines: [{ from: 0, to: 5, text: 'ab' }] };
    expect(validateLines(split, cutKept)).toEqual(split.lines);
    expect(validateLines(whole, cutKept)).toEqual(whole.lines);
  });
});

describe('polishCaptions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('模型结果不合法时告警并退回兜底分行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tokens = toks('你好世界');
    const client: LlmClient = { chatJson: async () => ({ lines: [{ from: 9, to: 9, text: 'x' }] }) };
    const lines = await polishCaptions(client, tokens, [0, 1, 2, 3]);
    expect(lines.map((l) => l.text)).toEqual(['你好世界']);
    expect(warn).toHaveBeenCalledWith('字幕校对结果不合法，改用自动分行');
  });
  it('模型请求失败时告警并退回兜底分行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tokens = toks('你好世界');
    const client: LlmClient = { chatJson: async () => { throw new Error('超时'); } };
    const lines = await polishCaptions(client, tokens, [0, 1, 2, 3]);
    expect(lines.map((l) => l.text)).toEqual(['你好世界']);
    expect(warn).toHaveBeenCalledWith('字幕校对失败，改用自动分行：超时');
  });
});

describe('timeCaptions', () => {
  it('映射到成片时间，跳过被剪掉的行，并消除重叠', () => {
    const tokens = toks('一二三四五六');
    const keep = [{ start: 0, end: 0.6 }, { start: 0.8, end: 1.2 }];
    const out = timeCaptions([{ from: 0, to: 2, text: '一二三' }, { from: 4, to: 5, text: '五六' }], tokens, keep);
    expect(out).toEqual([{ start: 0, end: 0.6, text: '一二三' }, { start: 0.6, end: 1, text: '五六' }]);
  });
  it('起点落在被剪区域时吸附到其后保留区间的开头', () => {
    const tokens = toks('一二三四五六');
    const keep = [{ start: 0, end: 0.5 }, { start: 0.8, end: 1.2 }];
    // 第 3 个字起点 0.6 落在 (0.5, 0.8) 的剪切区内
    const out = timeCaptions([{ from: 3, to: 5, text: '四五六' }], tokens, keep);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBeCloseTo(0.5, 6);
    expect(out[0].end).toBeCloseTo(0.9, 6);
    expect(out[0].text).toBe('四五六');
  });
  it('整段都在被剪区域内的行被丢弃', () => {
    const tokens = toks('一二三四五六');
    const keep = [{ start: 0, end: 0.2 }, { start: 1, end: 1.2 }];
    expect(timeCaptions([{ from: 2, to: 3, text: '三四' }], tokens, keep)).toEqual([]);
  });
  it('不足最短时长的行延长到 MIN_CAPTION_SEC，并在下一行开始时截断重叠', () => {
    const tokens = toks('一二三四五六');
    const keep = [{ start: 0, end: 1.2 }];
    const out = timeCaptions([{ from: 0, to: 0, text: '一' }, { from: 1, to: 1, text: '二' }], tokens, keep);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: '一' });
    expect(out[0].start).toBeCloseTo(0, 6);
    expect(out[0].end).toBeCloseTo(0.2, 6); // 原本延长到 0.4，但被下一行 0.2 截断
    expect(out[1]).toMatchObject({ text: '二' });
    expect(out[1].start).toBeCloseTo(0.2, 6);
    expect(out[1].end).toBeCloseTo(0.6, 6); // 0.2 + 0.4
  });
  it('单独的一行延长到最短时长', () => {
    const tokens = toks('一二三四五六');
    const out = timeCaptions([{ from: 0, to: 0, text: '一' }], tokens, [{ start: 0, end: 1.2 }]);
    expect(out[0].end).toBeCloseTo(0.4, 6);
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
