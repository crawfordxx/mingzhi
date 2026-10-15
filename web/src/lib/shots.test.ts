import { describe, expect, it } from 'vitest';
import { cardName, composeMessage, mmss, refSecond, shotIndexAt, splitMessage } from './shots';

describe('镜头与 @ 引用', () => {
  it('卡片名不含空格（引用才不会被拆开）', () => {
    expect(cardName({ layout: 'full' })).toBe('纯人像');
    expect(cardName({ layout: 'split', card: { template: 'hook', props: { index: 2, total: 3 } } })).toBe('钩子卡2/3');
    expect(cardName({ layout: 'split', template: 'cta' })).toBe('三连CTA');
  });

  it('按时间找镜头：左闭右开，越界取首尾', () => {
    const shots = [{ start: 0, end: 3 }, { start: 3, end: 7.2 }];
    expect([shotIndexAt(shots, 0), shotIndexAt(shots, 3), shotIndexAt(shots, 99), shotIndexAt([], 1)]).toEqual([0, 1, 1, -1]);
  });

  it('引用的整秒夹进该镜头（29.03 开始的镜头，29.5 秒时引用 @00:30）', () => {
    expect(refSecond(29.5, { start: 29.03, end: 32.67 })).toBe(30);
    expect(refSecond(31.2, { start: 29.03, end: 32.67 })).toBe(31);
    expect(refSecond(4.2)).toBe(4);
  });

  it('消息里每个引用后带一个空格，能拆回来', () => {
    const msg = composeMessage([{ sec: 58, label: '对比条卡' }, { sec: 4, label: '钩子卡2/3' }], '  数据太弱 ');
    expect(msg).toBe('@00:58 对比条卡 @00:04 钩子卡2/3 数据太弱');
    expect(splitMessage(msg)).toEqual({ refs: [{ sec: 58, label: '对比条卡' }, { sec: 4, label: '钩子卡2/3' }], text: '数据太弱' });
    expect(mmss(125.9)).toBe('02:05');
  });
});
