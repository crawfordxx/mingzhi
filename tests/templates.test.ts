// tests/templates.test.ts
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCardStill } from '../src/compose/render.js';
import { CardSpecSchema, TEMPLATE_IDS, type CardSpec } from '../src/storyboard/schema.js';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { fitFontSize, textEm } from '../render/templates/parts.js';
import { balanceLines, tokenize } from '../render/templates/headline.js';
import { countUp } from '../render/templates/BigNumber.js';
import { bottleLabel } from '../render/templates/CompareBars.js';
import { TYPE_START, typedChars } from '../render/templates/Terminal.js';
import { SAFE_H, fitScale } from '../render/templates/parts.js';
import { estimateChipsHeight } from '../render/templates/Chips.js';
import { STRIKE_END, strikeStarts } from '../render/templates/StrikeList.js';
import { clickTimes } from '../render/templates/Toggles.js';
import { ctaColor } from '../render/templates/Cta.js';
import { CardLayer } from '../render/layers/CardLayer.js';

export const SAMPLES: CardSpec[] = [
  { template: 'hook', props: { index: 1, total: 3, kicker: '这 3 句话都出自 GitHub 近 3.5 万星的《高性价比人生指南》', headline: '吃抗氧化补剂的人死亡率反而略高', highlight: ['略高'], stat: { value: '78 项试验', label: '近 30 万人' } } },
  { template: 'title', props: { crumb: '第 1 节', title: 'FDE 是什么', subtitle: '站在客户现场把 AI 用起来的人' } },
  { template: 'bigNumber', props: { value: '650', unit: '条建议', label: '34 章', chips: ['不要早死', '不要慢慢死', '不浪费精力', '不浪费时间', '不要浪费钱', '反面清单', '没钱怎么活', '别搭进去', '法律红线', '恋爱结婚', '程序员红线', '创业生意'], highlight: ['不要早死', '不要慢慢死'] } },
  { template: 'chips', props: { groups: [{ label: '帮别人', items: [{ text: '提效', mark: 'yes' }, { text: '算投入产出比', mark: 'yes' }] }, { label: '轮到自己', items: [{ text: '身体', mark: 'maybe' }, { text: '存款', mark: 'maybe' }] }] } },
  { template: 'compareBars', props: { crumb: '第 2 节第 7 条 · 证据 A', items: [{ name: '甜饮料（含糖）', note: '每天 2 瓶以上', value: 0.82, annotation: '死亡概率高约两成', tone: 'bad' }, { name: '代糖饮料（无糖）', note: '每天 2 杯以上', value: 0.88, annotation: '反而高约四分之一', tone: 'warn' }], verdict: '换成无糖 → 也没用' } },
  { template: 'evidenceList', props: { crumb: '示例 · 第 1 节', title: '把家里的食盐换成低钠盐', rows: [{ badge: '成本', text: '一袋比普通盐贵几元，口味几乎不变' }, { badge: '收益', text: '高危人群五年内死亡概率低约 12%' }, { badge: '证据', text: 'A 级 · 随机试验，20995 人，跟踪 4.74 年' }, { badge: '来源', text: 'Neal B 等 (2021) · NEJM' }], highlight: [3], tags: ['期刊论文', '官方文件'] } },
];

describe('卡片模板 A 组', () => {
  it('样例数据都符合模式', () => {
    for (const s of SAMPLES) expect(CardSpecSchema.safeParse(s).success).toBe(true);
  });
  it.each(SAMPLES.map((s) => [s.template, s] as const))('%s 能渲染出静帧', async (_id, card) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-tpl-'));
    const output = join(dir, `${card.template}.png`);
    await renderCardStill({ workDir: dir, output, card });
    expect(statSync(output).size).toBeGreaterThan(5000);
  }, 300_000);
});

describe('模板文字与数值工具', () => {
  it('字宽估算：中文 1em、英文约 0.55em', () => {
    expect(textEm('中文')).toBe(2);
    expect(textEm('ab')).toBeCloseTo(1.1);
    expect(textEm('AB12')).toBeCloseTo(2.6);
  });
  it('fitFontSize：放得下用基准字号，放不下按行宽缩小，不低于下限', () => {
    expect(fitFontSize('短标题', 960, 72, 40)).toBe(72);
    // 单行（nowrap）留 6% 余量
    expect(fitFontSize('一'.repeat(30), 960, 72, 20)).toBe(30);
    expect(fitFontSize('一'.repeat(60), 960, 72, 40)).toBe(40);
    expect(fitFontSize('一'.repeat(30), 960, 72, 20, 2)).toBe(30);
    expect(fitFontSize('一'.repeat(30), 960, 72, 40, 2)).toBe(61);
  });
  it('标题均衡断行，高亮子串不被拆开，行首不放标点', () => {
    const lines = balanceLines(tokenize('吃抗氧化补剂的人死亡率反而略高', ['略高']), 12.6);
    expect(lines.map((l) => l.map((t) => t.text).join(''))).toEqual(['吃抗氧化补剂的人', '死亡率反而略高']);
    expect(lines[1].at(-1)).toEqual({ text: '略高', hot: true });
    const punct = balanceLines(tokenize('每投 1 块钱，平均拿回 5 毛 1', []), 7);
    expect(punct.every((l) => !/^[，。]/.test(l[0].text))).toBe(true);
    const phrased = balanceLines(tokenize('买双色球，每投 1 块钱，平均拿回 5 毛 1', ['5 毛 1']), 12.6);
    expect(phrased.map((l) => l.map((t) => t.text).join(''))).toEqual(['买双色球，每投 1 块钱', '平均拿回 5 毛 1']);
  });
  it('countUp：纯数字按进度滚动并保留格式，非纯数字原样', () => {
    expect(countUp('650', 0.5)).toBe('325');
    expect(countUp('20,995', 1)).toBe('20,995');
    expect(countUp('4.74', 0)).toBe('0.00');
    expect(countUp('¥1.00', 0.3)).toBe('¥1.00');
    expect(countUp('007', 1)).toBe('007');
    expect(countUp('1,000', 1)).toBe('1,000');
  });
  it('瓶身标签取名称括号里的词', () => {
    expect(bottleLabel('甜饮料（含糖）')).toBe('含糖');
    expect(bottleLabel('可乐')).toBeNull();
  });
});

const SAMPLES_B: CardSpec[] = [
  { template: 'terminal', props: { lines: ['读一遍《高性价比人生指南》，结合我的工作和生活习惯，挑出我该改进的事', '结合你的情况，建议优先改这几件：', '1. 少喝含糖饮料，换成无糖的也不算解决'] } },
  { template: 'toggles', props: { title: '信用卡设置', rows: [{ label: '最低还款', on: false }, { label: '消费分期', on: true }], footnote: '最低还款折合下来，一年要付 18% 上下的利息' } },
  { template: 'strikeList', props: { items: ['自动续费的会员', '冲动下单', '用不上的订阅'] } },
  { template: 'browser', props: { url: 'github.com/eternity4719/HowToLiveBetter', image: 'broll/test.jpg' } },
  { template: 'photo', props: { image: 'broll/test.jpg', label: '应急金：3 到 6 个月生活费', sublabel: '放在随时取得到的地方' } },
  { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } },
];

describe('卡片模板 B 组', () => {
  it('A、B 两组样例覆盖全部 12 个模板', () => {
    expect(new Set([...SAMPLES, ...SAMPLES_B].map((s) => s.template))).toEqual(new Set(TEMPLATE_IDS));
  });
  it.each(SAMPLES_B.map((s) => [s.template, s] as const))('%s 能渲染出静帧', async (_id, card) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-tpl-'));
    mkdirSync(join(dir, 'broll'));
    await run(loadConfig({}).ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1080', '-frames:v', '1', join(dir, 'broll', 'test.jpg')]);
    const output = join(dir, `${card.template}.png`);
    await renderCardStill({ workDir: dir, output, card });
    expect(statSync(output).size).toBeGreaterThan(5000);
  }, 300_000);
});

describe('终端逐字打出', () => {
  it('每秒 28 字，行间停顿 0.2 秒，按码点计数', () => {
    const lines = ['一二三', 'ab'];
    expect(typedChars(lines, 0)).toEqual([0, 0]);
    expect(typedChars(lines, TYPE_START + 2 / 28 + 0.001)).toEqual([2, 0]);
    expect(typedChars(lines, TYPE_START + 3 / 28 + 0.1)).toEqual([3, 0]);
    expect(typedChars(lines, TYPE_START + 3 / 28 + 0.2 + 1 / 28 + 0.001)).toEqual([3, 1]);
    expect(typedChars(lines, 99)).toEqual([3, 2]);
  });
});

describe('按镜头时长收拢节奏与版面估算', () => {
  it('标签卡：字段上限的输入缩放后不超出安全区', () => {
    const item = (mark: 'yes' | 'no' | 'maybe') => ({ text: '十二个字的标签文本测试用', mark });
    const groups = [0, 1].map(() => ({ label: '十二个字的组名文本测试用', items: (['yes', 'no', 'maybe', 'yes', 'no'] as const).map(item) }));
    const est = estimateChipsHeight(groups);
    expect(est).toBeGreaterThan(SAFE_H);
    expect(est * fitScale(est)).toBeLessThanOrEqual(SAFE_H);
    const small = estimateChipsHeight([{ label: '帮别人', items: [item('yes'), item('yes')] }]);
    expect(fitScale(small)).toBe(1);
  });
  it('终端：3 秒镜头 6×40 字在出场前 0.4 秒打完；长镜头保持每秒 28 字', () => {
    const lines = Array.from({ length: 6 }, () => 'a'.repeat(40));
    expect(typedChars(lines, 3 - 0.65, 3)).toEqual(lines.map(() => 40));
    expect(typedChars(['一二三'], TYPE_START + 2 / 28 + 0.001, 60)).toEqual([2]);
  });
  it('划掉清单：2 秒 5 项，最后一道划线在出场前 0.3 秒划完；长镜头间隔不变', () => {
    const starts = strikeStarts(5, 2);
    expect(starts[4] + STRIKE_END).toBeLessThanOrEqual(2 - 0.25 - 0.3 + 1e-9);
    expect(starts[1] - starts[0]).toBeGreaterThan(0);
    const relaxed = strikeStarts(3, 10);
    expect(relaxed[1] - relaxed[0]).toBeCloseTo(0.42);
  });
  it('开关：短镜头压缩点击间隔，最后一次点击在出场前完成', () => {
    const t = clickTimes(4, 2.5);
    expect(t[3] + 0.3).toBeLessThanOrEqual(2.5 - 0.25 - 0.3 + 1e-9);
    expect(clickTimes(2, 10)).toEqual([0.6, 1.1]);
  });
  it('CTA 按文字取色，未知文字按序号取备用色', () => {
    expect(ctaColor('关注', 2)).toBe('#F2334B');
    expect(ctaColor('点赞', 0)).toBe('#FF7A2F');
    expect(ctaColor('收藏', 0)).toBe('#F5A623');
    expect(ctaColor('转发', 0)).toMatch(/^#[0-9A-F]{6}$/i);
    expect(ctaColor('转发', 0)).not.toBe(ctaColor('评论', 1));
  });
  it('CardLayer：全屏镜头只叠加 cta', () => {
    const cta: CardSpec = { template: 'cta', props: { actions: ['关注'] } };
    expect(CardLayer({ shots: [{ start: 0, end: 2, layout: 'full' }], sec: 1 })).toBeNull();
    expect(CardLayer({ shots: [{ start: 0, end: 2, layout: 'full', card: SAMPLES[1] }], sec: 1 })).toBeNull();
    expect(CardLayer({ shots: [{ start: 0, end: 2, layout: 'full', card: cta }], sec: 1 })).not.toBeNull();
  });
});
