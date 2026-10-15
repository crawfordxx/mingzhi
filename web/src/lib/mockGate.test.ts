import { describe, expect, it } from 'vitest';
import { mockEnabled } from './mockGate';

describe('?mock=1 只在开发或显式构建时可用', () => {
  it('正式构建（未允许）时忽略地址栏参数', () => {
    expect(mockEnabled({ allowed: false, forced: false, search: '?mock=1' })).toBe(false);
  });

  it('允许时：地址栏 ?mock=1 或构建时 VITE_MOCK=1 打开', () => {
    expect(mockEnabled({ allowed: true, forced: false, search: '?mock=1' })).toBe(true);
    expect(mockEnabled({ allowed: true, forced: false, search: '?x=1' })).toBe(false);
    expect(mockEnabled({ allowed: true, forced: true, search: '' })).toBe(true);
  });
});
