/** 顶部版本切换：v1/v2/v3 分段胶囊（白色滑块用 layoutId 滑过去）+ 对比开关；正在出的版本带脉冲点、不可点 */
import { motion } from 'motion/react';
import type { VersionMeta } from '../api';
import { SPRING } from '../ui';

interface Props {
  versions: VersionMeta[];
  view?: number;
  active?: number;
  onView: (n: number) => void;
  compare: boolean;
  canCompare: boolean;
  onCompare: (on: boolean) => void;
  onBusy: (msg: string) => void;
}

export function VersionSwitcher({ versions, view, active, onView, compare, canCompare, onCompare, onBusy }: Props) {
  const shown = versions.filter((v) => v.status === 'done' || v.n === active);
  return (
    <>
      <div className="seg live" role="tablist" aria-label="版本">
        {shown.map((v) => {
          const running = v.n === active && v.status !== 'done';
          const cur = v.n === view && !running;
          return (
            <button key={v.n} type="button" role="tab" aria-selected={cur} aria-disabled={running} className={cur ? 'cur' : ''}
              onClick={() => (running ? onBusy(`v${v.n} 还在出片，完成后可切换`) : onView(v.n))}>
              {cur && <motion.span layoutId="ver-pill" className="pill" transition={SPRING} />}
              {running && <span className="pulse" />}
              <span className="lbl">v{v.n}</span>
            </button>
          );
        })}
        {active && !shown.some((v) => v.n === active) && (
          <button type="button" aria-disabled="true" onClick={() => onBusy(`v${active} 排队中`)}><span className="pulse" /><span className="lbl">v{active}</span></button>
        )}
      </div>
      <button type="button" className={`sw${compare ? ' on' : ''}`} onClick={() => (canCompare ? onCompare(!compare) : onBusy('有两个版本后才能对比'))}
        aria-pressed={compare} aria-disabled={!canCompare} title={canCompare ? '左右同步播放两个版本' : '有两个版本后才能对比'}>
        对比
        <span className="tr2"><motion.span layout className="kn" transition={SPRING} /></span>
      </button>
    </>
  );
}
