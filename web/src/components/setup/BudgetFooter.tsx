/** 设置卡底栏：预算滑块（轨道上标出预估区间）+ 预估花费（数字滚动）+ 明细 +「开始出片」黑胶囊 */
import { AnimatePresence, motion, useSpring, useTransform } from 'motion/react';
import { useEffect, useState } from 'react';
import type { Estimate } from '../../api';
import { yuan } from '../../lib/media';
import { Ico, It, SOFT, Tap } from '../../ui';

export const BUDGET_MIN = 3;
export const BUDGET_MAX = 30;

function Num({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 180, damping: 26 });
  useEffect(() => { spring.set(value); }, [spring, value]);
  const text = useTransform(spring, (v) => v.toFixed(2));
  return <motion.span>{text}</motion.span>;
}

interface Props {
  budget: number;
  estimate?: Estimate;
  estimating: boolean;
  blocker?: string;
  starting: boolean;
  onBudget: (v: number) => void;
  onStart: () => void;
}

const pct = (v: number) => `${((Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, v)) - BUDGET_MIN) / (BUDGET_MAX - BUDGET_MIN)) * 100}%`;

export function BudgetFooter({ budget, estimate, estimating, blocker, starting, onBudget, onStart }: Props) {
  const [local, setLocal] = useState(budget);
  const [open, setOpen] = useState(false);
  useEffect(() => setLocal(budget), [budget]);
  const has = !!estimate && estimate.high > 0;
  const over = has && estimate.high > local;

  return (
    <motion.div className="box budget" layout transition={SOFT} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
      <div className="bud-row">
        <label className="bud-k" htmlFor="budget">预算上限</label>
        <div className="bud-track" style={{ ['--v' as string]: pct(local) }}>
          {has && <motion.span className={`bud-band${over ? ' over' : ''}`} initial={false} animate={{ left: pct(estimate.low), width: `calc(${pct(estimate.high)} - ${pct(estimate.low)})` }} transition={SOFT} />}
          <input id="budget" type="range" min={BUDGET_MIN} max={BUDGET_MAX} step={1} value={local}
            onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={() => local !== budget && onBudget(local)}
            onKeyUp={() => local !== budget && onBudget(local)} aria-valuetext={`上限 ${local} 元`} />
        </div>
        <span className="bud-v">¥{local}</span>
      </div>
      <div className="est-row">
        <div className="est">
          <span className="est-k">预估花费{estimating && <span className="spin est-spin" />}</span>
          <span className="est-v">
            {has ? <>¥<Num value={estimate.low} /><span className="est-dash">–</span><Num value={estimate.high} /></> : <span className="est-none">¥—</span>}
            {has && <button type="button" className="est-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? '收起' : '明细'}</button>}
          </span>
          <span className={`est-note${over ? ' warn' : ''}`} title={over ? '超出上限时不用 Seedance 视频，必要时少生图' : undefined}>
            {!has ? '放入口播后自动估算' : over ? '可能超上限，将自动降级' : <It l>(都在上限以内)</It>}
          </span>
        </div>
        <div className="go">
          <Tap className="btn btn-k go-btn" disabled={!!blocker || starting} onClick={onStart}>
            {starting ? <span className="spin" /> : Ico.play}开始出片
          </Tap>
          <span className="go-note">{blocker ?? <It l>(只在需要时扣费)</It>}</span>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && has && (
          <motion.ul className="est-items" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SOFT}>
            {estimate.items.map((i) => (
              <li key={i.label}><span>{i.label}</span><b>{i.low === i.yuan ? yuan(i.yuan) : `${yuan(i.low)}–${yuan(i.yuan)}`}</b></li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
