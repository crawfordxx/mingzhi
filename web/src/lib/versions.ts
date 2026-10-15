/**
 * 版本的身份与文案（纯函数）：
 * - 首版 = 没有父版本的版本（首版失败或取消后重开，真正的首版可能是 v2、v3），不再用 n === 1 判断
 * - 本版改动：服务端按和父版本逐镜头的内容比较给出 changedShots（与是否命中渲染缓存无关）
 * - 项目预算：上限管整个项目（各版本 + 对话规划）
 */
import type { Space, VersionMeta } from '../api';
import type { QaScore } from './liveModel';

export const isFirst = (v: Pick<VersionMeta, 'parent'>): boolean => v.parent === undefined;

/** 第一个完成的首版 */
export const firstDone = (space: Space): VersionMeta | undefined => space.versions.find((v) => isFirst(v) && v.status === 'done');

/** 失败或取消的版本 */
export const failedVersions = (space: Space): VersionMeta[] => space.versions.filter((v) => v.status === 'failed');

/**
 * 剪辑直播卡跟随的版本：出过首版就是首版；还没有时，正在排队或运行的任务一定是首版尝试（修改要有完成的父版本），
 * 没有任务时取最后一次首版尝试（失败的那次，卡上显示原因）。
 */
export function liveVersionOf(space: Space): number | undefined {
  const done = firstDone(space);
  if (done) return done.n;
  if (space.job) return space.job.version;
  return space.versions.filter(isFirst).at(-1)?.n;
}

/** 版本卡、预览标题里的旁注：首版 / 回退 / 和上一版相比改了几段 */
export function changedLabel(meta: VersionMeta, totalShots?: number): string {
  if (isFirst(meta)) return '首版';
  if (/^回退到/.test(meta.summary)) return meta.summary;
  const k = meta.changedShots.length;
  if (k === 0) return '画面没有变化';
  if (totalShots && k >= totalShots) return '每段都变了';
  return `改了 ${k} 段`;
}

/** 接近上限的比例 */
export const NEAR_RATIO = 0.8;

export interface BudgetState { ratio: number; near: boolean; over: boolean }

/** 项目已花与上限：≥ 80% 提示接近上限 */
export function budgetState(spent: number, budget: number): BudgetState {
  const ratio = budget > 0 ? Math.round((spent / budget) * 100) / 100 : 1;
  return { ratio, near: ratio >= NEAR_RATIO, over: spent > budget + 1e-9 };
}

const avg = (q: QaScore): number => (q.layout + q.hierarchy + q.motion + q.brand) / 4;

/**
 * 第 n 版第 i 镜的自检分：本版打过分用本版；否则往前找「同一张卡」（卡片内容相同）的分数。
 * 不按镜头序号沿用：节奏、删段之后序号对应的已经是另一张卡。
 * versions 为完成的版本号（升序）；qaOf 给某版本按镜头序号的分数；cardsOf 给某版本各镜头的卡片内容键（全屏为 undefined）。
 */
export function shotScore(n: number, i: number, versions: number[], qaOf: (n: number) => Record<number, QaScore>, cardsOf: (n: number) => (string | undefined)[]): number | undefined {
  const own = qaOf(n)[i];
  if (own) return avg(own);
  const key = cardsOf(n)[i];
  if (key === undefined) return undefined;
  for (const k of versions.filter((x) => x < n).reverse()) {
    const at = cardsOf(k).indexOf(key);
    const q = at >= 0 ? qaOf(k)[at] : undefined;
    if (q) return avg(q);
  }
  return undefined;
}
