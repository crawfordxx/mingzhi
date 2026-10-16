import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CreditItem, Credits } from '../api';
import { CreditsPanel, type CreditsView } from './CreditsPanel';

const item = (over: Partial<CreditItem> = {}): CreditItem => ({
  file: 'office.mp4', kind: 'video', source: 'pexels', page: 'https://www.pexels.com/video/1/', author: 'Ann', authorUrl: 'https://www.pexels.com/@ann',
  license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', attributionRequired: false, aiGenerated: false, modified: ['crop', 'lut'],
  query: 'office', thumb: '/api/t/office.mp4', ...over,
});
const ccBy = item({ file: 'server.jpg', kind: 'image', source: 'wikimedia', page: 'https://commons.wikimedia.org/wiki/File:S.jpg', author: 'Eve', license: 'CC BY 4.0', attributionRequired: true, thumb: '/api/t/server.jpg' });
const shot = item({ file: 'shot.png', kind: 'image', source: 'screenshot', page: 'https://news.example.com/a', author: undefined, license: '网页截图', modified: [], thumb: '/api/t/shot.png' });
const ai = item({ file: 'ai.png', kind: 'image', source: 'generated', page: '', author: undefined, license: 'AI 生成', aiGenerated: true, modified: [], thumb: '/api/t/ai.png' });

const ready = (entries: CreditItem[], attribution = ''): CreditsView => ({ kind: 'ready', credits: { entries, attribution } as Credits });
const render = (view: CreditsView, over: Partial<Parameters<typeof CreditsPanel>[0]> = {}): string =>
  renderToStaticMarkup(<CreditsPanel version={2} view={view} onMark={vi.fn()} onCopy={vi.fn()} onClose={vi.fn()} {...over} />);

describe('素材来源面板渲染', () => {
  it('逐条列出：来源、作者、许可、加工项、缩略图、替换与删除', () => {
    const html = render(ready([item(), ccBy, shot, ai], 'Pexels @Ann'));
    expect(html).toContain('素材来源');
    expect(html).toContain('v2');
    expect(html).toContain('共 4 条 · CC BY 1 · 网页截图 1 · AI 生成 1');
    expect(html).toContain('Pexels');
    expect(html).toContain('Ann');
    expect(html).toContain('Pexels License');
    expect(html).toContain('Wikimedia Commons');
    expect(html).toContain('CC BY 4.0');
    expect(html).toContain('裁切');
    expect(html).toContain('调色');
    expect(html).toContain('/api/t/server.jpg');
    expect(html).toContain('<video');
    expect(html.match(/>替换</g)).toHaveLength(4);
    expect(html.match(/>删除</g)).toHaveLength(4);
  });

  it('AI 生成的条目标出「AI 生成」', () => {
    expect(render(ready([ai]))).toContain('AI 生成');
    expect(render(ready([item()]))).not.toContain('cred-chip ai');
  });

  it('有 CC BY 或网页截图才显示对应提示；都没有就没有提示条', () => {
    const both = render(ready([ccBy, shot]));
    expect(both).toContain('CC BY 要求署名');
    expect(both).toContain('只截了页面与标题区');
    const plain = render(ready([item(), ai]));
    expect(plain).not.toContain('要求署名');
    expect(plain).not.toContain('标题区');
    expect(render(ready([ccBy]))).not.toContain('标题区');
    expect(render(ready([shot]))).not.toContain('要求署名');
  });

  it('署名文本与「复制署名文本」只在有署名文本时出现', () => {
    expect(render(ready([item()], 'Pexels @Ann'))).toContain('复制署名文本');
    expect(render(ready([item()], ''))).not.toContain('复制署名文本');
  });

  it('已标记的显示标记状态，当前标记对应的按钮禁用', () => {
    const html = render(ready([item({ mark: 'replace' })]));
    expect(html).toContain('已标记替换');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(render(ready([item()]))).not.toContain('disabled=""');
  });

  it('空列表、加载中、出错', () => {
    expect(render(ready([]))).toContain('这一版没有用到外部素材');
    expect(render({ kind: 'loading' })).toContain('正在读取');
    const err = render({ kind: 'error', message: '素材来源记录已损坏' });
    expect(err).toContain('素材来源记录已损坏');
    expect(err).not.toContain('>替换<');
  });
});
