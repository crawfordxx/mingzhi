import { describe, expect, it } from 'vitest';
import { normalizeStoryboard as normalizeRaw } from '../src/storyboard/normalize.js';

/** 时间轴不变量：从 0 开始、首尾相接、无零长镜头、结束于片长 */
const normalizeStoryboard = (raw: unknown, durationSec: number) => {
  const result = normalizeRaw(raw, durationSec, []);
  const shots = result.storyboard.shots;
  expect(shots[0].start).toBe(0);
  shots.forEach((s, i) => {
    expect(s.end).toBeGreaterThan(s.start);
    if (i > 0) expect(s.start).toBe(shots[i - 1].end);
  });
  expect(shots[shots.length - 1].end).toBe(durationSec);
  return result;
};

const title = (t: string) => ({ template: 'title', props: { title: t } });
const cta = { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } };
const rows = (shots: { start: number; end: number; layout: string; card?: { template: string; props: unknown } }[]) =>
  shots.map((s) => [s.start, s.end, s.layout, s.card ? (s.card.props as { title?: string }).title ?? s.card.template : null]);

describe('normalizeStoryboard：两张卡片之间的短空隙不闪全屏', () => {
  it('卡片 0–7.8、卡片 8.1–12：空隙并入后一张卡片（起点提前），中间没有全屏镜头', () => {
    const raw = { shots: [
      { start: 0, end: 7.8, layout: 'split', card: title('A') },
      { start: 8.1, end: 12, layout: 'split', card: title('B') },
    ] };
    const { storyboard, demoted } = normalizeStoryboard(raw, 12);
    expect(rows(storyboard.shots)).toEqual([[0, 7.8, 'split', 'A'], [7.8, 12, 'split', 'B']]);
    expect(demoted).toBe(0);
  });
  it('前后都放不下（会超过 8 秒）时，前一张卡片允许超出不足 1 秒（软上限 9 秒）', () => {
    const raw = { shots: [
      { start: 0, end: 8, layout: 'split', card: title('A') },
      { start: 8.5, end: 16.5, layout: 'split', card: title('B') },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 16.5);
    expect(rows(storyboard.shots)).toEqual([[0, 8.5, 'split', 'A'], [8.5, 16.5, 'split', 'B']]);
  });
  it('相邻的无卡片全屏镜头合并成一个（包括版式规则降级出来的）', () => {
    const hook = { template: 'hook', props: { index: 1, total: 1, headline: '钩子', highlight: [] } };
    const raw = { shots: [
      { start: 0, end: 3, layout: 'full' },
      { start: 3, end: 6, layout: 'full' },
      { start: 6, end: 10, layout: 'split', card: title('A') },
      { start: 16, end: 20, layout: 'split', card: hook },
      { start: 20, end: 24, layout: 'full' },
    ] };
    const { storyboard, demoted } = normalizeStoryboard(raw, 24);
    expect(rows(storyboard.shots)).toEqual([[0, 6, 'full', null], [6, 10, 'split', 'A'], [10, 24, 'full', null]]);
    expect(demoted).toBe(1);
  });
});

describe('normalizeStoryboard：末尾 CTA 至少 2 秒', () => {
  it('cta 不足 2 秒：从前一个镜头借时长（前一个镜头仍不短于 1 秒）', () => {
    const raw = { shots: [
      { start: 0, end: 11.5, layout: 'split', card: title('A') },
      { start: 11.5, end: 12, layout: 'full', card: cta },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 12);
    expect(rows(storyboard.shots)).toEqual([[0, 8, 'split', 'A'], [8, 10, 'full', null], [10, 12, 'full', 'cta']]);
  });
  it('前一个无卡片镜头借完会短于 1 秒时整个并入 cta', () => {
    const raw = { shots: [
      { start: 0, end: 8, layout: 'split', card: title('A') },
      { start: 8, end: 9, layout: 'full' },
      { start: 9, end: 10, layout: 'full', card: cta },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 10);
    expect(rows(storyboard.shots)).toEqual([[0, 8, 'split', 'A'], [8, 10, 'full', 'cta']]);
  });
  it('前一个是卡片且借完会短于 1 秒时只借到它剩 1 秒', () => {
    const raw = { shots: [
      { start: 0, end: 6, layout: 'full' },
      { start: 6, end: 7.2, layout: 'split', card: title('A') },
      { start: 7.2, end: 8.4, layout: 'full', card: cta },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 8.4);
    expect(rows(storyboard.shots)).toEqual([[0, 6, 'full', null], [6, 7, 'split', 'A'], [7, 8.4, 'full', 'cta']]);
  });
});

describe('normalizeStoryboard：镜头边界对齐到帧', () => {
  it('内部边界取最近的 1/30 秒，片尾保持片长', () => {
    const raw = { shots: [
      { start: 0, end: 3.01, layout: 'split', card: title('A') },
      { start: 3.01, end: 6.52, layout: 'split', card: title('B') },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 10.004);
    const bounds = storyboard.shots.slice(1).map((s) => s.start);
    expect(bounds).toEqual([90 / 30, 196 / 30]);
    expect(storyboard.shots.at(-1)?.end).toBe(10.004);
  });
});
