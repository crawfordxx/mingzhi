import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { CANVAS, type Storyboard } from '../src/storyboard/schema.js';
import { FULL_CAPTION_Y } from '../src/captions/styles.js';
import type { HardCheck } from '../src/qa/hard.js';
import type { CardQaEntry } from '../src/qa/visual.js';
import { cardsSummary, captionCentersOf, hardSummary, qaSummary, runQaCards, runQaFinal } from '../src/pipeline/qa-step.js';
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

describe('qa 摘要文案', () => {
  it('cardsSummary：张数、通过、重写次数、跳过', () => {
    expect(cardsSummary(REPORT)).toBe('卡片自检 4 张：通过 2、重写 3 次、跳过 1');
  });
  it('hardSummary：全部通过，或列出未通过项的 id 与详情', () => {
    expect(hardSummary([hard(true), hard(true, 'fps')])).toBe('成片检查：全部通过（2/2）');
    expect(hardSummary([hard(true), hard(false, 'fps')])).toBe('成片检查 1/2 通过，未通过：fps（fps 详情）');
  });
  it('qaSummary：CLI 一行摘要；成片检查没跑出结果时写明', () => {
    expect(qaSummary({ cards: REPORT, hard: [hard(true), hard(true, 'fps')] })).toBe('卡片自检 4 张：通过 2、重写 3 次、跳过 1 · 成片检查 2/2 通过');
    expect(qaSummary({ cards: [], hard: [] })).toBe('卡片自检 0 张：通过 0、重写 0 次、跳过 0 · 成片检查未完成');
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
    const out = await runQaCards({ llm, workDir: '/w', meter, qaCards: async (o) => { seen.push(o.client, o.workDir, o.meter); return { storyboard: revised, report: REPORT }; } },
      SB, [], (step, message, patch) => { calls.push({ step, message, patch }); return {} as never; });
    expect(out).toEqual({ storyboard: revised, report: REPORT });
    expect(seen).toEqual([llm, '/w', meter]);
    expect(calls).toEqual([{ step: 'qa-cards', message: '卡片自检 4 张：通过 2、重写 3 次、跳过 1 · 跳过原因：预算不足，未检查', patch: { storyboard: revised, qa: { cards: REPORT, hard: [] } } }]);
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
    expect(calls).toEqual([{ message: '成片检查 1/2 通过，未通过：blackFrames（blackFrames 详情）', patch: { qa: { cards: REPORT, hard: checks } } }]);
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
    expect(calls).toEqual([{ message: '成片检查失败，已跳过（成片不受影响）：ffmpeg 崩了', patch: { qa: { cards: REPORT, hard: [] } } }]);
  });
});
