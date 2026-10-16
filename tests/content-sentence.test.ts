import { describe, expect, it } from 'vitest';
import { contentSentence, isClosingLine } from '../src/compose/content-sentence.js';

const c = (start: number, end: number, text: string) => ({ start, end, text });

describe('isClosingLine：收尾话不承载信息', () => {
  it.each(['记得点赞关注我', '关注我下期见', '感谢观看', '我们下期再见', '三连支持一下'])('%s 是收尾话', (t) => expect(isClosingLine(t)).toBe(true));
  it.each(['都会自动剪掉', '列出明天的清单', '关注点要放在结果上，不要放在过程里面太多太多', '今天聊聊怎么用 AI 剪口播'])('%s 不是收尾话', (t) => expect(isClosingLine(t)).toBe(false));
});

describe('contentSentence：最后一个承载信息的字幕句', () => {
  it('没有字幕返回 undefined', () => expect(contentSentence([])).toBeUndefined());
  it('一句话被停顿切成两行字幕（间隔 ≤ 0.5 秒、合计 ≤ 3 秒）：合并成一个内容句', () => {
    const s = contentSentence([c(0.68, 2.99, '今天聊聊'), c(6.2, 8.18, '现在只要把原片丢进去'), c(8.18, 9.32, '口误和气口它'), c(9.77, 11, '都会自动剪掉')]);
    expect(s).toEqual({ start: 8.18, end: 11 });
  });
  it('三行连续字幕合计不超过 3 秒：合并', () => {
    expect(contentSentence([c(7.085, 8.839, '手机放到另一个房间'), c(9.369, 10.029, '第三个'), c(10.029, 10.869, '每天睡前'), c(10.869, 12.007, '列出明天的清单')])).toEqual({ start: 9.369, end: 12.007 });
  });
  it('间隔超过 0.5 秒或带句末标点就断开', () => {
    expect(contentSentence([c(1, 3, '第一句'), c(4, 6, '第二句')])).toEqual({ start: 4, end: 6 });
    expect(contentSentence([c(1, 3, '第一句。'), c(3.1, 5, '第二句')])).toEqual({ start: 3.1, end: 5 });
  });
  it('一句超长（合计超过 3 秒）时不再往前并：只含放得进 3 秒的尾部', () => {
    expect(contentSentence([c(10, 13, '甲'), c(13.1, 16, '乙'), c(16.1, 19.8, '丙')])).toEqual({ start: 16.1, end: 19.8 });
  });
  it('结尾的收尾话不算内容句：取它之前的内容句', () => {
    expect(contentSentence([c(1, 5.5, '这就是三个关键点'), c(7, 9.5, '记得点赞关注我')])).toEqual({ start: 1, end: 5.5 });
  });
  it('全是收尾话时退回最后一行；字幕乱序也按时间取', () => {
    expect(contentSentence([c(1, 2, '关注我')])).toEqual({ start: 1, end: 2 });
    expect(contentSentence([c(4, 6, '第二句'), c(1, 3, '第一句')])).toEqual({ start: 4, end: 6 });
  });
});
