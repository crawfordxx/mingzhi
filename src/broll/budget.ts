import type { CostMeter } from '../cost/meter.js';

/** B-roll 全流程（规划、审片、主体定位、联网搜索、兜底生图、图生视频）每 2 分钟片的目标花费 */
export const BROLL_YUAN_PER_2MIN = 4;
/** 很短的片子也给够一次规划 + 几次审片 */
const MIN_CAP_YUAN = 1;

/** 单次调用的预估花费（元），用于发起前的预算检查 */
export const EST_YUAN = {
  plan: 0.05,
  gaps: 0.02,
  score: 0.06,
  focal: 0.04,
  search: 0.05,
  image: 0.2,
  video: 2.4,
} as const;

/** 按片长算 B-roll 的花费上限：每 2 分钟 ¥4，最少 ¥1 */
export function brollCapYuan(durationSec: number): number {
  return Math.max(MIN_CAP_YUAN, Math.round(BROLL_YUAN_PER_2MIN * (durationSec / 120) * 100) / 100);
}

export interface BrollBudget {
  /** 再花 estimate 元是否仍在预算内：项目预算（含给后续步骤的预留）与 B-roll 上限都要满足 */
  canAfford(estimate: number): boolean;
  /** B-roll 步骤开始以来的花费（有 meter 时以 meter 为准，否则按 note 记下的付费调用累计） */
  spent(): number;
  /** 没有 meter 时记下一笔付费调用（有 meter 时由客户端自动记账，这里不重复记） */
  note(yuan: number): void;
  readonly capYuan: number;
}

export interface BudgetOptions {
  meter?: CostMeter;
  /** 没有 meter 时的整步预算 */
  budgetYuan: number;
  /** 给后续步骤（封面）预留的花费 */
  reserveYuan?: number;
  capYuan: number;
}

/** 预算检查：有 meter 时读它（含前面步骤已花的钱），B-roll 自己的花费按 meter 的增量算 */
export function makeBudget(opts: BudgetOptions): BrollBudget {
  const reserve = opts.reserveYuan ?? 0;
  const start = opts.meter?.total ?? 0;
  let local = 0;
  const spent = (): number => (opts.meter ? opts.meter.total - start : local);
  return {
    capYuan: opts.capYuan,
    spent,
    note: (yuan) => { if (!opts.meter) local += yuan; },
    canAfford: (estimate) => {
      const project = opts.meter ? opts.meter.canSpend(estimate + reserve) : local + estimate + reserve <= opts.budgetYuan + 1e-9;
      return project && spent() + estimate <= opts.capYuan + 1e-9;
    },
  };
}
