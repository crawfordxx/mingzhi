/** @mm:ss 卡片名 浅蓝胶囊：输入框标签（可移除）、对话气泡、对比提示里都用它；另有暂停时的「插入」按钮 */
import { AnimatePresence, motion } from 'motion/react';
import { mmss, type TimeRef } from '../lib/shots';
import { Ico, SPRING } from '../ui';

interface ChipProps { r: TimeRef; onRemove?: () => void; onClick?: () => void; title?: string }

export function TimeRefChip({ r, onRemove, onClick, title }: ChipProps) {
  const body = <>@{mmss(r.sec)}{r.label ? <span className="ref-nm">{r.label}</span> : null}</>;
  return (
    <span className={`hl ref${onClick ? ' click' : ''}`} title={title}>
      {onClick ? <button type="button" onClick={onClick} aria-label={`跳到 ${mmss(r.sec)}`}>{body}</button> : body}
      {onRemove && <button type="button" className="ref-x" aria-label={`移除 @${mmss(r.sec)}`} onClick={onRemove}>{Ico.close}</button>}
    </span>
  );
}

/** 预览暂停时出现在输入框左下：「插入 @00:07 数字卡」 */
export function InsertRef({ r, onInsert }: { r?: TimeRef; onInsert: (r: TimeRef) => void }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {r && (
        <motion.button key={`${r.sec}-${r.label}`} type="button" className="ref-insert" onClick={() => onInsert(r)}
          initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -4, filter: 'blur(2px)' }}
          transition={{ ...SPRING, filter: { duration: 0.2, ease: 'easeOut' } }} whileTap={{ scale: 0.96 }}>
          {Ico.plus}插入 <span className="hl ref sm">@{mmss(r.sec)}<span className="ref-nm">{r.label}</span></span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
