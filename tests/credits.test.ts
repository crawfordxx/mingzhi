import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributionText, writeCredits, type CreditEntry } from '../src/broll/credits.js';

const entry = (over: Partial<CreditEntry> = {}): CreditEntry => ({
  file: 'broll/a.mp4', source: 'pexels', page: 'https://www.pexels.com/video/1/', author: 'Ann', license: 'Pexels License',
  licenseUrl: 'https://www.pexels.com/license/', attributionRequired: false, aiGenerated: false, modified: ['crop'], query: 'office', fetchedAt: '2026-10-16T00:00:00.000Z', ...over,
});

describe('writeCredits', () => {
  it('写 <dir>/credits.json，内容可原样读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cr-'));
    const entries = [entry(), entry({ file: 'broll/b.jpg', source: 'generated', aiGenerated: true, license: 'AI 生成', author: undefined })];
    const path = writeCredits(join(dir, 'proj'), entries);
    expect(path).toBe(join(dir, 'proj', 'credits.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(entries)));
  });
});

describe('attributionText', () => {
  it('Pexels 与 Wikimedia CC BY 署名，附 AI 生成说明', () => {
    const text = attributionText([
      entry(),
      entry({ file: 'b', source: 'wikimedia', author: 'Eve', license: 'CC BY 4.0', attributionRequired: true, page: 'https://commons.wikimedia.org/wiki/File:B.jpg' }),
      entry({ file: 'c', source: 'generated', aiGenerated: true, license: 'AI 生成', author: undefined }),
    ]);
    expect(text).toBe('素材：Pexels @Ann、Wikimedia Commons（CC BY 4.0）@Eve；部分画面为 AI 生成');
  });

  it('同来源多作者合并去重；同一素材来源不同许可分开写', () => {
    const text = attributionText([
      entry({ author: 'Ann' }), entry({ file: 'x', author: 'Bob' }), entry({ file: 'y', author: 'Ann' }),
      entry({ file: 'w1', source: 'wikimedia', author: 'Eve', license: 'CC BY 4.0', attributionRequired: true }),
      entry({ file: 'w2', source: 'wikimedia', author: 'Fay', license: 'CC0' }),
    ]);
    expect(text).toBe('素材：Pexels @Ann、@Bob、Wikimedia Commons（CC BY 4.0）@Eve、Wikimedia Commons（CC0）@Fay');
  });

  it('Pixabay 无作者时只写来源；截图写出处域名', () => {
    const text = attributionText([
      entry({ source: 'pixabay', author: undefined, license: 'Pixabay Content License' }),
      entry({ file: 's', source: 'screenshot', page: 'https://openai.com/index/x', author: undefined, license: '引用' }),
    ]);
    expect(text).toBe('素材：Pixabay；部分画面截自 openai.com');
  });

  it('只有 AI 生成；空列表返回空串', () => {
    expect(attributionText([entry({ source: 'generated', aiGenerated: true, author: undefined })])).toBe('部分画面为 AI 生成');
    expect(attributionText([])).toBe('');
  });
});
