/**
 * 双版本对比：左右两个 9:16 浮窗共用一个时钟（usePlayback），拖动任一个进度条另一个跟随；
 * 只放新版本的声音。底部白色胶囊写「同步播放 · 只有 N 段不同」，点 @时间 跳过去。
 */
import { AnimatePresence, motion } from 'motion/react';
import type { VersionMeta, VersionState } from '../api';
import type { TimeRef } from '../lib/shots';
import type { Clock } from '../usePlayback';
import { It, SOFT } from '../ui';
import { TimeRefChip } from './TimeRefChip';
import { changeMarks, VersionPlayer } from './VersionPlayer';

interface Side { meta: VersionMeta; state?: VersionState }

interface Props {
  spaceId: string;
  left: Side;
  right: Side;
  clock: Clock;
  h: number;
  scoreOf: (n: number) => (shotIndex: number) => number | undefined;
  onRef: (r: TimeRef, from: { x: number; y: number }) => void;
}

function DiffPill({ left, right, clock }: Pick<Props, 'left' | 'right' | 'clock'>) {
  const marks = changeMarks(right.meta, right.state);
  const shots = right.state?.storyboard.shots ?? [];
  const all = right.meta.changedShots.length >= shots.length && shots.length > 0;
  const a = left.meta.qaScore;
  const b = right.meta.qaScore;
  return (
    <motion.div className="diff" initial={{ opacity: 0, y: 12, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 8, x: '-50%' }} transition={SOFT}>
      <span>同步播放 · {right.meta.changedShots.length === 0 ? '画面没有变化' : all ? '整条重渲' : `只有 ${marks.length} 段不同`}</span>
      {/* 差异胶囊里的 @时间 逐个弹出（Duolingo 对比表的错峰 + 回弹） */}
      {marks.slice(0, 3).map((m, i) => (
        <motion.span key={m.sec} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 18, delay: 0.25 + i * 0.08 }}>
          <TimeRefChip r={{ sec: m.sec + 0.01, label: m.label }} onClick={() => clock.seek(m.sec + 0.01)} />
        </motion.span>
      ))}
      {a !== undefined && b !== undefined && <It l className="diff-it">(自检 {a.toFixed(1)} → {b.toFixed(1)})</It>}
    </motion.div>
  );
}

export function CompareView({ spaceId, left, right, clock, h, scoreOf, onRef }: Props) {
  return (
    <>
      <div className="stagewin pair">
        {[left, right].map((side, i) => (
          <VersionPlayer key={`cmp-${side.meta.n}`} spaceId={spaceId} meta={side.meta} state={side.state} clock={clock} h={h}
            muted={i === 0} scoreOf={scoreOf(side.meta.n)} onRef={onRef} delay={i * 0.08} />
        ))}
      </div>
      <AnimatePresence><DiffPill key="diff" left={left} right={right} clock={clock} /></AnimatePresence>
    </>
  );
}
