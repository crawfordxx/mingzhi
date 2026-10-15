/**
 * 项目级预算（DECISIONS 第 8 条「每条视频默认上限 ¥10」）：上限管整个项目，出片的各个版本与对话规划共用。
 * 接口在开始花钱之前按剩余额度把关；运行器给每个版本的计费器上限 = 剩余额度。
 */
import { BG_PROMPT_YUAN, COVER_YUAN, IMAGE_YUAN } from '../cost/estimate.js';
import { roundYuan } from '../cost/meter.js';
import { stagesFor } from '../edit/apply.js';
import type { EditOp } from '../edit/plan.js';
import { projectSpentYuan, type Space } from '../workspace/store.js';
import { HttpError } from './http.js';

export const remainingYuan = (space: Space): number => Math.max(0, roundYuan(space.settings.budgetYuan - projectSpentYuan(space)));

/** 这批修改至少要花的钱：一句话背景要生图、换封面风格要重做封面、要取素材的卡片至少生一张图；其余修改只在本机渲染 */
export function opsYuan(ops: EditOp[]): number {
  const one = (op: EditOp): number => {
    if (op.type === 'setBackground') return op.spec.kind === 'prompt' ? BG_PROMPT_YUAN : 0;
    if (op.type === 'setCoverStyle') return COVER_YUAN;
    return stagesFor([op]).has('broll') ? IMAGE_YUAN : 0;
  };
  return roundYuan(ops.reduce((s, op) => s + one(op), 0));
}

/** 剩余额度不够 needYuan 时拒绝（402），提示去设置里调高上限 */
export function requireBudget(space: Space, needYuan: number, what: string): void {
  if (needYuan <= 0) return;
  const left = remainingYuan(space);
  if (left + 1e-9 >= needYuan) return;
  const spent = projectSpentYuan(space).toFixed(2);
  throw new HttpError(402, `已接近上限 ¥${roundYuan(space.settings.budgetYuan)}，请在设置里调高上限（本项目已花 ¥${spent}，${what}约需 ¥${needYuan.toFixed(2)}）`);
}
