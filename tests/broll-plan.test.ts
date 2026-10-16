import { describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/llm/kexiang.js';
import { DEFAULT_AVOID, fixBeats, measureCoverage } from '../src/broll/plan-check.js';
import { BeatSchema, planBeats, PLAN_MODEL, type Beat } from '../src/broll/plan.js';
import type { Storyboard } from '../src/storyboard/schema.js';

const beat = (over: Record<string, unknown> = {}) => ({
  start: 10, end: 13, role: 'illustrate', kind: 'footage', subject: '工程师在客户办公室看屏幕',
  mustShow: ['两人以上'], avoid: ['机器人'], queryEn: ['engineer client office'], queryZh: ['驻场工程师'],
  present: 'split', shotSize: 'MS', motion: 'push-in', ...over,
});
const parsed = (over: Record<string, unknown> = {}): Beat => BeatSchema.parse(beat(over));

describe('BeatSchema', () => {
  it('接受合法 beat，urlHint 可选', () => {
    expect(BeatSchema.safeParse(beat()).success).toBe(true);
    expect(BeatSchema.safeParse(beat({ urlHint: 'https://example.com/a' })).success).toBe(true);
  });
  it('拒绝非法枚举、空搜索词、过多搜索词', () => {
    expect(BeatSchema.safeParse(beat({ role: 'x' })).success).toBe(false);
    expect(BeatSchema.safeParse(beat({ queryEn: [] })).success).toBe(false);
    expect(BeatSchema.safeParse(beat({ queryZh: ['a', 'b', 'c', 'd'] })).success).toBe(false);
    expect(BeatSchema.safeParse(beat({ urlHint: 'not a url' })).success).toBe(false);
  });
});

describe('fixBeats 修正', () => {
  it('越界裁到片长内，完全在片外的丢弃', () => {
    const r = fixBeats([parsed({ start: 56, end: 62, present: 'split' }), parsed({ start: 70, end: 75 })], 60);
    expect(r.beats.map((b) => [b.start, b.end])).toEqual([[56, 60]]);
    expect(r.dropped).toBe(1);
  });
  it('起点为负裁到 0', () => {
    expect(fixBeats([parsed({ start: -1, end: 3 })], 60).beats[0].start).toBe(0);
  });
  it('重叠时后一个让位', () => {
    const r = fixBeats([parsed({ start: 10, end: 15 }), parsed({ start: 12, end: 18 })], 60);
    expect(r.beats.map((b) => [b.start, b.end])).toEqual([[10, 15], [15, 18]]);
  });
  it('让位后短于 1.5 秒的丢弃', () => {
    const r = fixBeats([parsed({ start: 10, end: 15 }), parsed({ start: 12, end: 16 })], 60);
    expect(r.beats).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });
  it('短于 1.5 秒丢弃，恰好 1.5 秒保留', () => {
    const r = fixBeats([parsed({ start: 1, end: 2.4 }), parsed({ start: 5, end: 6.5 })], 60);
    expect(r.beats.map((b) => b.start)).toEqual([5]);
    expect(r.dropped).toBe(1);
  });
  it('broll-full 超过 3.5 秒截断，其他呈现方式不截', () => {
    const r = fixBeats([parsed({ start: 0, end: 8, present: 'broll-full' }), parsed({ start: 10, end: 18, present: 'split' })], 60);
    expect(r.beats.map((b) => b.end)).toEqual([3.5, 18]);
  });
  it('乱序输入按开始时间排序', () => {
    const r = fixBeats([parsed({ start: 20, end: 23 }), parsed({ start: 5, end: 8 })], 60);
    expect(r.beats.map((b) => b.start)).toEqual([5, 20]);
  });
  it('avoid 默认补齐全息、机器人、霓虹、蓝色科技光效且不重复', () => {
    const b = fixBeats([parsed({ avoid: ['机器人', '西方面孔特写'] })], 60).beats[0];
    expect(b.avoid).toEqual(['机器人', '西方面孔特写', '全息', '霓虹', '蓝色科技光效']);
    expect(DEFAULT_AVOID).toEqual(['全息', '机器人', '霓虹', '蓝色科技光效']);
  });
  it('不改动入参', () => {
    const input = [parsed({ start: 10, end: 20, present: 'broll-full' })];
    fixBeats(input, 60);
    expect(input[0].end).toBe(20);
    expect(input[0].avoid).toEqual(['机器人']);
  });
});

describe('measureCoverage 覆盖率与真实画面节奏', () => {
  it('覆盖率 = beats 总时长 / 片长，达 30% 为满足', () => {
    const c = measureCoverage([parsed({ start: 0, end: 18 })], 60);
    expect(c.ratio).toBeCloseTo(0.3);
    expect(c.coverageOk).toBe(true);
    expect(measureCoverage([parsed({ start: 0, end: 17 })], 60).coverageOk).toBe(false);
  });
  it('真实画面间隔都不超过 15 秒则满足，无缺口', () => {
    const beats = [0, 14, 28, 42].map((s) => parsed({ start: s, end: s + 3 }));
    const c = measureCoverage(beats, 55);
    expect(c.realOk).toBe(true);
    expect(c.realGaps).toEqual([]);
  });
  it('chart、ui、generated 不算真实世界画面，缺口按间隔给出', () => {
    const beats = [parsed({ start: 0, end: 3 }), parsed({ start: 20, end: 24, kind: 'chart' }), parsed({ start: 40, end: 43, kind: 'screenshot' })];
    const c = measureCoverage(beats, 55);
    expect(c.realOk).toBe(false);
    expect(c.realGaps).toEqual([{ start: 3, end: 40 }]);
  });
  it('开头和结尾的空白同样算缺口；没有任何真实画面时整片是缺口', () => {
    expect(measureCoverage([parsed({ start: 20, end: 23 })], 60).realGaps).toEqual([{ start: 0, end: 20 }, { start: 23, end: 60 }]);
    expect(measureCoverage([], 40)).toMatchObject({ ratio: 0, coverageOk: false, realOk: false, realGaps: [{ start: 0, end: 40 }] });
  });
});

describe('planBeats', () => {
  const captions = [{ start: 0, end: 5, text: '我们把工程师带进业务现场' }, { start: 5, end: 10, text: '需求清单写在合同里' }];
  const storyboard: Storyboard = { shots: [{ start: 0, end: 10, layout: 'full' }] };
  const fake = (reply: unknown) => {
    const calls: Parameters<LlmClient['chatJson']>[0][] = [];
    const client: LlmClient = { chatJson: async (o) => { calls.push(o); return reply; } };
    return { client, calls };
  };

  it('用 gemini-3.5-flash、low，提示词含字幕与关键规则', async () => {
    const { client, calls } = fake({ beats: [beat({ start: 0, end: 4 })] });
    await planBeats(client, captions, storyboard, 10);
    expect(calls[0].model).toBe(PLAN_MODEL);
    expect(PLAN_MODEL).toBe('google/gemini-3.5-flash');
    expect(calls[0].reasoningEffort).toBe('low');
    expect(calls[0].user).toContain('[0.00-5.00] 我们把工程师带进业务现场');
    expect(calls[0].system).toContain('具体名词');
    expect(calls[0].system).toContain('全息');
  });
  it('丢弃 schema 不合格项并计数，合法项做修正', async () => {
    const { client } = fake({ beats: [beat({ start: 0, end: 4 }), beat({ role: 'bad' }), { foo: 1 }, beat({ start: 8, end: 14, present: 'broll-full' })] });
    const r = await planBeats(client, captions, storyboard, 10);
    expect(r.dropped).toBe(2);
    expect(r.beats.map((b) => [b.start, b.end])).toEqual([[0, 4], [8, 10]]);
  });
  it('合并修正阶段与 schema 阶段的丢弃数，并返回覆盖率', async () => {
    const { client } = fake({ beats: [beat({ start: 0, end: 4 }), beat({ start: 4, end: 5 }), beat({ role: 'bad' })] });
    const r = await planBeats(client, captions, storyboard, 10);
    expect(r.dropped).toBe(2);
    expect(r.coverage.ratio).toBeCloseTo(0.4);
    expect(r.coverage.coverageOk).toBe(true);
    expect(r.coverage.realGaps).toEqual([]);
  });
  it('顶层没有 beats 数组时抛出明确错误', async () => {
    const { client } = fake({ shots: [] });
    await expect(planBeats(client, captions, storyboard, 10)).rejects.toThrow('beats');
  });
  it('请求失败直接抛出', async () => {
    const client: LlmClient = { chatJson: async () => { throw new Error('网络错误'); } };
    await expect(planBeats(client, captions, storyboard, 10)).rejects.toThrow('网络错误');
  });
});
