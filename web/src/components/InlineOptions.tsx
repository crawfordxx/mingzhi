/**
 * AI 回复里的内联选项胶囊：点一个就执行（调用 apply）。
 * 执行中：所选胶囊里转圈、其余变淡；完成后所选胶囊留下勾与蓝环，旁边写「已选 A · … → v2」。
 */
import { AnimatePresence, motion } from 'motion/react';
import type { EditOption } from '../api';
import { Ico, It, SPRING } from '../ui';

interface Props {
  options: EditOption[];
  picked?: number;
  applying?: boolean;
  applied?: number;
  /** 另一个任务在跑时不能点 */
  disabled?: boolean;
  /** 刷新前提交状态不明：锁住，不允许再点 */
  unsure?: boolean;
  onPick: (index: number) => void;
}

const LETTER = 'ABCDEFGH';

export function InlineOptions({ options, picked, applying, applied, disabled, unsure, onPick }: Props) {
  const locked = applying || applied !== undefined || !!unsure;
  return (
    <div className="iopts">
      <div className="iopts-row" role="group" aria-label="可选方案">
        {options.map((o, i) => {
          const on = picked === i;
          return (
            <motion.button key={o.label} type="button" className={`iopt${on ? ' on' : ''}${locked && !on ? ' off' : ''}`}
              disabled={disabled || locked} aria-pressed={on} onClick={() => onPick(i)}
              initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: locked && !on ? 0.45 : 1, y: 0, scale: 1 }}
              transition={{ ...SPRING, delay: 0.08 + i * 0.06 }} whileHover={locked || disabled ? undefined : { y: -2 }} whileTap={locked || disabled ? undefined : { scale: 0.96 }}>
              <It l className="iopt-k">{LETTER[i]}</It>
              <span>{o.label}</span>
              <AnimatePresence mode="popLayout" initial={false}>
                {on && (applying ? <motion.span key="s" className="spin iopt-s" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} />
                  : <motion.span key="c" className="iopt-c" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SPRING}>{Ico.check}</motion.span>)}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </div>
      <AnimatePresence>
        {picked !== undefined && picked >= 0 && (
          <motion.p className="picked" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
            已选 <b>{LETTER[picked]} · {options[picked]?.label}</b>
            {applying ? <> · 正在排队出新版本…</> : applied !== undefined ? <> · 出 <It l>v{applied}</It></> : null}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
