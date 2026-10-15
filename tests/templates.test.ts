// tests/templates.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCardStill } from '../src/compose/render.js';
import { CardSpecSchema, type CardSpec } from '../src/storyboard/schema.js';
import { fitFontSize, textEm } from '../render/templates/parts.js';
import { balanceLines, tokenize } from '../render/templates/headline.js';
import { countUp } from '../render/templates/BigNumber.js';
import { bottleLabel } from '../render/templates/CompareBars.js';

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
  });
  it('fitFontSize：放得下用基准字号，放不下按行宽缩小，不低于下限', () => {
    expect(fitFontSize('短标题', 960, 72, 40)).toBe(72);
    expect(fitFontSize('一'.repeat(30), 960, 72, 20)).toBe(32);
    expect(fitFontSize('一'.repeat(60), 960, 72, 40)).toBe(40);
    expect(fitFontSize('一'.repeat(30), 960, 72, 20, 2)).toBe(32);
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
  });
  it('瓶身标签取名称括号里的词', () => {
    expect(bottleLabel('甜饮料（含糖）')).toBe('含糖');
    expect(bottleLabel('可乐')).toBeNull();
  });
});
