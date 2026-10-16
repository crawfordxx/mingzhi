// 卡片间转场的选择：结构差异大（模板不同且结构类不同）的相邻分屏卡片用遮罩擦除，同类卡片仍交叉叠化；擦除方向跟下一张卡的阅读方向
import { describe, expect, it } from 'vitest';
import { CARD_XFADE_SEC, WIPE_LEAD_SEC, WIPE_SEC, cardLead, carryStyle, structureOf, wipeAt } from '../src/compose/card-carry.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';

const card = {
  title: { template: 'title', props: { title: '标题' } },
  bigNumber: { template: 'bigNumber', props: { value: '3', label: '个' } },
  compareBars: { template: 'compareBars', props: { items: [{ name: '传统', value: 0.8, tone: 'bad' }, { name: 'AI', value: 0.1, tone: 'good' }] } },
  flow: { template: 'flow', props: { steps: [{ label: '导入' }, { label: '识别' }] } },
  evidenceList: { template: 'evidenceList', props: { title: '要点', rows: [{ badge: '要点', text: '一' }, { badge: '要点', text: '二' }] } },
  strikeList: { template: 'strikeList', props: { items: ['一', '二'] } },
  hook: { template: 'hook', props: { index: 1, total: 1, headline: '钩子', highlight: [] } },
} as unknown as Record<string, CardSpec>;

const split = (start: number, c: CardSpec): Shot => ({ start, end: start + 2, layout: 'split', card: c });

describe('carryStyle', () => {
  it('compareBars → flow（模板不同且结构不同）用擦除，方向跟流程图的横向阅读', () => {
    expect(carryStyle([split(0, card.compareBars), split(2, card.flow)], 1)).toEqual({ kind: 'wipe', axis: 'x' });
  });
  it('钩子 → 清单：擦除，清单从上往下读，竖向', () => {
    expect(carryStyle([split(0, card.hook), split(2, card.evidenceList)], 1)).toEqual({ kind: 'wipe', axis: 'y' });
  });
  it('同模板、或模板不同但结构同类（证据清单 → 划掉清单，标题 → 大数字）仍叠化', () => {
    expect(carryStyle([split(0, card.flow), split(2, card.flow)], 1)).toEqual({ kind: 'fade' });
    expect(carryStyle([split(0, card.evidenceList), split(2, card.strikeList)], 1)).toEqual({ kind: 'fade' });
    expect(carryStyle([split(0, card.title), split(2, card.bigNumber)], 1)).toEqual({ kind: 'fade' });
  });
  it('有一边不是分屏卡片（浮层、人物全屏、首个镜头）时叠化', () => {
    expect(carryStyle([split(0, card.compareBars), { ...split(2, card.flow), layout: 'overlay' }], 1)).toEqual({ kind: 'fade' });
    expect(carryStyle([{ start: 0, end: 2, layout: 'full' }, split(2, card.flow)], 1)).toEqual({ kind: 'fade' });
    expect(carryStyle([split(0, card.flow)], 0)).toEqual({ kind: 'fade' });
  });
  it('结构类：同一类的模板在一起', () => {
    expect(structureOf('evidenceList')).toBe(structureOf('strikeList'));
    expect(structureOf('compareBars')).not.toBe(structureOf('flow'));
  });
});

describe('wipeAt', () => {
  it('擦除时长与交叉过渡同一窗口，≤ 0.35 秒', () => {
    expect(WIPE_SEC).toBe(CARD_XFADE_SEC);
    expect(WIPE_SEC).toBeLessThanOrEqual(0.35);
  });
  it('边缘从 0 单调走到 1，首尾缓（中段最快），中点在 0.5', () => {
    const ps = Array.from({ length: 11 }, (_, i) => wipeAt(i / 10));
    expect(ps[0]).toBe(0);
    expect(ps[10]).toBe(1);
    expect(ps[5]).toBeCloseTo(0.5, 1);
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
    expect(ps[1] - ps[0]).toBeLessThan(ps[5] - ps[4]);
  });
});

describe('擦除进来的卡片时钟提前', () => {
  it('擦除时新卡内容已就位（内部时钟提前 WIPE_LEAD_SEC），叠化的不提前', () => {
    const shots = [split(0, card.compareBars), split(2, card.flow), split(4, card.flow)];
    expect(WIPE_LEAD_SEC).toBeGreaterThan(0);
    expect([0, 1, 2].map((i) => cardLead(shots, i))).toEqual([0, WIPE_LEAD_SEC, 0]);
  });
  it('镜头自带 lead（整片自检切开的后段）时仍以它为准', () => {
    const shots = [split(0, card.compareBars), { ...split(2, card.flow), lead: 1.2 }];
    expect(cardLead(shots, 1)).toBe(1.2);
  });
});
