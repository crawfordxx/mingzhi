import { describe, expect, it } from 'vitest';
import { exportNotice } from './exportNotice';

const out = { dir: '/x', files: ['/x/演示-v2.mp4', '/x/演示-v2-封面3x4.png'] };

describe('导出提示', () => {
  it('有署名文本：提供复制', () => {
    expect(exportNotice({ ...out, attribution: 'Pexels @Ann' }, '~/Downloads')).toEqual({ text: '已导出 2 个文件到「~/Downloads」 · 演示-v2.mp4', action: 'copy' });
  });

  it('没有署名文本也没有错误：只有一句话', () => {
    expect(exportNotice(out, '~/Downloads').action).toBeUndefined();
  });

  it('署名记录读取失败：明确警告，不能静默', () => {
    const n = exportNotice({ ...out, attributionError: '素材来源记录读取失败，请在素材来源面板检查署名' }, '~/Downloads');
    expect(n.text).toContain('素材来源记录读取失败，请在素材来源面板检查署名');
    expect(n.action).toBe('ack');
  });

  it('警告优先于署名文本', () => {
    expect(exportNotice({ ...out, attribution: 'x', attributionError: '读取失败' }, 'd').action).toBe('ack');
  });
});
