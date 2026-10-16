import { describe, expect, it } from 'vitest';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { DEFAULT_AVOID, fixBeats, measureCoverage } from '../src/broll/plan-check.js';
import { presentIssues, rebalancePresent } from '../src/broll/plan-present.js';
import { BeatSchema, planBeats, PLAN_MODEL, type Beat } from '../src/broll/plan.js';
import type { Storyboard } from '../src/storyboard/schema.js';

const beat = (over: Record<string, unknown> = {}) => ({
  start: 10, end: 13, role: 'illustrate', kind: 'footage', subject: '工程师在客户办公室看屏幕',
  mustShow: ['两人以上'], avoid: ['机器人'], queryEn: ['engineer client office'], queryZh: ['驻场工程师'],
  present: 'split', shotSize: 'MS', motion: 'push-in', ...over,
});
const parsed = (over: Record<string, unknown> = {}): Beat => BeatSchema.parse(beat(over));
/** 自绘图表类：不会被改成 broll-full，用来单测时间修正而不受呈现分布调整影响 */
const chart = (over: Record<string, unknown> = {}): Beat => parsed({ kind: 'chart', queryEn: [], queryZh: [], ...over });

describe('BeatSchema', () => {
  it('接受合法 beat，urlHint 可选', () => {
    expect(BeatSchema.safeParse(beat()).success).toBe(true);
    expect(BeatSchema.safeParse(beat({ urlHint: 'https://example.com/a' })).success).toBe(true);
  });
  it('urlHint 为空串、null 或非法网址时当作没写，不连累整条 beat', () => {
    for (const urlHint of ['', null, 'not a url', 'ftp://a.com/x']) {
      const r = BeatSchema.safeParse(beat({ urlHint }));
      expect(r.success).toBe(true);
      expect(r.success && r.data.urlHint).toBeUndefined();
    }
  });
  it('拒绝非法枚举、实拍类缺搜索词', () => {
    expect(BeatSchema.safeParse(beat({ role: 'x' })).success).toBe(false);
    expect(BeatSchema.safeParse(beat({ queryEn: [] })).success).toBe(false);
    expect(BeatSchema.safeParse(beat({ queryZh: [' '] })).success).toBe(false);
  });
  it('chart、ui 不需要搜索词', () => {
    expect(BeatSchema.safeParse(beat({ kind: 'chart', queryEn: [], queryZh: [] })).success).toBe(true);
    expect(BeatSchema.safeParse(beat({ kind: 'ui', queryEn: [], queryZh: [] })).success).toBe(true);
  });
  it('字段超长时截断而不是丢弃', () => {
    const b = parsed({ subject: '景'.repeat(200), mustShow: ['a'.repeat(100), ' ', 'b', 'c', 'd', 'e', 'f', 'g'], queryZh: ['一', '二', '三', '四'] });
    expect(b.subject).toHaveLength(120);
    expect(b.mustShow[0]).toHaveLength(80);
    expect(b.mustShow).toHaveLength(6);
    expect(b.queryZh).toEqual(['一', '二', '三']);
  });
  it('urlHintUnverified 只能是 true', () => {
    expect(BeatSchema.safeParse(beat({ urlHint: 'https://a.com', urlHintUnverified: false })).success).toBe(false);
  });
});

describe('fixBeats 时间修正', () => {
  it('越界裁到片长内，完全在片外的丢弃', () => {
    const r = fixBeats([chart({ start: 56, end: 62 }), chart({ start: 70, end: 75 })], 60);
    expect(r.beats.map((b) => [b.start, b.end])).toEqual([[56, 60]]);
    expect(r.dropped).toBe(1);
  });
  it('起点为负裁到 0', () => {
    expect(fixBeats([chart({ start: -1, end: 3 })], 60).beats[0].start).toBe(0);
  });
  it('重叠时后一个让位', () => {
    const r = fixBeats([chart({ start: 10, end: 15 }), chart({ start: 12, end: 18 })], 60);
    expect(r.beats.map((b) => [b.start, b.end])).toEqual([[10, 15], [15, 18]]);
  });
  it('让位后短于 1.5 秒的丢弃', () => {
    const r = fixBeats([chart({ start: 10, end: 15 }), chart({ start: 12, end: 16 })], 60);
    expect(r.beats).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });
  it('被前一个完全包含的丢弃', () => {
    const r = fixBeats([chart({ start: 10, end: 20 }), chart({ start: 12, end: 15 })], 60);
    expect(r.beats.map((b) => [b.start, b.end])).toEqual([[10, 18]]);
    expect(r.dropped).toBe(1);
  });
  it('短于 1.5 秒丢弃，恰好 1.5 秒保留', () => {
    const r = fixBeats([chart({ start: 1, end: 2.4 }), chart({ start: 5, end: 6.5 })], 60);
    expect(r.beats.map((b) => b.start)).toEqual([5]);
    expect(r.dropped).toBe(1);
  });
  it('broll-full 超过 3.5 秒截断，其他呈现方式最长 8 秒', () => {
    const r = fixBeats([chart({ start: 0, end: 8, present: 'broll-full' }), chart({ start: 10, end: 30, present: 'split' })], 60);
    expect(r.beats.map((b) => b.end)).toEqual([3.5, 18]);
  });
  it('乱序输入按开始时间排序', () => {
    const r = fixBeats([chart({ start: 20, end: 23 }), chart({ start: 5, end: 8 })], 60);
    expect(r.beats.map((b) => b.start)).toEqual([5, 20]);
  });
  it('不改动入参', () => {
    const input = [chart({ start: 10, end: 20, present: 'broll-full' })];
    fixBeats(input, 60);
    expect(input[0].end).toBe(20);
    expect(input[0].avoid).toEqual(['机器人']);
  });
});

describe('fixBeats 字段清理', () => {
  it('avoid 默认补齐全息、机器人、霓虹、蓝色科技光效且不重复', () => {
    const b = fixBeats([chart({ avoid: ['机器人', '西方面孔特写'] })], 60).beats[0];
    expect(b.avoid).toEqual(['机器人', '西方面孔特写', '全息', '霓虹', '蓝色科技光效']);
    expect(DEFAULT_AVOID).toEqual(['全息', '机器人', '霓虹', '蓝色科技光效']);
  });
  it('urlHint 一律标记未核实，没有 urlHint 的不带标记', () => {
    const [a, b] = fixBeats([chart({ start: 0, end: 3, urlHint: 'https://example.com/careers' }), chart({ start: 5, end: 8 })], 60).beats;
    expect(a).toMatchObject({ urlHint: 'https://example.com/careers', urlHintUnverified: true });
    expect('urlHintUnverified' in b).toBe(false);
    expect('urlHint' in b).toBe(false);
  });
  it('搜索词滤掉 hologram、robot、neon、glowing、全息、机器人、霓虹', () => {
    const b = fixBeats([parsed({ queryEn: ['Robot arm factory', 'factory worker tablet', 'neon city'], queryZh: ['机器人手臂', '车间工人'] })], 60).beats[0];
    expect(b.queryEn).toEqual(['factory worker tablet']);
    expect(b.queryZh).toEqual(['车间工人']);
  });
  it('实拍类英文搜索词被滤光时丢弃；chart 不受影响', () => {
    const r = fixBeats([parsed({ start: 0, end: 3, queryEn: ['hologram display'] }), chart({ start: 5, end: 8, queryEn: ['glowing chart'] })], 60);
    expect(r.beats.map((b) => b.kind)).toEqual(['chart']);
    expect(r.dropped).toBe(1);
  });
});

describe('fixBeats 景别交替', () => {
  const sizes = (shotSizes: string[]) => fixBeats(shotSizes.map((s, i) => chart({ start: i * 5, end: i * 5 + 3, shotSize: s })), 60).beats.map((b) => b.shotSize);
  it('相邻同景别时后一个调到相邻景别', () => {
    expect(sizes(['MS', 'MS'])).toEqual(['MS', 'CU']);
    expect(sizes(['ECU', 'ECU'])).toEqual(['ECU', 'CU']);
    expect(sizes(['WS', 'WS'])).toEqual(['WS', 'MS']);
  });
  it('尽量避开再后一个的景别', () => {
    expect(sizes(['MS', 'MS', 'CU'])).toEqual(['MS', 'WS', 'CU']);
  });
  it('连续三个相同时逐个错开，结果任意相邻都不同', () => {
    const out = sizes(['MS', 'MS', 'MS', 'MS']);
    expect(out.slice(1).every((s, i) => s !== out[i])).toBe(true);
  });
});

describe('呈现方式分布', () => {
  /** 2 分钟片：5 个实拍、2 个截图、1 个图表、2 个情绪照片，全部 split */
  const bundle = (): Beat[] => [
    ...[0, 12, 24, 36, 48].map((s) => parsed({ start: s, end: s + 3, kind: 'footage' })),
    ...[60, 72].map((s) => parsed({ start: s, end: s + 3, kind: 'screenshot', role: 'prove' })),
    chart({ start: 84, end: 87 }),
    ...[96, 108].map((s) => parsed({ start: s, end: s + 3, kind: 'photo', role: 'emote' })),
  ];
  const present = (beats: Beat[]) => beats.map((b) => b.present);

  it('全是 split 时：实拍改 broll-full、截图改 pip，达到 2 分钟 broll-full>=4、pip+overlay>=2、split<=60%', () => {
    const out = rebalancePresent(bundle(), 120);
    expect(present(out).filter((p) => p === 'broll-full')).toHaveLength(4);
    expect(present(out).slice(5, 7)).toEqual(['pip', 'pip']);
    expect(presentIssues(out, 120)).toEqual([]);
  });
  it('已经达标的分布不改动', () => {
    const ok = bundle().map((b, i) => ({ ...b, present: (['broll-full', 'broll-full', 'broll-full', 'broll-full', 'split', 'pip', 'overlay', 'split', 'split', 'split'] as const)[i] }));
    expect(rebalancePresent(ok, 120)).toEqual(ok);
  });
  it('split 超过 60% 时继续改，直到达标', () => {
    const many = Array.from({ length: 10 }, (_, i) => parsed({ start: i * 12, end: i * 12 + 3 }));
    const out = rebalancePresent(many, 120);
    expect(present(out).filter((p) => p === 'split').length).toBeLessThanOrEqual(6);
  });
  it('没有适合的 beat 时不硬改，分布问题如实报告', () => {
    const uis = [0, 10, 20, 30].map((s) => parsed({ start: s, end: s + 3, kind: 'ui', queryEn: [], queryZh: [] }));
    const issues = presentIssues(rebalancePresent(uis, 120), 120);
    expect(issues.some((m) => m.includes('broll-full'))).toBe(true);
  });
  it('fixBeats 对超过 3.5 秒的实拍改成 broll-full 后同样截断', () => {
    const r = fixBeats([parsed({ start: 0, end: 6, kind: 'footage' })], 30);
    expect(r.beats[0]).toMatchObject({ present: 'broll-full', start: 0, end: 3.5 });
  });
  it('不改动入参', () => {
    const input = bundle();
    rebalancePresent(input, 120);
    expect(present(input).every((p) => p === 'split')).toBe(true);
  });
});

describe('measureCoverage 覆盖率与真实画面节奏', () => {
  it('覆盖率 = beats 总时长 / 片长，达 30% 为满足', () => {
    const c = measureCoverage([parsed({ start: 0, end: 18 })], 60);
    expect(c.ratio).toBeCloseTo(0.3);
    expect(c.coverageOk).toBe(true);
    expect(measureCoverage([parsed({ start: 0, end: 17 })], 60).coverageOk).toBe(false);
  });
  it('realRatio 只算实拍、实物、截图', () => {
    const c = measureCoverage([parsed({ start: 0, end: 6 }), chart({ start: 10, end: 16 })], 60);
    expect(c.ratio).toBeCloseTo(0.2);
    expect(c.realRatio).toBeCloseTo(0.1);
  });
  it('真实画面间隔都不超过 15 秒则满足，无缺口', () => {
    const beats = [0, 14, 28, 42].map((s) => parsed({ start: s, end: s + 3 }));
    const c = measureCoverage(beats, 55);
    expect(c.realOk).toBe(true);
    expect(c.realGaps).toEqual([]);
  });
  it('间隔恰好 15 秒不算缺口，超过才算', () => {
    expect(measureCoverage([parsed({ start: 0, end: 3 }), parsed({ start: 18, end: 21 })], 21).realOk).toBe(true);
    expect(measureCoverage([parsed({ start: 0, end: 3 }), parsed({ start: 18.5, end: 21.5 })], 21.5).realGaps).toEqual([{ start: 3, end: 18.5 }]);
  });
  it('chart、ui、generated 不算真实世界画面，缺口按间隔给出', () => {
    const beats = [parsed({ start: 0, end: 3 }), chart({ start: 20, end: 24 }), parsed({ start: 40, end: 43, kind: 'screenshot' })];
    const c = measureCoverage(beats, 55);
    expect(c.realOk).toBe(false);
    expect(c.realGaps).toEqual([{ start: 3, end: 40 }]);
  });
  it('开头和结尾的空白同样算缺口；没有任何真实画面时整片是缺口', () => {
    expect(measureCoverage([parsed({ start: 20, end: 23 })], 60).realGaps).toEqual([{ start: 0, end: 20 }, { start: 23, end: 60 }]);
    expect(measureCoverage([], 40)).toMatchObject({ ratio: 0, coverageOk: false, realOk: false, realGaps: [{ start: 0, end: 40 }] });
  });
  it('返回呈现方式分布与是否达标', () => {
    const c = measureCoverage([parsed({ start: 0, end: 3, present: 'broll-full' }), parsed({ start: 5, end: 8 })], 20);
    expect(c.presentCounts).toEqual({ 'broll-full': 1, split: 1, pip: 0, overlay: 0 });
    expect(c.presentOk).toBe(true);
    expect(measureCoverage([parsed({ start: 0, end: 3 })], 120)).toMatchObject({ presentOk: false });
  });
});

describe('planBeats', () => {
  const captions = [{ start: 0, end: 5, text: '我们把工程师带进业务现场' }, { start: 5, end: 10, text: '需求清单写在合同里' }];
  const storyboard: Storyboard = { shots: [{ start: 0, end: 10, layout: 'full' }] };
  const fake = (...replies: unknown[]) => {
    const calls: Parameters<LlmClient['chatJson']>[0][] = [];
    const client: LlmClient = { chatJson: async (o) => { calls.push(o); const r = replies[Math.min(calls.length - 1, replies.length - 1)]; if (r instanceof Error) throw r; return r; } };
    return { client, calls };
  };

  it('用 gemini-3.5-flash、low，提示词含字幕与关键规则', async () => {
    const { client, calls } = fake({ beats: [beat({ start: 0, end: 4 })] });
    await planBeats(client, captions, storyboard, 10);
    expect(calls[0].model).toBe(PLAN_MODEL);
    expect(PLAN_MODEL).toBe('google/gemini-3.5-flash');
    expect(calls[0].reasoningEffort).toBe('low');
    expect(calls[0].user).toContain('[0.00-5.00] 我们把工程师带进业务现场');
    expect(calls[0].user).toContain('总时长：10.00 秒');
  });
  it('提示词覆盖：具体名词、氛围禁用、景别交替、中英文搜索词、present 分布、urlHint 留空', async () => {
    const { client, calls } = fake({ beats: [beat({ start: 0, end: 4 })] });
    await planBeats(client, captions, storyboard, 10);
    const sys = calls[0].system;
    for (const needle of ['具体名词', '氛围', '全息', '机器人', '霓虹', '蓝色科技光效', '景别交替', 'queryEn', 'queryZh', 'Pexels', 'broll-full', 'pip', 'overlay', '60%', '至少 4 个', '30%', 'urlHint 只有口播里明确提到']) {
      expect(sys, needle).toContain(needle);
    }
  });
  it('丢弃 schema 不合格项并计数，合法项做修正', async () => {
    const { client } = fake({ beats: [beat({ start: 0, end: 4 }), beat({ role: 'bad' }), { foo: 1 }, beat({ start: 8, end: 14, present: 'broll-full' })] });
    const r = await planBeats(client, captions, storyboard, 10);
    expect(r.dropped).toBe(2);
    expect(r.beats.map((b) => [b.start, b.end])).toEqual([[0, 4], [8, 10]]);
    expect(r.attempts).toBe(2); // 4 项里 2 项不合格，超过 30%，触发重试（假模型两次返回相同，保留首次）
  });
  it('达标时只调用一次，并返回覆盖率', async () => {
    const { client, calls } = fake({ beats: [beat({ start: 0, end: 4 })] });
    const r = await planBeats(client, captions, storyboard, 10);
    expect(calls).toHaveLength(1);
    expect(r.coverage).toMatchObject({ coverageOk: true, realOk: true, presentOk: true });
    expect(r.coverage.ratio).toBeCloseTo(0.35);
  });
  it('顶层没有 beats 数组时抛出明确错误', async () => {
    const { client } = fake({ shots: [] });
    await expect(planBeats(client, captions, storyboard, 10)).rejects.toThrow('beats');
  });
  it('首次请求失败直接抛出', async () => {
    const { client } = fake(new Error('网络错误'));
    await expect(planBeats(client, captions, storyboard, 10)).rejects.toThrow('网络错误');
  });
});

describe('planBeats 重试', () => {
  const captions = [{ start: 0, end: 40, text: '一整段口播' }];
  const storyboard: Storyboard = { shots: [{ start: 0, end: 40, layout: 'full' }] };
  const thin = { beats: [beat({ start: 0, end: 2 })] };
  const good = { beats: [0, 7, 14, 21, 28, 35].map((s) => beat({ start: s, end: s + 3 })) };
  const fake = (...replies: unknown[]) => {
    const calls: { user: string }[] = [];
    const client: LlmClient = { chatJson: async (o) => { calls.push(o); const r = replies[calls.length - 1]; if (r instanceof Error) throw r; return r; } };
    return { client, calls };
  };

  it('覆盖率不足：带缺口与覆盖率现值重试，采用更好的一次', async () => {
    const { client, calls } = fake(thin, good);
    const r = await planBeats(client, captions, storyboard, 40);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('只占全片 5%');
    expect(calls[1].user).toContain('2.0-40.0 秒');
    expect(r.attempts).toBe(2);
    expect(r.beats).toHaveLength(6);
    expect(r.coverage.coverageOk).toBe(true);
  });
  it('呈现分布不足的原因也带进重试提示', async () => {
    const { client, calls } = fake({ beats: [beat({ start: 0, end: 3, kind: 'ui', queryEn: [], queryZh: [] })] }, good);
    await planBeats(client, captions, storyboard, 40);
    expect(calls[1].user).toContain('broll-full 只有 0 次');
  });
  it('beats 全丢：带不合格原因重试', async () => {
    const { client, calls } = fake({ beats: [{ foo: 1 }, beat({ role: 'bad' })] }, good);
    const r = await planBeats(client, captions, storyboard, 40);
    expect(calls[1].user).toContain('没有可用的 beat');
    expect(calls[1].user).toContain('第 1 个 beat');
    expect(r.beats).toHaveLength(6);
  });
  it('重试结果更差时保留首次', async () => {
    const { client } = fake(thin, { beats: [] });
    const r = await planBeats(client, captions, storyboard, 40);
    expect(r.attempts).toBe(2);
    expect(r.beats).toHaveLength(1);
  });
  it('重试请求失败：保留首次结果并记录原因', async () => {
    const { client } = fake(thin, new Error('超时'));
    const r = await planBeats(client, captions, storyboard, 40);
    expect(r.beats).toHaveLength(1);
    expect(r.retryError).toBe('超时');
  });
  it('重试遇到余额不足原样抛出', async () => {
    const { client } = fake(thin, new InsufficientBalanceError());
    await expect(planBeats(client, captions, storyboard, 40)).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});
