import { describe, expect, it } from 'vitest';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import { checkCardFacts, checkStoryboardFacts, unsupportedNumbers } from '../src/storyboard/facts.js';
import { generateStoryboard } from '../src/storyboard/generate.js';
import { reviseCard } from '../src/storyboard/revise.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';

/** 横屏 v1 的口播（字幕） */
const SOURCE = '大家好 今天聊聊 怎么用 AI 剪口播 以前我剪一条视频 要两三个小时 现在只要把原片丢进去 口误和气口 它都会自动剪掉';

describe('unsupportedNumbers：卡片文字里的数字能不能在口播里找到', () => {
  it('中文数字与阿拉伯数字等价：「两三个小时」支持「2-3 小时」「2~3 小时」「3 小时」', () => {
    for (const t of ['2-3 小时', '2~3小时', '3 小时', '两三个小时', '2、3 个小时']) expect(unsupportedNumbers(t, SOURCE), t).toEqual([]);
  });
  it('编造的百分比、时长、倍数找不到', () => {
    expect(unsupportedNumbers('效率提升 90%', SOURCE)).toEqual(['90%']);
    expect(unsupportedNumbers('几分钟', SOURCE)).toEqual(['几分钟']);
    expect(unsupportedNumbers('快 3 倍', SOURCE)).toEqual(['3 倍']);
    expect(unsupportedNumbers('5 小时', SOURCE)).toEqual(['5 小时']);
  });
  it('百分之、倍数、万：单位要对得上', () => {
    expect(unsupportedNumbers('30%', '涨了百分之三十')).toEqual([]);
    expect(unsupportedNumbers('30 倍', '涨了百分之三十')).toEqual(['30 倍']);
    expect(unsupportedNumbers('2 倍', '翻了两倍')).toEqual([]);
    expect(unsupportedNumbers('3.5 万', '一年三点五万')).toEqual([]);
    expect(unsupportedNumbers('650 条', '六百五十条')).toEqual([]);
  });
  it('列表序号前缀、没有量词的汉字（一键、统一）不算数字', () => {
    expect(unsupportedNumbers('1. 早上先做最难的事', '第一个习惯')).toEqual([]);
    expect(unsupportedNumbers('3. 睡前规划明天', '没有数字')).toEqual([]);
    expect(unsupportedNumbers('一键处理 统一风格', '没有数字')).toEqual([]);
    expect(unsupportedNumbers('三个习惯', '三个提高效率的小习惯')).toEqual([]);
    expect(unsupportedNumbers('3个提高效率的小习惯', '三个提高效率的小习惯')).toEqual([]);
    expect(unsupportedNumbers('五个习惯', '三个提高效率的小习惯')).toEqual(['五个']);
    expect(unsupportedNumbers('只有一个办法 一次搞定', '没有数字')).toEqual([]);
    expect(unsupportedNumbers('一小时', '没有数字')).toEqual(['一小时']);
  });
});

describe('checkCardFacts：去掉带编造数字的字段，必填字段编造时降级', () => {
  const bars: CardSpec = { template: 'compareBars', props: { crumb: '剪辑效率对比', items: [
    { name: '传统剪辑', note: '逐帧剪辑，费时费力', value: 0.9, annotation: '2-3 小时', tone: 'bad' },
    { name: 'AI 剪辑', note: '一键处理，极速导出', value: 0.1, annotation: '几分钟', tone: 'good' },
  ], verdict: '效率提升 90%' } };

  it('横屏 v1 的对比条卡：去掉「效率提升 90%」「几分钟」，保留「2-3 小时」和条形比例', () => {
    const { card, removed } = checkCardFacts(bars, SOURCE);
    expect(card).toEqual({ template: 'compareBars', props: { crumb: '剪辑效率对比', items: [
      { name: '传统剪辑', note: '逐帧剪辑，费时费力', value: 0.9, annotation: '2-3 小时', tone: 'bad' },
      { name: 'AI 剪辑', note: '一键处理，极速导出', value: 0.1, tone: 'good' },
    ] } });
    expect(removed).toEqual(['几分钟', '90%']);
  });
  it('数字都对得上：原样返回', () => {
    const ok: CardSpec = { template: 'title', props: { title: '以前要两三个小时' } };
    expect(checkCardFacts(ok, SOURCE)).toEqual({ card: ok, removed: [] });
  });
  it('必填字段编造（大数字卡的数字）：降级为不含数字的标题卡；连标题也编造就丢掉卡片', () => {
    const big: CardSpec = { template: 'bigNumber', props: { value: '90%', label: '效率提升' } };
    expect(checkCardFacts(big, SOURCE).card).toEqual({ template: 'title', props: { title: '效率提升' } });
    const bad: CardSpec = { template: 'bigNumber', props: { value: '90%', label: '提升 90%' } };
    expect(checkCardFacts(bad, SOURCE).card).toBeNull();
  });
  it('列表里的一项编造：去掉这一项；去完不够最少条数时降级', () => {
    const list: CardSpec = { template: 'strikeList', props: { title: '自动剪掉', items: ['口误', '3 秒停顿'] } };
    expect(checkCardFacts(list, SOURCE).card).toEqual({ template: 'strikeList', props: { title: '自动剪掉', items: ['口误'] } });
    const one: CardSpec = { template: 'strikeList', props: { title: '自动剪掉', items: ['3 秒停顿'] } };
    expect(checkCardFacts(one, SOURCE).card).toEqual({ template: 'title', props: { title: '自动剪掉' } });
  });
  it('素材字段（image、visual、url）里的数字不检查', () => {
    const photo: CardSpec = { template: 'photo', props: { image: 'broll/1d45532ca5d2.jpg', label: '剪辑台' } };
    expect(checkCardFacts(photo, SOURCE)).toEqual({ card: photo, removed: [] });
  });
});

describe('checkStoryboardFacts：整条分镜（模型原始输出）', () => {
  it('逐镜头清理，统计去掉的数字；卡片整体丢掉时镜头改为全屏', () => {
    const raw = { bgm: 'tech', shots: [
      { start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: '两三个小时' } } },
      { start: 2, end: 4, layout: 'split', card: { template: 'bigNumber', props: { value: '90%', label: '提升 90%' } } },
      { start: 4, end: 6, layout: 'split', card: { template: 'nope', props: {} } },
    ] };
    const res = checkStoryboardFacts(raw, SOURCE);
    expect(res.removed).toEqual(['90%', '90%']);
    const shots = (res.raw as { shots: Shot[] }).shots;
    expect(shots[0]).toEqual(raw.shots[0]);
    expect(shots[1]).toEqual({ start: 2, end: 4, layout: 'full' });
    expect(shots[2]).toEqual(raw.shots[2]);
    expect((res.raw as { bgm: string }).bgm).toBe('tech');
  });
});

const scripted = (...replies: unknown[]) => {
  const calls: ChatOptions[] = [];
  const client: LlmClient = { chatJson: async (o) => { calls.push(o); return replies[calls.length - 1]; } };
  return { client, calls };
};

describe('分镜与卡片重写接入数字校验', () => {
  const caps = [{ start: 0, end: 3, text: '以前我剪一条视频' }, { start: 3, end: 6, text: '要两三个小时' }];

  it('generateStoryboard：编造的数字被去掉，返回去掉了几处；提示词禁止口播里没有的数字', async () => {
    const { client, calls } = scripted({ shots: [
      { start: 0, end: 3, layout: 'split', card: { template: 'title', props: { title: '以前要 2-3 小时' } } },
      { start: 3, end: 6, layout: 'split', card: { template: 'title', props: { title: '剪辑太慢', subtitle: '现在快 10 倍' } } },
    ] });
    const res = await generateStoryboard(client, caps, 6, []);
    expect(res.storyboard.shots.map((s) => s.card)).toEqual([
      { template: 'title', props: { title: '以前要 2-3 小时' } },
      { template: 'title', props: { title: '剪辑太慢' } },
    ]);
    expect(res.unsupported).toEqual(['10 倍']);
    expect(calls[0].system).toContain('口播里没有的数字');
  });

  it('reviseCard：用整条字幕校验，编造的字段去掉；提示词禁止口播里没有的数字', async () => {
    const shot: Shot = { start: 3, end: 6, layout: 'split', card: { template: 'title', props: { title: '旧' } } };
    const score = { layout: 6, hierarchy: 6, motion: 8, brand: 8, notes: '太空' };
    const { client, calls } = scripted({ card: { template: 'title', props: { title: '以前两三个小时', subtitle: '现在几分钟' } } });
    expect(await reviseCard(client, shot, [caps[1]], score, [], caps)).toEqual({ template: 'title', props: { title: '以前两三个小时' } });
    expect(calls[0].system).toContain('口播里没有的数字');
  });
});
