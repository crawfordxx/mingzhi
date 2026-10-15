/**
 * 剪辑直播卡（G1：白窗 + 叠放的深色终端）。白窗上半部分是结果：
 * 「原片 → 成片」大数字（成片时长随剪口误滚动缩短）、删掉了什么、分镜卡缩略逐张出现、四维自检分跳出；
 * 下半部分是 LiveTerminal。完成后可「重播剪辑过程」：按 events.jsonl 的时间间隔压缩到 ≤ 20 秒重放。
 */
import { AnimatePresence, motion } from 'motion/react';
import type { WorkEvent } from '../api';
import { fmtDuration, yuan } from '../lib/media';
import { cutCounts, qaAverage, reduceLive, type LiveView } from '../lib/liveModel';
import type { Replay } from '../live';
import { Ico, It, Lights, Num, SOFT, Tap } from '../ui';
import { LiveTranscript } from './LiveTranscript';
import { Strip } from './ShotStrip';

const DIMS: [keyof NonNullable<ReturnType<typeof qaAverage>>, string][] = [['layout', '版式'], ['hierarchy', '层级'], ['motion', '动效节奏'], ['brand', '品牌一致性']];

function Scores({ view }: { view: LiveView }) {
  const avg = qaAverage(view.qa);
  return (
    <div className="scores">
      {DIMS.map(([k, label], i) => {
        const v = avg ? Number(avg[k]) : 0;
        return (
          <div className="sc" key={k}>
            <div className="k">{label}</div>
            <div className="v">{avg ? <Num value={v} format={(x) => x.toFixed(1)} /> : '—'}</div>
            <div className="tr"><motion.i initial={false} animate={{ scaleX: v / 10 }} transition={{ ...SOFT, delay: i * 0.05 }} /></div>
          </div>
        );
      })}
    </div>
  );
}

/** 分镜那一格：失败或取消时不再写「分镜生成中」 */
function shotsText(view: LiveView): string {
  if (view.shots.length) return `分成 ${view.shots.length} 个镜头`;
  if (view.status === 'done') return '没有分镜';
  return view.status === 'failed' ? '没有剪完，分镜未生成' : '分镜生成中';
}

function Summary({ view }: { view: LiveView }) {
  const c = cutCounts(view.cuts);
  return (
    <div className="live-sum">
      删除 <span className="hl"><Num value={c.filler} format={(x) => `${Math.round(x)} 处语气词`} /></span>
      <span className="dot">·</span><span className="hl"><Num value={c.slip} format={(x) => `${Math.round(x)} 处口误`} /></span>
      <span className="dot">·</span>{shotsText(view)}
      {view.cost && <><span className="dot">·</span>花费 <Num className="cost" value={view.cost.total} format={yuan} /></>}
    </div>
  );
}

interface Props {
  events: WorkEvent[];
  title: string;
  backdrop?: string;
  /** 实时进行中（有新事件就有动画） */
  live: boolean;
  replay: Replay;
  onSeek?: (sec: number) => void;
  onCancel?: () => void;
}

export function LiveCard({ events, title, backdrop, live, replay, onSeek, onCancel }: Props) {
  const replaying = replay.shown !== undefined;
  const view = reduceLive(replay.shown ?? events);
  const animate = live || replaying;
  const src = view.sourceSec;
  const out = view.outputSec ?? src;
  const finished = view.status === 'done' && !replaying;
  return (
    <div className="live">
      <div className="win">
        <div className="titlebar"><Lights /><span className="tt">剪辑直播 — {title}</span>
          <span className="r">
            {live && onCancel && <Tap className="btn btn-g sm" onClick={onCancel}>取消</Tap>}
            {!live && <Tap className="btn btn-g sm" onClick={replay.start} disabled={replaying || !events.length}>{Ico.replay}{replaying ? `重播中 ${Math.round(replay.progress * 100)}%` : '重播剪辑过程'}</Tap>}
          </span>
        </div>
        <div className="live-top">
          <div className="big">
            <span>{src !== undefined ? fmtDuration(src) : '—:—'}</span><span className="arr">→</span>
            {out !== undefined ? <Num className={`it out${view.outputSec === undefined ? ' pending' : ''}`} value={out} format={fmtDuration} /> : <It className="out pending">—:—</It>}
          </div>
          <Summary view={view} />
          <Strip shots={view.shots} backdrop={backdrop} animate={animate} onSeek={finished ? onSeek : undefined} />
          <Scores view={view} />
          <LiveTranscript view={view} animate={animate} />
          <AnimatePresence>{view.status === 'failed' && <motion.p className="live-err" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>没剪完：{view.error}</motion.p>}</AnimatePresence>
        </div>
      </div>
    </div>
  );
}
