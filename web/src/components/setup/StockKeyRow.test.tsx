import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StockKeyRow, STOCK_HELP } from './StockKeyRow';

const render = (props: Partial<Parameters<typeof StockKeyRow>[0]> = {}): string =>
  renderToStaticMarkup(<StockKeyRow provider="pexels" info={{ configured: false }} onSave={vi.fn()} onRemove={vi.fn()} {...props} />);

describe('图库 key 行', () => {
  it('未配置：输入框 + 注册链接 + 校验按钮', () => {
    const html = render();
    expect(html).toContain('Pexels');
    expect(html).toContain('href="https://www.pexels.com/api/"');
    expect(html).toContain('type="password"');
    expect(html).toContain('校验并保存');
  });

  it('Pixabay 的注册链接', () => {
    expect(render({ provider: 'pixabay' })).toContain('href="https://pixabay.com/api/docs/"');
  });

  it('已配置：显示末 4 位与存放位置，没有输入框，可移除', () => {
    const html = render({ info: { configured: true, source: 'keychain', masked: '…cdef' } });
    expect(html).toContain('…cdef');
    expect(html).toContain('系统钥匙串');
    expect(html).toContain('移除');
    expect(html).not.toContain('type="password"');
  });

  it('环境变量来源不能在界面移除', () => {
    const html = render({ info: { configured: true, source: 'env', masked: '…cdef' } });
    expect(html).toContain('MINGZHI_PEXELS_KEY');
    expect(html).not.toContain('>移除<');
  });

  it('一句说明与注册链接常量', () => {
    expect(STOCK_HELP).toBe('填了就能用实拍视频空镜，不填也能出片');
  });
});
