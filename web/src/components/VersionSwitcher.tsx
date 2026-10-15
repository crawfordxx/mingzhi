/**
 * 顶部版本切换：v1/v2/v3 分段胶囊（白色滑块用 layoutId 滑过去）+ 对比开关；正在出的版本带脉冲点、不可点；
 * 失败或取消的版本灰色带「失败」，点了只提示原因，不能预览、也不作为对比或修改的基础。
 */
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
  /** 失败版本的原因（来自它的 failed 事件） */
  reasonOf: (n: number) => string | undefined;
}

export function VersionSwitcher({ versions, view, active, onView, compare, canCompare, onCompare, onBusy, reasonOf }: Props) {
  const shown = versions.filter((v) => v.status !== 'running' || v.n === active);
  const click = (v: VersionMeta, running: boolean, failed: boolean) => {
    if (running) onBusy(`v${v.n} 还在出片，完成后可切换`);
    else if (failed) onBusy(`v${v.n} 没有完成：${reasonOf(v.n) ?? '出片失败'}`);
    else onView(v.n);
  };
  return (
    <>
      <div className="seg live" role="tablist" aria-label="版本">
        {shown.map((v) => {
          const running = v.n === active && v.status !== 'done';
          const failed = v.status === 'failed' && !running;
          const cur = v.n === view && !running && !failed;
          return (
            <button key={v.n} type="button" role="tab" aria-selected={cur} aria-disabled={running} className={cur ? 'cur' : failed ? 'failed' : ''}
              title={failed ? `v${v.n} 没有完成：${reasonOf(v.n) ?? '出片失败'}` : undefined} onClick={() => click(v, running, failed)}>
              {cur && <motion.span layoutId="ver-pill" className="pill" transition={SPRING} />}
              {running && <span className="pulse" />}
              <span className="lbl">v{v.n}</span>
              {failed && <span className="fail-tag">失败</span>}
            </button>
          );
        })}
        {active && !shown.some((v) => v.n === active) && (
          <button type="button" aria-disabled="true" onClick={() => onBusy(`v${active} 排队中`)}>
            <span className="pulse" /><span className="lbl">v{active}</span>
          </button>
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
