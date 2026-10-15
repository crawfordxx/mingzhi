import { describe, expect, it } from 'vitest';
import { CardSpecSchema, TEMPLATE_IDS } from '../src/storyboard/schema.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';

const title = (t: string) => ({ template: 'title', props: { title: t } });

describe('CardSpecSchema', () => {
  it('12 个模板 id', () => {
    expect(TEMPLATE_IDS).toHaveLength(12);
  });
  it('按 template 校验各自的 props；未知模板或缺字段不通过', () => {
    expect(CardSpecSchema.safeParse(title('你好')).success).toBe(true);
    expect(CardSpecSchema.safeParse({ template: 'hook', props: { index: 1, total: 3, headline: '吃抗氧化剂的人死亡率反而略高', highlight: ['略高'] } }).success).toBe(true);
    expect(CardSpecSchema.safeParse({ template: 'compareBars', props: { items: [{ name: '甜饮料', value: 0.8, tone: 'bad' }] } }).success).toBe(true);
    expect(CardSpecSchema.safeParse({ template: 'compareBars', props: { items: [{ name: '甜饮料', value: 1.8, tone: 'bad' }] } }).success).toBe(false);
    expect(CardSpecSchema.safeParse({ template: 'nope', props: {} }).success).toBe(false);
    expect(CardSpecSchema.safeParse({ template: 'title', props: {} }).success).toBe(false);
  });
});

describe('normalizeStoryboard', () => {
  it('排序、截到片长、补齐空隙为全屏、首尾对齐 0 与片长', () => {
    const raw = { shots: [
      { start: 5, end: 9, layout: 'split', card: title('B') },
      { start: 0.4, end: 4, layout: 'split', card: title('A') },
      { start: 12, end: 30, layout: 'split', card: title('C') },
    ] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 20, []);
    expect(dropped).toBe(0);
    expect(storyboard.shots.map((s) => [s.start, s.end, s.layout, s.card?.template ?? null])).toEqual([
      [0, 0.4, 'full', null],
      [0.4, 4, 'split', 'title'],
      [4, 5, 'full', null],
      [5, 9, 'split', 'title'],
      [9, 12, 'full', null],
      [12, 20, 'split', 'title'],
    ]);
  });
  it('重叠时后一个从前一个结束处开始；短于 1 秒的镜头并入前一个；卡片 props 不合法的镜头丢弃并计数', () => {
    const raw = { shots: [
      { start: 0, end: 6, layout: 'split', card: title('A') },
      { start: 5, end: 6.5, layout: 'split', card: title('B') },
      { start: 6.5, end: 10, layout: 'split', card: { template: 'title', props: {} } },
    ] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 10, []);
    expect(dropped).toBe(1);
    expect(storyboard.shots.map((s) => [s.start, s.end, s.card?.props])).toEqual([
      [0, 6.5, { title: 'A' }],
      [6.5, 10, undefined],
    ]);
  });
  it('photo 引用的图片不在可用列表时丢弃该镜头；browser 的图片不可用时去掉图片保留镜头', () => {
    const raw = { shots: [
      { start: 0, end: 3, layout: 'split', card: { template: 'photo', props: { image: 'broll/a.jpg' } } },
      { start: 3, end: 6, layout: 'split', card: { template: 'browser', props: { url: 'github.com/x', image: 'broll/b.png' } } },
      { start: 6, end: 9, layout: 'split', card: { template: 'photo', props: { image: 'broll/c.jpg' } } },
    ] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 9, ['broll/c.jpg']);
    expect(dropped).toBe(1);
    expect(storyboard.shots[1].card).toEqual({ template: 'browser', props: { url: 'github.com/x' } });
    expect(storyboard.shots[2].card).toEqual({ template: 'photo', props: { image: 'broll/c.jpg' } });
  });
  it('hook 只允许出现在前 15 秒且最多 3 张；cta 只允许在最后一个镜头并强制全屏', () => {
    const hook = (i: number) => ({ template: 'hook', props: { index: i, total: 3, headline: `钩子${i}` , highlight: [] } });
    const raw = { shots: [
      { start: 0, end: 4, layout: 'split', card: hook(1) },
      { start: 4, end: 8, layout: 'split', card: hook(2) },
      { start: 8, end: 12, layout: 'split', card: hook(3) },
      { start: 12, end: 14, layout: 'split', card: hook(4) },
      { start: 16, end: 20, layout: 'split', card: hook(5) },
      { start: 20, end: 24, layout: 'split', card: { template: 'cta', props: { actions: ['关注'] } } },
      { start: 24, end: 30, layout: 'split', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } } },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 30, []);
    const templates = storyboard.shots.map((s) => s.card?.template ?? null);
    expect(templates.filter((t) => t === 'hook')).toHaveLength(3);
    expect(templates.filter((t) => t === 'cta')).toHaveLength(1);
    expect(storyboard.shots[storyboard.shots.length - 1]).toMatchObject({ layout: 'full', card: { template: 'cta' } });
  });
  it('模型输出不是 {shots:[]} 时返回整片全屏一个镜头', () => {
    expect(normalizeStoryboard({ nope: 1 }, 12, []).storyboard.shots).toEqual([{ start: 0, end: 12, layout: 'full' }]);
    expect(normalizeStoryboard(null, 12, []).storyboard.shots).toEqual([{ start: 0, end: 12, layout: 'full' }]);
  });
});
