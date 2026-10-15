/**
 * 版本卡（G1）：成片缩略（悬停静音预览）+「v2 (改了 1 段)」（和父版本逐镜头比较，首版写「首版」）
 * + 耗时 / 花费 / 自检（带相对上一版的升降）+ 预览、导出、回退到此版本。
 */
import { motion } from 'motion/react';
import { useRef } from 'react';
import { mediaUrl, type VersionMeta, type WorkEvent } from '../api';
import { fmtDuration, yuan } from '../lib/media';
import { changedLabel, isFirst } from '../lib/versions';
import { Ico, It, SOFT, Tap } from '../ui';

interface Props {
  spaceId: string;
  /** 缩略停在哪一秒（改动的那张卡已入场的时刻） */
  thumbSec: number;
  meta: VersionMeta;
  parent?: VersionMeta;
  totalShots?: number;
  events: WorkEvent[];
  viewing: boolean;
  latest: boolean;
  exporting: boolean;
  busy: boolean;
  onView: () => void;
  onExport: () => void;
  onRevert: () => void;
}

const tookOf = (events: WorkEvent[]): string => {
  const end = events.find((e) => e.step === 'done');
  return events.length && end ? fmtDuration((end.t - events[0].t) / 1000) : '—';
};

function Thumb({ spaceId, n, at }: { spaceId: string; n: number; at: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const play = () => { const v = ref.current; if (v) { v.currentTime = 0; void v.play().catch(() => undefined); } };
  const stop = () => { const v = ref.current; if (v) { v.pause(); v.currentTime = at; } };
  return (
    <span className="ver-th" style={{ backgroundImage: `url('${mediaUrl(spaceId, n, 'cover-3x4.png')}')` }} onMouseEnter={play} onMouseLeave={stop}>
      <video ref={ref} src={`${mediaUrl(spaceId, n, 'final.mp4')}#t=${at.toFixed(2)}`} muted playsInline preload="metadata" aria-hidden="true" />
    </span>
  );
}

export function VersionCard({ spaceId, thumbSec, meta, parent, totalShots, events, viewing, latest, exporting, busy, onView, onExport, onRevert }: Props) {
  const delta = meta.qaScore !== undefined && parent?.qaScore !== undefined ? meta.qaScore - parent.qaScore : undefined;
  const facts: [string, string][] = [
    [tookOf(events), '耗时'],
    [isFirst(meta) ? yuan(meta.costYuan) : `+${yuan(meta.costYuan)}`, '花费'],
    [meta.qaScore !== undefined ? meta.qaScore.toFixed(1) : '—', delta ? `自检 ${delta > 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(1)}` : '自检'],
  ];
  return (
    <motion.div layout className={`card ver${viewing ? ' viewing' : ''}`} transition={SOFT}>
      <Thumb spaceId={spaceId} n={meta.n} at={thumbSec} />
      <div className="ver-b">
        <div className="vt">v{meta.n}<It l className="ver-it">({changedLabel(meta, totalShots)})</It>
          {viewing && <motion.span layoutId={`now-${spaceId}`} className="now" transition={SOFT}>预览中</motion.span>}
        </div>
        <div className="facts">{facts.map(([b, s]) => <div key={s}><b>{b}</b><span className={s.startsWith('自检 ↑') ? 'up' : s.startsWith('自检 ↓') ? 'down' : ''}>{s}</span></div>)}</div>
        <div className="acts">
          <Tap className="btn btn-g sm" onClick={onView} disabled={viewing}>{viewing ? '正在预览' : '预览'}</Tap>
          <Tap className="btn btn-k sm" onClick={onExport} disabled={exporting}>{exporting ? <span className="spin" /> : Ico.down}导出</Tap>
          {!latest && <Tap className="btn btn-w sm" onClick={onRevert} disabled={busy} title={busy ? '等当前任务完成' : `以 v${meta.n} 为准出一个新版本`}>{Ico.undo}回退到此版本</Tap>}
        </div>
      </div>
    </motion.div>
  );
}

/** 缩略的时刻：只改了几段时取第一处改动，否则取第一张分屏卡；都停在卡片入场之后 */
export function thumbSecOf(meta: VersionMeta, shots?: { start: number; end: number; layout: string }[]): number {
  if (!shots?.length) return 1.2;
  const partial = !isFirst(meta) && meta.changedShots.length > 0 && meta.changedShots.length < shots.length;
  const shot = (partial ? shots[meta.changedShots[0]] : undefined) ?? shots.find((s) => s.layout === 'split') ?? shots[0];
  return shot.start + Math.min(1.4, (shot.end - shot.start) / 2);
}
