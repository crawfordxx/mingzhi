import { describe, expect, it } from 'vitest';
import type { CreditItem } from '../api';
import { hostOf, isCcBy, markText, modifiedLabels, noticeOf, panelNotices, sourceLabel, summaryOf } from './credits';

const item = (over: Partial<CreditItem> = {}): CreditItem => ({
  file: 'a.mp4', kind: 'video', source: 'pexels', page: 'https://www.pexels.com/video/1/', author: 'Ann', license: 'Pexels License',
  attributionRequired: false, aiGenerated: false, modified: ['crop'], query: 'office', thumb: '/t/a', ...over,
});
const ccBy = item({ file: 'b.jpg', kind: 'image', source: 'wikimedia', license: 'CC BY 4.0', attributionRequired: true });
const shot = item({ file: 'c.png', kind: 'image', source: 'screenshot', page: 'https://news.example.com/a', license: '网页截图', author: undefined });
const ai = item({ file: 'd.png', kind: 'image', source: 'generated', license: 'AI 生成', aiGenerated: true, author: undefined });

describe('提示条件', () => {
  it('CC BY：要求署名的才算；Pexels / Pixabay / CC0 / AI 生成都没有', () => {
    expect(isCcBy(ccBy)).toBe(true);
    expect(isCcBy(item({ source: 'wikimedia', license: 'CC BY-SA 4.0', attributionRequired: false }))).toBe(false);
    expect(isCcBy(item({ source: 'wikimedia', license: 'CC0', attributionRequired: false }))).toBe(false);
    expect(isCcBy(item())).toBe(false);
    expect(isCcBy(ai)).toBe(false);
  });

  it('单条提示：CC BY 提醒署名，网页截图说明只截页面与标题区，其余没有', () => {
    expect(noticeOf(ccBy)).toEqual({ kind: 'ccby', text: expect.stringContaining('署名'), short: expect.stringContaining('署名') });
    expect(noticeOf(shot)).toEqual({ kind: 'screenshot', text: expect.stringContaining('标题区'), short: expect.stringContaining('标题区') });
    expect(noticeOf(item())).toBeUndefined();
    expect(noticeOf(ai)).toBeUndefined();
  });

  it('面板顶部的提示：出现过才显示，每种只一条，先 CC BY 后截图', () => {
    expect(panelNotices([item(), ai])).toEqual([]);
    expect(panelNotices([shot, item(), ccBy, ccBy]).map((n) => n.kind)).toEqual(['ccby', 'screenshot']);
    expect(panelNotices([shot, shot]).map((n) => n.kind)).toEqual(['screenshot']);
  });
});

describe('标签与摘要', () => {
  it('来源名', () => {
    expect(sourceLabel('wikimedia')).toBe('Wikimedia Commons');
    expect(sourceLabel('screenshot')).toBe('网页截图');
    expect(sourceLabel('generated')).toBe('AI 生成');
  });

  it('加工项译成中文并去重；不认识的原样保留；变速带倍数', () => {
    expect(modifiedLabels(['trim', 'speed0.5', 'fps30', 'mute', 'crop', 'lut', 'wb', 'crop'])).toEqual(['截取片段', '慢放 0.5×', '统一 30 帧', '去音轨', '裁切', '调色', '白平衡']);
    expect(modifiedLabels(['zoom'])).toEqual(['zoom']);
    expect(modifiedLabels([])).toEqual([]);
  });

  it('摘要：总数 + 各类数量', () => {
    expect(summaryOf([])).toBe('这一版没有用到外部素材');
    expect(summaryOf([item(), ccBy, shot, ai])).toBe('共 4 条 · CC BY 1 · 网页截图 1 · AI 生成 1');
    expect(summaryOf([item()])).toBe('共 1 条');
  });

  it('标记文案', () => {
    expect(markText('replace')).toContain('替换');
    expect(markText('remove')).toContain('删除');
  });
});

describe('hostOf', () => {
  it('去掉 www.；不是网址原样返回', () => {
    expect(hostOf('https://www.pexels.com/video/1/')).toBe('pexels.com');
    expect(hostOf('https://commons.wikimedia.org/wiki/File:B.jpg')).toBe('commons.wikimedia.org');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
