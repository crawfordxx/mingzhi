import { describe, expect, it } from 'vitest';
import { CardSpecSchema, TEMPLATE_IDS } from '../src/storyboard/schema.js';
import { normalizeStoryboard as normalizeRaw } from '../src/storyboard/normalize.js';

/** 时间轴不变量：从 0 开始、首尾相接、无零长镜头、结束于片长 */
function expectTimeline(shots: { start: number; end: number }[], durationSec: number): void {
  expect(shots[0].start).toBe(0);
  shots.forEach((s, i) => {
    expect(s.end).toBeGreaterThan(s.start);
    if (i > 0) expect(s.start).toBe(shots[i - 1].end);
  });
  expect(shots[shots.length - 1].end).toBe(durationSec);
}

/** 所有归一化用例的输出都经过时间轴不变量检查 */
const normalizeStoryboard = (raw: unknown, durationSec: number, images: string[]) => {
  const result = normalizeRaw(raw, durationSec, images);
  expectTimeline(result.storyboard.shots, durationSec);
  return result;
};

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
  it('排序、截到片长、补齐空隙为全屏、首尾对齐 0 与片长；片头不足 1 秒的空隙并入后一张卡片', () => {
    const raw = { shots: [
      { start: 5, end: 9, layout: 'split', card: title('B') },
      { start: 0.4, end: 4, layout: 'split', card: title('A') },
      { start: 12, end: 30, layout: 'split', card: title('C') },
    ] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 20, []);
    expect(dropped).toBe(0);
    expect(storyboard.shots.map((s) => [s.start, s.end, s.layout, s.card?.template ?? null])).toEqual([
      [0, 4, 'split', 'title'],
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
    const { storyboard, dropped, demoted } = normalizeStoryboard(raw, 10, []);
    expect(dropped).toBe(1);
    expect(demoted).toBe(1);
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

const cta = (actions: string[]) => ({ template: 'cta', props: { actions } });
const shotRows = (shots: { start: number; end: number; layout: string; card?: { template: string } }[]) =>
  shots.map((s) => [s.start, s.end, s.layout, s.card?.template ?? null]);

describe('normalizeStoryboard：CTA 保留', () => {
  it('CTA 不足 2 秒且前面是空镜头时：并入空镜头后继续向更早的卡片借时长', () => {
    const raw = { shots: [
      { start: 25.67, end: 33.49, layout: 'split', card: title('A') },
      { start: 33.49, end: 34.63, layout: 'full' },
      { start: 34.63, end: 34.93, layout: 'full', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } } },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 34.93, []);
    const last = storyboard.shots[storyboard.shots.length - 1];
    expect(last.card?.template).toBe('cta');
    expect(last.end - last.start).toBeGreaterThanOrEqual(2 - 1e-6);
  });

  it('cta 5–8 在 10 秒片中：cta 是最后一个镜头，延伸到片长并全屏', () => {
    const raw = { shots: [{ start: 5, end: 8, layout: 'split', card: cta(['关注']) }] };
    const { storyboard, demoted } = normalizeStoryboard(raw, 10, []);
    expect(shotRows(storyboard.shots)).toEqual([
      [0, 5, 'full', null],
      [5, 10, 'full', 'cta'],
    ]);
    expect(demoted).toBe(0);
  });
  it('cta 9.2–10 在 title 2–9.2 之后：cta 保留（不并入前一个），并向前借时长补足 2 秒', () => {
    const raw = { shots: [
      { start: 2, end: 9.2, layout: 'split', card: title('A') },
      { start: 9.2, end: 10, layout: 'split', card: cta(['关注']) },
    ] };
    const { storyboard, demoted, dropped } = normalizeStoryboard(raw, 10, []);
    expect(shotRows(storyboard.shots)).toEqual([
      [0, 2, 'full', null],
      [2, 8, 'split', 'title'],
      [8, 10, 'full', 'cta'],
    ]);
    expect(demoted).toBe(0);
    expect(dropped).toBe(0);
  });
  it('cta 之后只有无卡片镜头时：吸收这些镜头，cta 延伸到片尾，时间轴连续无重叠', () => {
    const raw = { shots: [
      { start: 0, end: 4, layout: 'split', card: title('A') },
      { start: 4, end: 8, layout: 'split', card: cta(['关注']) },
      { start: 8, end: 10, layout: 'full' },
    ] };
    const { storyboard, dropped, demoted } = normalizeStoryboard(raw, 10, []);
    expect(shotRows(storyboard.shots)).toEqual([
      [0, 4, 'split', 'title'],
      [4, 10, 'full', 'cta'],
    ]);
    expect(dropped).toBe(0); // 被吸收的空镜头不是无效输出，不计入 dropped
    expect(demoted).toBe(0);
  });
});

describe('normalizeStoryboard：hook 图片与计数', () => {
  it('hook 的 image 不可用时去掉 image 保留卡片', () => {
    const raw = { shots: [{ start: 0, end: 4, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '钩子', highlight: [], image: 'broll/x.jpg' } } }] };
    const { storyboard, dropped, demoted } = normalizeStoryboard(raw, 4, []);
    const card = storyboard.shots[0].card;
    expect(card?.template).toBe('hook');
    expect(card?.props).not.toHaveProperty('image');
    expect(dropped).toBe(0);
    expect(demoted).toBe(0);
  });
  it('被前一镜头整体覆盖的镜头计入 dropped，不计 demoted', () => {
    const raw = { shots: [
      { start: 0, end: 6, layout: 'split', card: title('A') },
      { start: 1, end: 3, layout: 'split', card: title('B') },
    ] };
    const { dropped, demoted } = normalizeStoryboard(raw, 6, []);
    expect(dropped).toBe(1);
    expect(demoted).toBe(0);
  });
  it('超出片长的镜头计入 dropped', () => {
    const raw = { shots: [
      { start: 0, end: 10, layout: 'split', card: title('A') },
      { start: 25, end: 30, layout: 'split', card: title('B') },
    ] };
    const { dropped, demoted } = normalizeStoryboard(raw, 10, []);
    expect(dropped).toBe(1);
    expect(demoted).toBe(0);
  });
  it('版式规则降级（hook 超出窗口）计入 demoted，不计 dropped', () => {
    const hook = (i: number) => ({ template: 'hook', props: { index: i, total: 3, headline: `钩子${i}`, highlight: [] } });
    const raw = { shots: [{ start: 16, end: 20, layout: 'split', card: hook(1) }] };
    const { demoted, dropped } = normalizeStoryboard(raw, 20, []);
    expect(demoted).toBe(1);
    expect(dropped).toBe(0);
  });
  it('hook 编号按保留下来的钩子重新编为 1..n，total 为 n', () => {
    const hook = (i: number) => ({ template: 'hook', props: { index: i, total: 3, headline: `钩子${i}`, highlight: [] } });
    const raw = { shots: [
      { start: 0, end: 4, layout: 'split', card: hook(2) },
      { start: 5, end: 9, layout: 'split', card: hook(3) },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 10, []);
    expect(storyboard.shots.flatMap((s) => (s.card ? [s.card.props] : []))).toEqual([
      { index: 1, total: 2, headline: '钩子2', highlight: [] },
      { index: 2, total: 2, headline: '钩子3', highlight: [] },
    ]);
  });
});

describe('normalizeStoryboard：字段清理与边界', () => {
  it('hook.highlight 只保留 headline 的子串；evidenceList.highlight 去掉越界下标', () => {
    const raw = { shots: [
      { start: 0, end: 4, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '吃抗氧化剂的人死亡率', highlight: ['死亡率', '不存在'] } } },
      { start: 4, end: 8, layout: 'split', card: { template: 'evidenceList', props: { title: '证据', rows: [{ badge: '证据', text: 'a' }, { badge: '成本', text: 'b' }], highlight: [0, 3] } } },
    ] };
    const { storyboard } = normalizeStoryboard(raw, 8, []);
    expect(storyboard.shots[0].card?.props).toMatchObject({ highlight: ['死亡率'] });
    expect(storyboard.shots[1].card?.props).toMatchObject({ highlight: [0] });
  });
  it('split 但没有卡片的镜头变为 full', () => {
    const { storyboard } = normalizeStoryboard({ shots: [{ start: 0, end: 4, layout: 'split' }] }, 4, []);
    expect(storyboard.shots).toEqual([{ start: 0, end: 4, layout: 'full' }]);
  });
  it('短镜头恰好 1 秒（浮点误差后）保留', () => {
    const raw = { shots: [{ start: 1.13, end: 2.13, layout: 'split', card: title('B') }] };
    const { storyboard, demoted } = normalizeStoryboard(raw, 4, []);
    // 边界对齐到帧：1.13 → 34/30，2.13 → 64/30
    expect(shotRows(storyboard.shots)).toEqual([
      [0, 34 / 30, 'full', null],
      [34 / 30, 64 / 30, 'split', 'title'],
      [64 / 30, 4, 'full', null],
    ]);
    expect(demoted).toBe(0);
  });
  it('非有限的 start/end 按结构不合法计入 dropped', () => {
    const raw = { shots: [{ start: 0, end: Infinity, layout: 'split', card: title('A') }] };
    const { storyboard, dropped } = normalizeStoryboard(raw, 5, []);
    expect(dropped).toBe(1);
    expect(storyboard.shots).toEqual([{ start: 0, end: 5, layout: 'full' }]);
  });
  it.each([0, -1, NaN, Infinity])('片长 %s 无效时抛错', (d) => {
    expect(() => normalizeStoryboard({ shots: [] }, d, [])).toThrow('分镜归一化失败：片长无效');
  });
});

describe('CardSpecSchema：字段长度收紧', () => {
  it('chip 类字段最长 12 字', () => {
    const bn = (chips: string[]) => ({ template: 'bigNumber', props: { value: '3', label: '标签', chips } });
    expect(CardSpecSchema.safeParse(bn(['一二三四五六七八九十一二'])).success).toBe(true);
    expect(CardSpecSchema.safeParse(bn(['一二三四五六七八九十一二三'])).success).toBe(false);
  });
  it('terminal 行最长 40 字', () => {
    const term = (line: string) => ({ template: 'terminal', props: { lines: [line] } });
    expect(CardSpecSchema.safeParse(term('甲'.repeat(40))).success).toBe(true);
    expect(CardSpecSchema.safeParse(term('甲'.repeat(41))).success).toBe(false);
  });
  it('bigNumber.chips 最多 18 个', () => {
    const bn = (n: number) => ({ template: 'bigNumber', props: { value: '3', label: '标签', chips: Array.from({ length: n }, () => '词') } });
    expect(CardSpecSchema.safeParse(bn(18)).success).toBe(true);
    expect(CardSpecSchema.safeParse(bn(19)).success).toBe(false);
  });
});

describe('normalizeStoryboard：镜头限长 8 秒', () => {
  it('17 秒卡片镜头只保留前 8 秒，余下补为全屏，capped 计 1', () => {
    const raw = { shots: [{ start: 0, end: 17, layout: 'split', card: title('A') }] };
    const { storyboard, capped } = normalizeStoryboard(raw, 17, []);
    expect(shotRows(storyboard.shots)).toEqual([[0, 8, 'split', 'title'], [8, 17, 'full', null]]);
    expect(capped).toBe(1);
  });
  it('过长的 cta（延伸到片尾）保留最后 8 秒，起点后移', () => {
    const raw = { shots: [{ start: 2, end: 20, layout: 'split', card: cta(['关注']) }] };
    const { storyboard, capped } = normalizeStoryboard(raw, 20, []);
    expect(shotRows(storyboard.shots)).toEqual([[0, 12, 'full', null], [12, 20, 'full', 'cta']]);
    expect(capped).toBe(1);
  });
  it('短卡片镜头并入前一个会超过 8 秒时改为并入后面的全屏镜头（不出现 8.5 秒的卡片，也不出现 0.5 秒的闪屏）', () => {
    const raw = { shots: [
      { start: 0, end: 8, layout: 'split', card: title('A') },
      { start: 8, end: 8.5, layout: 'split', card: title('B') },
      { start: 8.5, end: 20, layout: 'full' },
    ] };
    const { storyboard, demoted } = normalizeStoryboard(raw, 20, []);
    expect(shotRows(storyboard.shots)).toEqual([[0, 8, 'split', 'title'], [8, 20, 'full', null]]);
    expect(demoted).toBe(1);
  });

  it('长度 8.5 秒：余下不足 1 秒，改为保留 7.5 秒，避免被并回', () => {
    const raw = { shots: [{ start: 0, end: 8.5, layout: 'split', card: title('A') }] };
    const { storyboard, capped } = normalizeStoryboard(raw, 8.5, []);
    expect(shotRows(storyboard.shots)).toEqual([[0, 7.5, 'split', 'title'], [7.5, 8.5, 'full', null]]);
    expect(capped).toBe(1);
  });
  it('恰好 8 秒的卡片镜头与超长的无卡片镜头都不动', () => {
    const raw = { shots: [
      { start: 0, end: 8, layout: 'split', card: title('A') },
      { start: 8, end: 30, layout: 'full' },
    ] };
    const { storyboard, capped } = normalizeStoryboard(raw, 30, []);
    expect(shotRows(storyboard.shots)).toEqual([[0, 8, 'split', 'title'], [8, 30, 'full', null]]);
    expect(capped).toBe(0);
  });
});
