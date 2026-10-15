/**
 * 9:16 白色 macOS 浮窗里播放某个版本的成片。
 * 标题栏写「v2 — 00:07 数字卡」；当前镜头是本版改动时左上角亮「本版改动」；
 * 点画面 = 暂停并把「@时间 卡片名」飞进输入框；底部细进度条带本版改动蓝点。
 */
import { AnimatePresence, motion } from 'motion/react';
import type { CSSProperties, MouseEvent } from 'react';
import { mediaUrl, type VersionMeta, type VersionState } from '../api';
import { cardName, mmss, refSecond, shotIndexAt, type TimeRef } from '../lib/shots';
import { useClock, type Clock } from '../usePlayback';
import { Ico, Lights, SOFT, Tap } from '../ui';
import { ProgressRail } from './ProgressRail';

export interface PlayerProps {
  spaceId: string;
  meta: VersionMeta;
  state?: VersionState;
  clock: Clock;
  /** 画面高度（px），宽度按 9:16 */
  h: number;
  muted?: boolean;
  /** 本段自检分（没有时不显示） */
  scoreOf?: (shotIndex: number) => number | undefined;
  /** 重播剪辑过程时锁定画面（不响应点击） */
  locked?: boolean;
  onRef: (r: TimeRef, from: { x: number; y: number }) => void;
  style?: CSSProperties;
  /** 入场延迟（对比时第二个晚一点出来） */
  delay?: number;
}

/** 本版改动的镜头起点（全部重渲时不标点，标了也没有信息量） */
export function changeMarks(meta: VersionMeta, state?: VersionState): { sec: number; label: string }[] {
  const shots = state?.storyboard.shots ?? [];
  if (meta.n === 1 || !shots.length || meta.changedShots.length >= shots.length) return [];
  return meta.changedShots.filter((i) => shots[i]).map((i) => ({ sec: shots[i].start, label: cardName(shots[i]) }));
}

/** 窗内会随播放头变化的部分：单独订阅时钟，外层浮窗（带入场动画）不跟着每帧重渲 */
function PlayerBody({ spaceId, meta, state, clock, h, muted, scoreOf, locked, onRef }: PlayerProps) {
  const s = useClock(clock);
  const ready = s.duration > 0;
  const shots = state?.storyboard.shots ?? [];
  const idx = shotIndexAt(shots, s.t);
  const shot = shots[idx];
  const name = cardName(shot);
  const marks = changeMarks(meta, state);
  const changed = marks.length > 0 && meta.changedShots.includes(idx);
  const score = scoreOf?.(idx);
  const click = (e: MouseEvent) => {
    if (locked || !ready) return;
    clock.pause();
    onRef({ sec: refSecond(clock.getState().t, shot), label: name }, { x: e.clientX, y: e.clientY });
  };
  return (
    <>
      <div className="titlebar"><Lights /><span className="tt">v{meta.n} — {mmss(s.t)} {name}</span></div>
      <div className={`vid real${locked ? ' locked' : ''}`} style={{ height: h }} onClick={click}>
        <video ref={clock.bind(`v${meta.n}`)} src={mediaUrl(spaceId, meta.n, 'final.mp4')} playsInline preload="auto" muted={muted} aria-label={`v${meta.n} 成片`} />
        <AnimatePresence>
          {changed && <motion.span className="hl badge" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={SOFT}>本版改动</motion.span>}
        </AnimatePresence>
        {!locked && ready && <span className="tip">点一下，插入 @{mmss(refSecond(s.t, shot))} {name}</span>}
      </div>
      <div className="pctl">
        <Tap className="pbtn" aria-label={s.playing ? '暂停' : '播放'} onClick={clock.toggle} disabled={!ready || locked}>{s.playing ? Ico.pause : Ico.play}</Tap>
        <span className="ptime"><b>{mmss(s.t)}</b> / {ready ? mmss(s.duration) : '--:--'}</span>
        <ProgressRail label={`v${meta.n} 播放进度`} t={s.t} duration={s.duration} marks={marks} onSeek={clock.seek}
          nameAt={(sec) => cardName(shots[shotIndexAt(shots, sec)])} />
      </div>
      <div className="pmeta">
        <span>{name}{shots.length ? ` · 第 ${idx + 1}/${shots.length} 段` : ''}</span>
        {score !== undefined && <span>本段自检 <b>{score.toFixed(1)}</b></span>}
      </div>
    </>
  );
}

export function VersionPlayer(props: PlayerProps) {
  const { h, style, delay = 0 } = props;
  return (
    <motion.div className="player" style={{ width: Math.round((h * 9) / 16) + 16, ...style }}
      initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ ...SOFT, delay }}>
      <PlayerBody {...props} />
    </motion.div>
  );
}
