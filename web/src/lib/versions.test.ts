import { describe, expect, it } from 'vitest';
import type { Space, VersionMeta } from '../api';
import { budgetState, changedLabel, failedVersions, firstDone, isFirst, liveVersionOf, shotScore } from './versions';

const v = (n: number, status: VersionMeta['status'], parent?: number, changedShots: number[] = []): VersionMeta =>
  ({ n, status, createdAt: '2026-10-15T00:00:00Z', summary: parent ? '改' : '首个版本', changedShots, costYuan: 0, ...(parent ? { parent } : {}) });
const space = (versions: VersionMeta[], job: Space['job'] = null): Space =>
  ({ id: 's', title: 't', createdAt: '', inputs: ['a.mp4'], versions, settings: { captionStyle: 'blade', budgetYuan: 10, broll: true, maxVideos: 1 }, job, totalCostYuan: 0 });

describe('首版 = 第一个没有父版本且完成的版本（不是 v1）', () => {
  it('v1 取消后重开：v2 是首版，剪辑直播卡跟着 v2', () => {
    const s = space([v(1, 'failed'), v(2, 'done'), v(3, 'done', 2)]);
    expect(isFirst(s.versions[1])).toBe(true);
    expect(isFirst(s.versions[2])).toBe(false);
    expect(firstDone(s)?.n).toBe(2);
    expect(liveVersionOf(s)).toBe(2);
    expect(failedVersions(s).map((x) => x.n)).toEqual([1]);
  });

  it('还没有完成的首版：直播卡跟正在排队或运行的那次；没有任务时跟最后一次尝试', () => {
    expect(liveVersionOf(space([v(1, 'failed')], { state: 'queued', version: 2 }))).toBe(2);
    expect(liveVersionOf(space([v(1, 'failed'), v(2, 'running')], { state: 'running', version: 2 }))).toBe(2);
    expect(liveVersionOf(space([v(1, 'failed'), v(2, 'failed')]))).toBe(2);
    expect(liveVersionOf(space([], { state: 'queued', version: 1 }))).toBe(1);
    expect(liveVersionOf(space([]))).toBeUndefined();
  });

  it('出过首版后，修改版本在跑时直播卡仍是首版', () => {
    expect(liveVersionOf(space([v(1, 'done'), v(2, 'running', 1)], { state: 'running', version: 2 }))).toBe(1);
  });
});

describe('版本卡与预览标题里的「本版改动」文案', () => {
  it('首版写「首版」；没变、部分变、全部变分别说清楚', () => {
    expect(changedLabel(v(2, 'done'), 5)).toBe('首版');
    expect(changedLabel({ ...v(3, 'done', 2), summary: '回退到 v2' }, 5)).toBe('回退到 v2');
    expect(changedLabel(v(3, 'done', 2, []), 5)).toBe('画面没有变化');
    expect(changedLabel(v(3, 'done', 2, [1]), 5)).toBe('改了 1 段');
    expect(changedLabel(v(3, 'done', 2, [0, 1, 2, 3, 4]), 5)).toBe('每段都变了');
  });
});

describe('项目预算提示', () => {
  it('≥ 80% 算接近上限，超过上限另标', () => {
    expect(budgetState(7.9, 10)).toEqual({ ratio: 0.79, near: false, over: false });
    expect(budgetState(8, 10)).toMatchObject({ near: true, over: false });
    expect(budgetState(10.5, 10)).toMatchObject({ near: true, over: true });
    expect(budgetState(0, 0)).toMatchObject({ near: true });
  });
});

describe('本段自检分不按镜头序号跨版本沿用', () => {
  const qa = { layout: 9, hierarchy: 9, motion: 9, brand: 9 };
  const low = { layout: 7, hierarchy: 7, motion: 7, brand: 7 };
  const cards: Record<number, (string | undefined)[]> = { 1: ['A', undefined, 'B', 'C'], 2: ['A', 'C'] }; // v2 删掉了中间两段，C 前移到第 1 段
  const scores: Record<number, Record<number, typeof qa>> = { 1: { 0: qa, 2: low, 3: qa }, 2: {} };
  const of = (n: number, i: number) => shotScore(n, i, [1, 2], (k) => scores[k] ?? {}, (k) => cards[k] ?? []);

  it('本版没打分时，找旧版本里同一张卡的分数', () => {
    expect(of(2, 1)).toBe(9); // C 在 v1 是第 3 段（9 分），不是 v1 第 1 段（全屏，无分）
    expect(of(2, 0)).toBe(9);
  });

  it('本版有分用本版；全屏镜头与没打过分的卡没有分数', () => {
    expect(of(1, 2)).toBe(7);
    expect(of(1, 1)).toBeUndefined();
    expect(shotScore(2, 1, [1, 2], () => ({}), (k) => cards[k] ?? [])).toBeUndefined();
  });
});
