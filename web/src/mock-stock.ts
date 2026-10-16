/**
 * 假数据层的图库 key 与素材来源（?mock=1）：形状与 src/server/routes-stock.ts、routes-credits.ts 一致。
 * 校验规则只为演示各状态：key 含 bad 判无效，含 net 判暂时无法校验，其余长度 >= 16 通过。缩略图复用背景示例图。
 */
import type { Api, Credits, CreditItem, CreditMark, StockKeys, StockProvider } from './api';
import { ApiError } from './api';

const THUMBS = import.meta.glob<string>('./mock-assets/*.webp', { eager: true, query: '?url', import: 'default' });
const thumb = (name: string): string => THUMBS[`./mock-assets/${name}.webp`] ?? '';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base: Omit<CreditItem, 'file' | 'source' | 'page' | 'license' | 'thumb'> = {
  kind: 'image', attributionRequired: false, aiGenerated: false, modified: ['crop', 'lut'], query: '',
};

const ENTRIES: CreditItem[] = [
  { ...base, file: 'f3a91c.jpg', source: 'pexels', page: 'https://www.pexels.com/photo/3184291/', author: 'Maya Chen', authorUrl: 'https://www.pexels.com/@maya-chen',
    license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', thumb: thumb('09-rooftop'), query: 'team meeting office', shotIndex: 3 },
  { ...base, file: '81be07.jpg', source: 'pixabay', page: 'https://pixabay.com/photos/server-room-1234567/', author: 'Tomas K', authorUrl: 'https://pixabay.com/users/tomask-1/',
    license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/', thumb: thumb('05-tech-dark'), modified: ['crop', 'lut', 'wb'], query: 'server room', shotIndex: 7 },
  { ...base, file: 'c20d4e.jpg', source: 'wikimedia', page: 'https://commons.wikimedia.org/wiki/File:Data_center_corridor.jpg', author: 'Eve Marlow',
    license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attributionRequired: true, thumb: thumb('08-library'), query: 'data center', shotIndex: 11 },
  { ...base, file: '5e77aa.png', source: 'screenshot', page: 'https://news.example.com/2026/10/ai-chip-demand', license: '网页截图', thumb: thumb('02-studio'), modified: [], query: 'AI 芯片 需求', shotIndex: 14 },
  { ...base, file: 'a9120f.png', source: 'generated', page: '', license: 'AI 生成', aiGenerated: true, thumb: thumb('04-night-window'), modified: ['lut'], query: 'quiet night city window' },
];

const ATTRIBUTION = '素材：Pexels @Maya Chen（https://www.pexels.com/@maya-chen）、Pixabay @Tomas K、Wikimedia Commons（CC BY 4.0）@Eve Marlow；部分素材已裁切调色；部分画面截自 news.example.com；部分画面为 AI 生成';

function stockMethods() {
  let keys: StockKeys = { pexels: { configured: false }, pixabay: { configured: false } };
  return {
    async stockKeys() { await wait(80); return structuredClone(keys); },
    async saveStockKey(provider: StockProvider, key: string) {
      await wait(900);
      const k = key.trim();
      if (k.includes('net')) throw new ApiError(`暂时无法校验 ${provider === 'pexels' ? 'Pexels' : 'Pixabay'} key（网络或服务异常），请稍后重试`, 503);
      if (k.includes('bad') || k.length < 16) throw new ApiError(`${provider === 'pexels' ? 'Pexels' : 'Pixabay'} key 无效，请检查是否复制完整，或重新获取`, 400);
      keys = { ...keys, [provider]: { configured: true, source: 'keychain' as const, masked: `…${k.slice(-4)}` } };
      return structuredClone(keys);
    },
    async deleteStockKey(provider: StockProvider) { await wait(100); keys = { ...keys, [provider]: { configured: false } }; },
  };
}

export function withStock(inner: Api): Api {
  const marks = new Map<string, CreditMark>();
  const credits = async (): Promise<Credits> => {
    await wait(120);
    return { entries: ENTRIES.map((e) => ({ ...e, ...(marks.has(e.file) ? { mark: marks.get(e.file) } : {}) })), attribution: ATTRIBUTION };
  };
  return {
    ...inner,
    ...stockMethods(),
    credits,
    async markCredit(_id, _n, file, action) {
      await wait(150);
      if (!ENTRIES.some((e) => e.file === file)) throw new ApiError('这个版本没有用到这条素材', 404);
      marks.set(file, action);
    },
    async exportVersion(id, n) { return { ...(await inner.exportVersion(id, n)), attribution: ATTRIBUTION }; },
  };
}
