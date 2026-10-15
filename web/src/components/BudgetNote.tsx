/** 接近项目上限（≥ 80%）时，输入框上方的一行提示：「已接近上限 ¥y，请在设置里调高上限」，可就地展开上限滑块 */
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { yuan } from '../lib/media';
import { budgetState } from '../lib/versions';
import { SOFT } from '../ui';
import { BudgetEditor } from './setup/BudgetEditor';

interface Props { spent: number; budget: number; onSave: (v: number) => void }

export function BudgetNote({ spent, budget, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const { near, over } = budgetState(spent, budget);
  return (
    <AnimatePresence initial={false}>
      {near && (
        <motion.div className="lim-note" role="status"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={SOFT}>
          <div className="lim-row">
            <span className="lim-t">
              本项目已花 <b>{yuan(spent)}</b> / 上限 ¥{budget}
              <span className="dot">·</span>{over ? '已超上限' : `已接近上限 ¥${budget}`}，请在设置里调高上限
            </span>
            <button type="button" className="lim-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? '收起' : '调高上限'}</button>
          </div>
          {open && <BudgetEditor spent={spent} budget={budget} onSave={onSave} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
