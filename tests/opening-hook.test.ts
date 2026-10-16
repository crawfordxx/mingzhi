import { describe, expect, it } from 'vitest';
import { openingHookText, withOpeningHook } from '../src/compose/opening-hook.js';
import type { Shot } from '../src/storyboard/schema.js';

const cap = (start: number, end: number, text: string) => ({ start, end, text });
const brollShot = (start: number, end: number): Shot => ({ start, end, layout: 'broll', broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } });
const hookCard = (headline: string): Shot => ({ start: 3, end: 6, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline, highlight: [] } } });

describe('openingHookText：开头钩子文字来源', () => {
  it('优先用分镜里的钩子卡标题', () => {
    expect(openingHookText([brollShot(0, 3), hookCard('三个提高效率的小习惯')], [cap(0, 2, '大家好今天聊聊')], undefined)).toBe('三个提高效率的小习惯');
  });
  it('钩子卡标题太长放不下一行时跳过，改用后面的来源', () => {
    expect(openingHookText([brollShot(0, 3), hookCard('这是一个非常非常长的钩子标题根本放不下一行啊')], [cap(0, 2, '大家好')], { title: 'AI 剪口播神器' })).toBe('AI 剪口播神器');
  });
  it('开头 4 秒的字幕里有数字：取含数字的核心短语（去掉寒暄前缀）', () => {
    expect(openingHookText([brollShot(0, 3)], [cap(0.1, 0.6, '大家好'), cap(0.7, 3, '今天分享三个提高效率的小习惯')], { title: '悄悄变强' })).toBe('三个提高效率的小习惯');
    expect(openingHookText([brollShot(0, 3)], [cap(0.2, 2.5, '以前剪一条要2到3小时')], undefined)).toBe('以前剪一条要2到3小时');
  });
  it('没有数字：优先封面标题；封面标题也没有时取第一句核心短语', () => {
    const caps = [cap(0.17, 0.65, '大家好'), cap(0.68, 2.99, '今天聊聊怎么用 AI 剪口播')];
    expect(openingHookText([brollShot(0, 3)], caps, { title: 'AI 剪口播神器' })).toBe('AI 剪口播神器');
    expect(openingHookText([brollShot(0, 3)], caps, undefined)).toBe('怎么用 AI 剪口播');
  });
  it('只看第一个镜头结束前开口的字幕；「一条」「一键」这种量词用法不算数字', () => {
    const caps = [cap(0.2, 2.5, '今天聊聊怎么用 AI 剪口播'), cap(3.28, 4.4, '以前我剪一条视频')];
    expect(openingHookText([brollShot(0, 3)], caps, undefined)).toBe('怎么用 AI 剪口播');
    expect(openingHookText([brollShot(0, 3.5)], [cap(0.2, 2, '一键搞定'), cap(2.1, 3, '三个小技巧')], undefined)).toBe('三个小技巧');
  });
  it('全是寒暄或没有字幕：没有文字', () => {
    expect(openingHookText([brollShot(0, 3)], [cap(0.1, 0.6, '大家好')], undefined)).toBeUndefined();
    expect(openingHookText([brollShot(0, 3)], [], undefined)).toBeUndefined();
  });
  it('核心短语超过一行时在停顿或空格处截到一行内；截不出就不用', () => {
    const t = openingHookText([brollShot(0, 3)], [cap(0, 3, '今天聊聊 怎么用 AI 把口播剪得又快又好 而且不花钱')], undefined);
    expect(t).toBe('怎么用 AI 把口播剪得又快又好');
    expect(openingHookText([brollShot(0, 3)], [cap(0, 3, '这一整句话没有任何空格和停顿所以根本截不出合适的短语来')], undefined)).toBeUndefined();
  });
});

describe('withOpeningHook：第一个镜头是全屏素材才叠钩子', () => {
  const caps = [cap(0.68, 2.99, '今天聊聊怎么用 AI 剪口播')];
  it('第一个镜头是全屏素材：只在它的 broll 上写 hook，其余镜头与入参不变', () => {
    const shots = [brollShot(0, 3), { start: 3, end: 6, layout: 'full' } as Shot];
    const snapshot = JSON.stringify(shots);
    const out = withOpeningHook(shots, caps, undefined);
    expect(out[0].broll?.hook).toBe('怎么用 AI 剪口播');
    expect(out[1]).toBe(shots[1]);
    expect(JSON.stringify(shots)).toBe(snapshot);
  });
  it('第一个镜头不是全屏素材（钩子卡、人像、画中画、素材缺失降级为全屏）：原样返回', () => {
    const hook0: Shot = { ...hookCard('三个习惯'), start: 0, end: 3 };
    const pip: Shot = { ...brollShot(0, 3), layout: 'pip' };
    const missing: Shot = { start: 0, end: 3, layout: 'broll' };
    for (const first of [hook0, pip, missing, { start: 0, end: 3, layout: 'full' } as Shot]) {
      const shots = [first, { start: 3, end: 6, layout: 'full' } as Shot];
      expect(withOpeningHook(shots, caps, undefined)).toBe(shots);
    }
  });
  it('第一个镜头只在素材之后才有的情况：第一个全屏素材不在开头时不叠', () => {
    const shots: Shot[] = [{ start: 0, end: 3, layout: 'full' }, brollShot(3, 6)];
    expect(withOpeningHook(shots, caps, undefined)).toBe(shots);
  });
  it('没有可用文字时原样返回', () => {
    const shots = [brollShot(0, 3)];
    expect(withOpeningHook(shots, [], undefined)).toBe(shots);
  });
});
