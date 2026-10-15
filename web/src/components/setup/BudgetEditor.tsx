/**
 * 出片后调项目上限：一行滑块 + 数值（松手或抬键保存）。上限管整个项目（各版本 + 对话规划），
 * 滑块下限不低于已花，上限随已花往上放宽，总能调高。
 */
import { useEffect, useState } from 'react';
import { yuan } from '../../lib/media';
import { BUDGET_MAX, BUDGET_MIN } from './BudgetFooter';

interface Props { spent: number; budget: number; onSave: (v: number) => void }

export function BudgetEditor({ spent, budget, onSave }: Props) {
  const min = Math.max(BUDGET_MIN, Math.ceil(spent));
  const max = Math.max(BUDGET_MAX, Math.ceil(spent) + 20, Math.ceil(budget));
  const [local, setLocal] = useState(budget);
  useEffect(() => setLocal(budget), [budget]);
  const pct = `${((Math.min(max, Math.max(min, local)) - min) / Math.max(1, max - min)) * 100}%`;
  const save = () => { if (local !== budget) onSave(local); };
  return (
    <div className="bud-row bud-edit">
      <label className="bud-k" htmlFor="budget-edit">本项目上限</label>
      <div className="bud-track" style={{ ['--v' as string]: pct }}>
        <input id="budget-edit" type="range" min={min} max={max} step={1} value={Math.max(min, local)}
          onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={save} onKeyUp={save} aria-valuetext={`上限 ${local} 元，已花 ${yuan(spent)}`} />
      </div>
      <span className="bud-v">¥{local}</span>
    </div>
  );
}
