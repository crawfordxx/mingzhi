import { describe, expect, it } from 'vitest';
import type { WorkEvent } from '../api';
import { cutCounts, cutTokenSet, qaAverage, reduceLive } from './liveModel';

let seq = 0;
const e = (t: number, step: string, message: string, detail?: WorkEvent['detail']): WorkEvent =>
  ({ seq: ++seq, t, spaceId: 's', version: 1, step, message, ...(detail ? { detail } : {}) });

const events: WorkEvent[] = [
  e(0, 'probe', '540×960 · 0:58'),
  e(1, 'probe', '已花费 ¥0.00', { kind: 'cost', data: { total: 0, budget: 10 } }),
  e(500, 'asr', '识别 10 字', { kind: 'transcript', data: { lines: [{ from: 0, start: 0, end: 1, text: '嗯我们', tokens: ['嗯', '我', '们'] }] } }),
  e(900, 'cuts', '标记 2 处', { kind: 'cut', data: { cuts: [{ from: 0, to: 0, type: 'filler' }, { from: 5, to: 6, type: 'repeat' }] } }),
  e(950, 'plan', '原片 0:58 → 成片 0:51'),
  e(2000, 'matte', '抠像 10%', { kind: 'progress', data: { stage: 'matte', pct: 10 } }),
  e(3000, 'matte', '抠像 60%', { kind: 'progress', data: { stage: 'matte', pct: 60 } }),
  e(4000, 'storyboard', '2 个镜头', {
    kind: 'shot', data: { shots: [{ index: 0, start: 0, end: 20, layout: 'split' }, { index: 1, start: 20, end: 50.5, layout: 'full' }] },
  }),
  e(4100, 'qa-cards', '第 1 镜', { kind: 'qa', data: { phase: 'score', shotIndex: 0, score: { layout: 9, hierarchy: 8, motion: 8.5, brand: 9.5 } } }),
  e(4200, 'cuts', '已花费 ¥0.20', { kind: 'cost', data: { total: 0.2, budget: 10 } }),
];

describe('剪辑直播视图', () => {
  it('步骤一行一个、跑完的打勾带用时，进度取最后一次', () => {
    const v = reduceLive(events.slice(0, 7));
    expect(v.steps.map((s) => s.step)).toEqual(['probe', 'asr', 'cuts', 'plan', 'matte']);
    expect(v.steps.at(-1)).toMatchObject({ state: 'run', pct: 60 });
    expect(v.steps[0]).toMatchObject({ state: 'ok', t1: 500 });
  });

  it('时长、转录、剪掉的词、分镜、自检与花费', () => {
    const v = reduceLive(events);
    expect([v.sourceSec, v.outputSec]).toEqual([58, 50.5]);
    expect(v.transcript).toHaveLength(1);
    expect([...cutTokenSet(v.cuts)]).toEqual([0, 5, 6]);
    expect(cutCounts(v.cuts)).toEqual({ filler: 1, slip: 1 });
    expect(v.shots).toHaveLength(2);
    expect(qaAverage(v.qa)?.layout).toBe(9);
    expect(v.cost).toEqual({ total: 0.2, budget: 10 });
    expect(v.steps.find((s) => s.step === 'cuts')?.message).toBe('标记 2 处'); // 花费事件不改步骤文字
  });

  it('done 收尾、failed 记原因', () => {
    expect(reduceLive([...events, e(9000, 'done', '/x/final.mp4')])).toMatchObject({ status: 'done', t1: 9000 });
    expect(reduceLive([e(0, 'probe', 'a'), e(1, 'failed', '已取消')])).toMatchObject({ status: 'failed', error: '已取消' });
  });
  it('字幕校对完成后带上校对后的字幕行（转录据此显示校对后的文字）', () => {
    const v = reduceLive([...events, e(5000, 'captions', '2 行字幕', { kind: 'captions', data: { lines: [{ from: 1, to: 2, text: '我们' }] } })]);
    expect(v.captions).toEqual([{ from: 1, to: 2, text: '我们' }]);
    expect(reduceLive(events).captions).toEqual([]);
  });
});
