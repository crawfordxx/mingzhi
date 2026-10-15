/** 字幕样式（6 个，衬在所选背景上预览）与封面风格（10 张示例图，横向滑动） */
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptionOption, CoverOption } from '../../api';
import { Ico, It, SPRING } from '../../ui';
import { CaptionSample } from './CaptionSample';

interface CapProps { options: CaptionOption[]; value: string; backdrop?: string; onChange: (id: string) => void }

export function CaptionPicker({ options, value, backdrop, onChange }: CapProps) {
  return (
    <div className="cap-grid" aria-label="字幕样式">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <motion.button key={o.id} type="button" aria-pressed={on} className={`capt${on ? ' on' : ''}`} onClick={() => onChange(o.id)}
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

/** 横条：两端圆形箭头翻页；鼠标竖向滚轮在条上时改为横向滚动（到头后交还给对话流） */
function useHScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const sync = useCallback(() => {
    const el = ref.current;
    if (el) setEdge({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const canMove = e.deltaY > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0;
      if (!canMove) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    sync();
    return () => el.removeEventListener('wheel', onWheel);
  }, [sync]);
  return { ref, edge, sync };
}

export function CoverPicker({ options, value, onChange }: CoverProps) {
  const { ref, edge, sync } = useHScroll();
  const reduce = useReducedMotion();
  const behavior: ScrollBehavior = reduce ? 'auto' : 'smooth';
  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior });
  return (
    <div className={`cover-wrap${edge.start ? ' at-start' : ''}${edge.end ? ' at-end' : ''}`}>
      <div className="cover-row" ref={ref} onScroll={sync} aria-label="封面风格">
        {options.map((o, i) => {
          const on = o.id === value;
          return (
            <motion.button key={o.id} type="button" aria-pressed={on} className={`covt${on ? ' on' : ''}`}
              onClick={(e) => { onChange(o.id); e.currentTarget.scrollIntoView({ behavior, inline: 'nearest', block: 'nearest' }); }}
              whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }} transition={SPRING}>
              <span className="covt-im">
                <img src={o.example} alt={`${o.name}风格示例封面`} loading="lazy" draggable={false} />
                <It className="covt-i">{String(i + 1).padStart(2, '0')}</It>
                {on && <motion.span layoutId="cover-ring" className="sel-ring" transition={SPRING} />}
              </span>
              <span className="covt-nm" title={o.name}>{o.name}</span>
            </motion.button>
          );
        })}
      </div>
      <button type="button" className="cov-arrow prev" onClick={() => page(-1)} disabled={edge.start} aria-label="上一组封面风格">{Ico.chevL}</button>
      <button type="button" className="cov-arrow next" onClick={() => page(1)} disabled={edge.end} aria-label="下一组封面风格">{Ico.chevR}</button>
    </div>
  );
}
