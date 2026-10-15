/**
 * 播放器底部的细进度条：黑色已播放段 + 圆形滑块 + 本版改动蓝点（changedShots 的起点）。
 * 指针拖动（setPointerCapture）、点击跳转、键盘左右键 ±1 秒；悬停时上方浮出「时间 · 卡片名」。
 */
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { mmss } from '../lib/shots';
import { SPRING } from '../ui';

export interface RailMark { sec: number; label: string }

interface Props {
  /** 读屏用的名字（对比时带上版本号） */
  label?: string;
  t: number;
  duration: number;
  marks?: RailMark[];
  /** 悬停位置的卡片名 */
  nameAt?: (sec: number) => string;
  onSeek: (sec: number) => void;
  onScrub?: (active: boolean) => void;
}

const pctOf = (sec: number, duration: number) => `${duration > 0 ? Math.min(100, Math.max(0, (sec / duration) * 100)) : 0}%`;

export function ProgressRail({ label = '播放进度', t, duration, marks = [], nameAt, onSeek, onScrub }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number>();
  const [drag, setDrag] = useState(false);
  const secAt = (x: number) => {
    const r = ref.current?.getBoundingClientRect();
    return r && duration > 0 ? Math.min(duration, Math.max(0, ((x - r.left) / r.width) * duration)) : 0;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true); onScrub?.(true); onSeek(secAt(e.clientX));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => { const s = secAt(e.clientX); setHover(s); if (drag) onSeek(s); };
  const up = () => { if (drag) { setDrag(false); onScrub?.(false); } };
  const key = (e: KeyboardEvent) => {
    const to = { ArrowLeft: t - 1, ArrowRight: t + 1, Home: 0, End: duration }[e.key];
    if (to !== undefined) { e.preventDefault(); onSeek(to); }
  };
  const tip = drag ? t : hover;
  return (
    <div ref={ref} className={`pbar${drag ? ' drag' : ''}`} role="slider" tabIndex={duration ? 0 : -1} aria-label={label}
      aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(t)} aria-valuetext={mmss(t)}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setHover(undefined)} onKeyDown={key}>
      <span className="pbar-f" style={{ width: pctOf(t, duration) }} />
      {marks.map((m) => <span key={m.sec} className="chg" style={{ left: pctOf(m.sec, duration) }} title={`本版改动 · ${m.label}`} />)}
      <motion.span className="kb" style={{ left: pctOf(t, duration) }} animate={{ scale: drag ? 1.35 : 1 }} transition={SPRING} />
      <AnimatePresence>
        {tip !== undefined && duration > 0 && (
          <motion.span className="ptip" style={{ left: pctOf(tip, duration) }} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }} transition={{ duration: 0.12 }}>
            {mmss(tip)}{nameAt ? <span> · {nameAt(tip)}</span> : null}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
