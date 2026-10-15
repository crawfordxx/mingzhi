/**
 * 假数据层（?mock=1）只在 vite 开发服务或构建时显式开启（VITE_MOCK=1）才可用：
 * 正式构建里地址栏参数不起作用，免得界面换成内存假数据、和真实项目难以区分。
 */
export interface MockGate { allowed: boolean; forced: boolean; search: string }

export function mockEnabled({ allowed, forced, search }: MockGate): boolean {
  if (!allowed) return false;
  return forced || new URLSearchParams(search).get('mock') === '1';
}
