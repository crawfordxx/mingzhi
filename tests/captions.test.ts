import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '../src/asr/types.js';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import { displayWidth, fallbackLines, keptIndices, MAX_DISPLAY_WIDTH, MAX_LINE_WIDTH, timeCaptions, validateLines } from '../src/captions/lines.js';
import { polishCaptions } from '../src/captions/polish.js';
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

describe('displayWidth', () => {
  it('汉字/全角记 1，ASCII 字母数字与半角符号记 0.55', () => {
    expect(displayWidth('我们')).toBe(2);
    expect(displayWidth('GitHub')).toBeCloseTo(3.3, 6);
    expect(displayWidth('650 条')).toBeCloseTo(3.2, 6);
    expect(displayWidth('《好》')).toBe(3);
  });
  it('校验上限由提示词上限加 1 的容差派生', () => {
    expect(MAX_DISPLAY_WIDTH).toBe(MAX_LINE_WIDTH + 1);
  });
});

describe('fallbackLines', () => {
  it('按停顿和字数上限分行', () => {
    const tokens = toks('我平时经常逛项目今天看到一个', 8);
    const lines = fallbackLines(tokens, tokens.map((_, i) => i), 6);
    expect(lines.map((l) => l.text)).toEqual(['我平时经常逛', '项目', '今天看到一个']);
    expect(lines[0]).toMatchObject({ from: 0, to: 5 });
  });
  it('按显示宽度计：英文字母不按 1 个汉字算', () => {
    const tokens = [...'一二三四五六七八九十一二', 'a', 'b', 'c'].map((t, i) => ({ text: t, start: i * 0.2, end: i * 0.2 + 0.2 }));
    expect(fallbackLines(tokens, tokens.map((_, i) => i)).map((l) => l.text)).toEqual(['一二三四五六七八九十一二abc']);
  });
  it('不在连续英文/数字 token 之间断行', () => {
    const mk = (texts: string[]): Token[] => texts.map((t, i) => ({ text: t, start: i * 0.2, end: i * 0.2 + 0.2 }));
    const github = mk([...'一二三四五六七八九十一二', 'Git', 'Hub', '上']); // 12 + 1.65 + 1.65 > 14，断在 Git 之前
    const lines = fallbackLines(github, github.map((_, i) => i));
    expect(lines.map((l) => l.text)).toEqual(['一二三四五六七八九十一二', 'GitHub上']);
    expect(lines[1]).toMatchObject({ from: 12, to: 14 });
    const pdf = mk([...'一二三四五六七八九十一二三', 'p', 'df']); // 13 + 0.55 + 1.1 > 14，断在 p 之前
    expect(fallbackLines(pdf, pdf.map((_, i) => i)).map((l) => l.text)).toEqual(['一二三四五六七八九十一二三', 'pdf']);
  });
});

describe('validateLines', () => {
  const kept = [0, 1, 2, 3, 4, 5];
  it('结构合法时返回各行，超宽行列表为空', () => {
    const raw = { lines: [{ from: 0, to: 2, text: 'GitHub' }, { from: 3, to: 5, text: '650 条' }] };
    expect(validateLines(raw, kept)).toEqual({ ok: true, lines: raw.lines, tooWide: [] });
  });
  it('结构合法但个别行超宽时，标出超宽行的位置', () => {
    const raw = { lines: [{ from: 0, to: 2, text: '一二三四五六七八九十一二三四五六' }, { from: 3, to: 5, text: '好' }] };
    expect(validateLines(raw, kept)).toMatchObject({ ok: true, tooWide: [0] });
    const ascii = { lines: [{ from: 0, to: 5, text: 'a'.repeat(27) }] }; // 27 × 0.55 = 14.85，未超 15
    expect(validateLines(ascii, kept)).toMatchObject({ ok: true, tooWide: [] });
  });
  it('乱序、越界、引用被剪下标时返回不合法及原因', () => {
    expect(validateLines({ lines: [{ from: 3, to: 5, text: 'a' }, { from: 0, to: 2, text: 'b' }] }, kept)).toMatchObject({ ok: false });
    expect(validateLines({ lines: [{ from: 0, to: 9, text: 'a' }] }, kept)).toMatchObject({ ok: false, reason: expect.stringContaining('9') });
    expect(validateLines({ lines: [{ from: 0, to: 1, text: 'a' }] }, [0, 2])).toMatchObject({ ok: false }); // 下标 1 已被剪掉
    expect(validateLines({ nope: 1 }, kept)).toMatchObject({ ok: false });
    expect(validateLines({ lines: [{ from: 0, to: 5, text: 'a' }, { from: 5, to: 5, text: 'b' }] }, kept)).toMatchObject({ ok: false, reason: expect.stringContaining('多余') });
  });
  it('跳过中间的保留下标时返回不合法', () => {
    expect(validateLines({ lines: [{ from: 0, to: 1, text: 'a' }, { from: 4, to: 5, text: 'b' }] }, kept)).toMatchObject({ ok: false, reason: expect.stringContaining('2') });
  });
  it('没有从第一个保留下标开始时返回不合法', () => {
    expect(validateLines({ lines: [{ from: 1, to: 3, text: 'a' }, { from: 4, to: 5, text: 'b' }] }, kept)).toMatchObject({ ok: false });
  });
  it('没有到最后一个保留下标结束时返回不合法', () => {
    expect(validateLines({ lines: [{ from: 0, to: 2, text: 'a' }, { from: 3, to: 4, text: 'b' }] }, kept)).toMatchObject({ ok: false });
  });
  it('一行可以跨过被剪的下标', () => {
    const cutKept = [0, 1, 4, 5];
    const split = { lines: [{ from: 0, to: 1, text: 'a' }, { from: 4, to: 5, text: 'b' }] };
    const whole = { lines: [{ from: 0, to: 5, text: 'ab' }] };
    expect(validateLines(split, cutKept)).toMatchObject({ ok: true, lines: split.lines });
    expect(validateLines(whole, cutKept)).toMatchObject({ ok: true, lines: whole.lines });
  });
});

describe('polishCaptions', () => {
  afterEach(() => vi.restoreAllMocks());
  const scripted = (...replies: unknown[]): { client: LlmClient; calls: ChatOptions[] } => {
    const calls: ChatOptions[] = [];
    const client: LlmClient = { chatJson: async (o) => {
      calls.push(o);
      const r = replies[calls.length - 1];
      if (r instanceof Error) throw r;
      return r;
    } };
    return { client, calls };
  };

  it('全部合法时采用模型结果，source 为 llm；提示词里的宽度上限来自常量', async () => {
    const { client, calls } = scripted({ lines: [{ from: 0, to: 1, text: '你好' }, { from: 2, to: 3, text: '世界' }] });
    const res = await polishCaptions(client, toks('你好世界'), [0, 1, 2, 3]);
    expect(res).toEqual({ lines: [{ from: 0, to: 1, text: '你好' }, { from: 2, to: 3, text: '世界' }], source: 'llm' });
    expect(calls[0].system).toContain(`${MAX_LINE_WIDTH}`);
  });
  it('输入只列保留下标，停顿超过 0.3 秒换行', async () => {
    const { client, calls } = scripted({ lines: [{ from: 0, to: 4, text: '一三四五' }] });
    await polishCaptions(client, toks('一二三四五', 3), [0, 2, 3, 4]);
    expect(calls[0].user).toBe('[0]一[2]三\n[3]四[4]五');
  });
  it('个别行超宽时只把这一行退回原字自动分行，其余行保留，source 为 partial', async () => {
    const tokens = toks('一二三四五六七八九十甲乙丙丁戊己庚好');
    const wide = { from: 0, to: 16, text: '壹贰叁肆伍陆柒捌玖拾甲乙丙丁戊己庚' };
    const { client } = scripted({ lines: [wide, { from: 17, to: 17, text: '好' }] });
    const res = await polishCaptions(client, tokens, tokens.map((_, i) => i));
    expect(res.source).toBe('partial');
    expect(res.lines.map((l) => l.text)).toEqual(['一二三四五六七八九十甲乙丙丁', '戊己庚', '好']);
    expect(res.warning).toContain('1/2 行采用模型结果');
  });
  it('结构不合法时带上原因重试 1 次，重试成功则采用', async () => {
    const good = { lines: [{ from: 0, to: 3, text: '你好世界' }] };
    const { client, calls } = scripted({ lines: [{ from: 0, to: 1, text: '你好' }] }, good);
    const res = await polishCaptions(client, toks('你好世界'), [0, 1, 2, 3]);
    expect(res.source).toBe('llm');
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('上一次的输出不合格');
  });
  it('重试后仍不合法时整体兜底，不打控制台', async () => {
    const warn = vi.spyOn(console, 'warn');
    const bad = { lines: [{ from: 9, to: 9, text: 'x' }] };
    const { client, calls } = scripted(bad, bad);
    const res = await polishCaptions(client, toks('你好世界'), [0, 1, 2, 3]);
    expect(res.lines.map((l) => l.text)).toEqual(['你好世界']);
    expect(res.source).toBe('fallback');
    expect(res.warning).toContain('字幕校对结果不合法');
    expect(calls).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });
  it('模型请求失败时兜底并给出原因', async () => {
    const { client } = scripted(new Error('超时'));
    const res = await polishCaptions(client, toks('你好世界'), [0, 1, 2, 3]);
    expect(res).toMatchObject({ source: 'fallback', warning: '字幕校对失败，改用自动分行：超时' });
    expect(res.lines.map((l) => l.text)).toEqual(['你好世界']);
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
