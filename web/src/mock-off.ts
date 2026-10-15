/** 正式构建里顶替 ./mock（见 vite.config.ts）：假数据层与它的图片都不进 dist */
import type { Api } from './api';

export function createMockApi(): Api {
  throw new Error('正式构建不含假数据层');
}
