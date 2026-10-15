/** 最左 Spaces 栏：项目即 ego 的 Space，带油画缩略图；悬停飞出全名与状态 */
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { spentOf, type Space } from '../api';
import { yuan } from '../lib/media';
import { Ico, SOFT, SPRING, Tap } from '../ui';

export const ART = ['/art/01-studio.webp', '/art/02-garden.webp', '/art/03-cinema.webp'];

/** 项目没有成片缩略图前，按 id 稳定地分到一幅油画 */
export const artFor = (id: string): string => ART[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % ART.length];

const shortName = (title: string): string => {
  const ep = title.match(/第\s*(\d+)\s*期/);
  if (ep) return `第${ep[1]}期`;
  const t = title.replace(/\s/g, '');
  return t.length > 4 ? `${t.slice(0, 3)}…` : t;
};

function metaOf(space: Space): string {
  const last = space.versions.at(-1);
  if (!last) return space.inputs.length ? `草稿 · ${space.inputs.length} 段口播` : '草稿 · 还没有口播';
  const state = last.status === 'running' ? '出片中' : last.status === 'failed' ? '失败' : '已完成';
  return `v${last.n} ${state} · 已花 ${yuan(spentOf(space))}`;
}

interface Props { spaces: Space[]; currentId?: string; onSelect: (id: string) => void; onNew: () => void }

export function SpacesRail({ spaces, currentId, onSelect, onNew }: Props) {
  const [hover, setHover] = useState<string>();
  return (
    <nav className="rail" aria-label="Spaces">
      <motion.div className="mark" title="明知AI剪辑" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING}>明</motion.div>
      <div className="rail-cap">Spaces</div>
      <div className="rail-list">
        {spaces.map((s, i) => {
          const on = s.id === currentId;
          return (
            <motion.button key={s.id} className={`space${on ? ' on' : ''}`} onClick={() => onSelect(s.id)} aria-current={on ? 'page' : undefined}
              onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(undefined)} onFocus={() => setHover(s.id)} onBlur={() => setHover(undefined)}
              initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ ...SOFT, delay: 0.08 + i * 0.05 }} whileTap={{ scale: 0.95 }}>
              <span className="th-wrap">
                {on && <motion.span layoutId="space-ring" className="th-ring" transition={SPRING} />}
                <motion.span className="th" style={{ backgroundImage: `url('${artFor(s.id)}')` }} whileHover={{ y: -1 }} transition={SPRING} />
              </span>
              <span className="nm">{shortName(s.title)}</span>
              <AnimatePresence>
                {hover === s.id && (
                  <motion.span className="fly" role="tooltip" initial={{ opacity: 0, x: -6, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -4 }} transition={{ duration: 0.16 }}>
                    {s.title}<small>{metaOf(s)}</small>
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </div>
      <Tap className="rail-new" aria-label="新建一期" title="新建一期" onClick={onNew}>{Ico.plus}</Tap>
    </nav>
  );
}
