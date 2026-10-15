/** 字幕样式（6 个，衬在所选背景上预览）与封面风格（10 张示例图，横向滑动） */
import { motion } from 'motion/react';
import { useRef } from 'react';
import type { CaptionOption, CoverOption } from '../../api';
import { It, SPRING } from '../../ui';
import { CaptionSample } from './CaptionSample';

interface CapProps { options: CaptionOption[]; value: string; backdrop?: string; onChange: (id: string) => void }

export function CaptionPicker({ options, value, backdrop, onChange }: CapProps) {
  return (
    <div className="cap-grid" role="radiogroup" aria-label="字幕样式">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <motion.button key={o.id} type="button" role="radio" aria-checked={on} className={`capt${on ? ' on' : ''}`} onClick={() => onChange(o.id)}
            whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }} transition={SPRING}>
            <span className="capt-pv">
              {backdrop && <img className="capt-bd" src={backdrop} alt="" draggable={false} />}
              <CaptionSample id={o.id} preview={o.preview || undefined} size={15} />
              {on && <motion.span layoutId="cap-ring" className="sel-ring" transition={SPRING} />}
            </span>
            <span className="capt-nm">{o.name}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

interface CoverProps { options: CoverOption[]; value: string; onChange: (id: string) => void }

export function CoverPicker({ options, value, onChange }: CoverProps) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <div className="cover-wrap">
      <div className="cover-row" ref={scroller} role="radiogroup" aria-label="封面风格">
        {options.map((o, i) => {
          const on = o.id === value;
          return (
            <motion.button key={o.id} type="button" role="radio" aria-checked={on} className={`covt${on ? ' on' : ''}`}
              onClick={(e) => { onChange(o.id); e.currentTarget.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' }); }}
              whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }} transition={SPRING}>
              <span className="covt-im">
                <img src={o.example} alt={`${o.name}风格示例封面`} loading="lazy" draggable={false} />
                {on && <motion.span layoutId="cover-ring" className="sel-ring" transition={SPRING} />}
              </span>
              <span className="covt-nm"><It className="covt-i">{String(i + 1).padStart(2, '0')}</It>{o.name}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
