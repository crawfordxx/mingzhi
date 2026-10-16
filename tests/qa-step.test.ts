import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { CANVAS, type Storyboard } from '../src/storyboard/schema.js';
import { FULL_CAPTION_Y } from '../src/captions/styles.js';
import type { HardCheck } from '../src/qa/hard.js';
import type { CardQaEntry } from '../src/qa/visual.js';
import { cardsSummary, captionCentersOf, hardSummary, projectQaSummary, qaSummary, runQaCards, runQaFinal } from '../src/pipeline/qa-step.js';
import { filmSummary, type FilmReport } from '../src/qa/film.js';
import type { ProjectPatch } from '../src/pipeline/project.js';

const score = { layout: 8, hierarchy: 8, motion: 8, brand: 8, notes: '无' };
const REPORT: CardQaEntry[] = [
  { shotIndex: 0, scores: [score], revised: 0, passed: true },
  { shotIndex: 1, scores: [score, score, score], revised: 2, passed: false },
  { shotIndex: 2, scores: [], revised: 0, passed: false, skipped: '预算不足，未检查' },
  { shotIndex: 3, scores: [score, score], revised: 1, passed: true },
];
const hard = (ok: boolean, id: HardCheck['id'] = 'loudness'): HardCheck => ({ id, ok, detail: `${id} 详情` });
const SB: Storyboard = { shots: [{ start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: 'a' } } }, { start: 2, end: 4, layout: 'full' }], bgm: 'tech' };
const llm = {} as LlmClient;
/** n 项指标的整片自检报告：ok 时全部达标，否则最后一项不达标 */
const filmReport = (ok: boolean, n: number): FilmReport => ({
  ok, durationSec: 10, templates: [], skipped: [],
  metrics: Array.from({ length: n }, (_, i) => ({ id: 'coverage' as const, label: `指标${i + 1}`, value: 0, limit: 0, ok: ok || i < n - 1, detail: `详情${i + 1}`, shots: [] })),
});

describe('qa 摘要文案', () => {
  it('cardsSummary：张数、通过、重写次数、跳过', () => {
    expect(cardsSummary(REPORT)).toBe('卡片自检 4 张：通过 2、重写 3 次、跳过 1');
  });
  it('hardSummary：全部通过，或列出未通过项的 id 与详情', () => {
    expect(hardSummary([hard(true), hard(true, 'fps')])).toBe('成片硬检查：全部通过（2/2）');
    expect(hardSummary([hard(true), hard(false, 'fps')])).toBe('成片硬检查 1/2 通过，未通过：fps（fps 详情）');
  });
  it('qaSummary：三行各管各的（卡片自检、成片硬检查、整片自检），项数来自各自的数据；硬检查没跑出结果、整片自检没跑出结果时写明', () => {
    const film = { before: filmReport(false, 7), actions: [], unfixed: [], after: filmReport(true, 8) };
    expect(qaSummary({ cards: REPORT, hard: [hard(true), hard(true, 'fps')] }, film)).toBe('卡片自检 4 张：通过 2、重写 3 次、跳过 1\n成片硬检查：全部通过（2/2）\n整片自检 8/8 达标');
    expect(qaSummary({ cards: [], hard: [] })).toBe('卡片自检 0 张：通过 0、重写 0 次、跳过 0\n成片硬检查未完成\n整片自检未完成');
  });

  it('整片自检以重做后的复测为准；改不了的问题逐条列在下面', () => {
    const f = { before: filmReport(true, 8), actions: [], unfixed: ['撤图后复检不达标：摄影级画面覆盖（19%）'], after: { ...filmReport(false, 8), metrics: [{ id: 'coverage', label: '摄影级画面覆盖', value: 0.19, limit: 0.25, ok: false, detail: '19%', shots: [] }] } } as never;
    expect(qaSummary({ cards: [], hard: [hard(true)] }, f).split('\n').slice(1)).toEqual(['成片硬检查：全部通过（1/1）', '整片自检 0/1 达标，不达标：摄影级画面覆盖（19%）', '  · 撤图后复检不达标：摄影级画面覆盖（19%）']);
  });

  it('项目文件是同一数据源：从 project.json 取的摘要与事件消息、成片硬检查/整片自检的两个函数逐字一致，通过数不再混写', () => {
    const checks = [hard(true), hard(true, 'fps'), hard(false, 'loudness')];
    const film = { before: filmReport(false, 8), actions: [], unfixed: [] };
    const lines = projectQaSummary({ qa: { cards: REPORT, hard: checks }, film }).split('\n');
    expect(lines[1]).toBe(hardSummary(checks));
    expect(lines[2]).toBe(filmSummary(film.before));
    expect(lines[1]).toMatch(/^成片硬检查 2\/3 通过/);
    expect(lines[2]).toMatch(/^整片自检 7\/8 达标/);
  });
  it('captionCentersOf：按分镜里出现的版式取字幕中心（分屏压分界线、全屏用字幕层常量）', () => {
    expect(captionCentersOf(SB)).toEqual([CANVAS.seam, FULL_CAPTION_Y]);
    expect(captionCentersOf({ ...SB, shots: [SB.shots[1]] })).toEqual([FULL_CAPTION_Y]);
  });
});

describe('runQaCards', () => {
  it('用返回的分镜替换并落盘，进度消息为摘要；把 client、workDir、meter 传给自检', async () => {
    const revised: Storyboard = { ...SB, bgm: 'upbeat' };
    const meter = new CostMeter({}, 5);
    const seen: unknown[] = [];
    const calls: { step: string; message: string; patch?: ProjectPatch }[] = [];
    const out = await runQaCards({ llm, workDir: '/w', meter, ffmpeg: 'ff', qaCards: async (o) => { seen.push(o.client, o.workDir, o.meter, o.ffmpeg); return { storyboard: revised, report: REPORT }; } },
      SB, [], (step, message, patch) => { calls.push({ step, message, patch }); return {} as never; });
    expect(out).toEqual({ storyboard: revised, report: REPORT });
    expect(seen).toEqual([llm, '/w', meter, 'ff']);
    expect(calls).toEqual([{ step: 'qa-cards', message: '卡片自检 4 张：通过 2、重写 3 次、跳过 1 · 跳过原因：预算不足，未检查', patch: { storyboard: revised, qa: { cards: REPORT, hard: [] } } }]);
  });
});

describe('runQaCards 出错处理', () => {
  const calls: { step: string; message: string; patch?: ProjectPatch }[] = [];
  const complete = (step: 'qa-cards', message: string, patch?: ProjectPatch): never => { calls.push({ step, message, patch }); return {} as never; };

  it('自检本身抛错：记一条进度、沿用原分镜、报告为空，不让出片失败', async () => {
    calls.length = 0;
    const out = await runQaCards({ llm, workDir: '/w', meter: new CostMeter({}, 5), ffmpeg: 'ff', qaCards: async () => { throw new Error('渲染崩了'); } }, SB, [], complete);
    expect(out).toEqual({ storyboard: SB, report: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe('卡片自检失败，已跳过（成片不受影响）：渲染崩了');
  });

  it('余额不足照常往外抛，不当作自检失败', async () => {
    calls.length = 0;
    await expect(runQaCards({ llm, workDir: '/w', meter: new CostMeter({}, 5), ffmpeg: 'ff', qaCards: async () => { throw new InsufficientBalanceError(); } }, SB, [], complete)).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(calls).toHaveLength(0);
  });

  it('把封面预留 reserveYuan 与 ffmpeg 交给自检', async () => {
    const seen: unknown[] = [];
    await runQaCards({ llm, workDir: '/w', meter: new CostMeter({}, 5), ffmpeg: 'ff', reserveYuan: 1.25, qaCards: async (o) => { seen.push(o.reserveYuan, o.ffmpeg); return { storyboard: SB, report: [] }; } }, SB, [], complete);
    expect(seen).toEqual([1.25, 'ff']);
  });
});

describe('runQaFinal', () => {
  const cfg = loadConfig({});
  const run = async (hardChecks: () => Promise<HardCheck[]>): Promise<{ hard: HardCheck[]; calls: { message: string; patch?: ProjectPatch }[] }> => {
    const calls: { message: string; patch?: ProjectPatch }[] = [];
    const res = await runQaFinal({ cfg, hardChecks: hardChecks as never }, '/w/out.mp4', SB, REPORT, (_s, message, patch) => { calls.push({ message, patch }); return {} as never; });
    return { hard: res, calls };
  };

  it('不通过也不抛错：消息列出未通过项，结果写进 project.qa', async () => {
    const checks = [hard(true), hard(false, 'blackFrames')];
    const { hard: res, calls } = await run(async () => checks);
    expect(res).toEqual(checks);
    expect(calls).toEqual([{ message: '成片硬检查 1/2 通过，未通过：blackFrames（blackFrames 详情）', patch: { qa: { cards: REPORT, hard: checks } } }]);
  });

  it('把成片、字幕中心、调色板与配置交给 hardChecks', async () => {
    let args: unknown[] = [];
    await run((async (...a: unknown[]) => { args = a; return []; }) as never);
    const [video, layout, palette, c] = args as [string, { captionCenters: number[] }, unknown[], unknown];
    expect([video, layout.captionCenters, Array.isArray(palette) && palette.length > 0, c]).toEqual(['/w/out.mp4', [CANVAS.seam, FULL_CAPTION_Y], true, cfg]);
  });

  it('hardChecks 自己出错：进度消息写明、返回空数组，不抛错', async () => {
    const { hard: res, calls } = await run(async () => { throw new Error('ffmpeg 崩了'); });
    expect(res).toEqual([]);
    expect(calls).toEqual([{ message: '成片硬检查失败，已跳过（成片不受影响）：ffmpeg 崩了', patch: { qa: { cards: REPORT, hard: [] } } }]);
  });
});
